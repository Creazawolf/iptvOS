// Image proxy with a disk cache:  GET /api/img?u=<address>&w=<width>
// The providers' image servers are often slow – here each image is fetched once and then served
// quickly from the hub. If the `sharp` package is installed, images are scaled down to the right width.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { langOf, LocalError, msgOf, tr } from './i18n.mjs';
import { fetchWithTimeout, limiter, log, warn, writeAtomic } from './util.mjs';

const MAX_BYTES = 15 * 1024 * 1024;
const CACHE_LIMIT = 800 * 1024 * 1024;
const FETCH_TIMEOUT = 8000;          // a slow image server must not hold up the TV's connections
const FAIL_MS = 30 * 60e3;           // failed addresses rest this long

const keyOf = (u, width) => createHash('sha1').update(u + '|' + width).digest('hex');

let sharp = null;
let sharpTried = false;
async function getSharp() {
  if (sharpTried) return sharp;
  sharpTried = true;
  try {
    sharp = (await import('sharp')).default;
    log('sharp found – images are scaled down in the hub');
  } catch {
    sharp = null;
  }
  return sharp;
}

export const hasSharp = () => !!sharp;

export class Images {
  // trustedHosts(): hosts (host:port) that may be local, e.g. a playlist on the home network.
  constructor(dataDir, trustedHosts = () => new Set()) {
    this.dir = join(dataDir, 'img');
    this.trustedHosts = trustedHosts;
    this.failed = new Map(); // address -> { until, reason }
    this.resizeSlot = limiter(2); // at most two resizes at a time (one core)
    this.inflight = new Map();
    getSharp();
    this.pruneTimer = setInterval(() => this.prune(), 6 * 3600e3);
    this.pruneTimer.unref();
    setTimeout(() => this.prune(), 30000).unref();
  }

  async handle(req, res, rawUrl, rawWidth) {
    let u = String(rawUrl || '');
    // Already a hub address (double rewrite)? Unwrap it.
    for (let i = 0; i < 3 && /\/api\/img\?/.test(u); i++) {
      try {
        const inner = new URL(u);
        if (!rawWidth) rawWidth = inner.searchParams.get('w');
        u = inner.searchParams.get('u') || '';
      } catch {
        break;
      }
    }
    if (!/^https?:\/\//i.test(u) || (isPrivateHost(u) && !this.trustedHosts().has(new URL(u).host))) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(tr('errors.imgPublicOnly', null, langOf(req)));
      return;
    }
    const w = Math.min(1920, Math.max(0, Math.round(Number(rawWidth) || 0)));
    const width = w >= 32 && (await getSharp()) ? w : 0;

    // Addresses that just failed are not asked again for a while (broken logos are redrawn
    // often on the TV – otherwise each attempt would hold a connection for up to the timeout).
    const failed = this.failed.get(u);
    if (failed && failed.until > Date.now()) return this.fail(req, res, failed.reason, (failed.until - Date.now()) / 1000);

    try {
      const hit = await this.cached(u, width);
      if (hit) return this.send(req, res, hit.file, hit.type, hit.size, hit.key);
      const key = keyOf(u, width);
      let job = this.inflight.get(key);
      if (!job) {
        job = (width ? this.makeSize(u, width) : this.original(u)).finally(() => this.inflight.delete(key));
        this.inflight.set(key, job);
      }
      const r = await job;
      return this.send(req, res, r.file, r.type, r.size, r.key);
    } catch (e) {
      // Provider paused: the image is not broken – ask again when the pause is over.
      if (e.paused) return this.fail(req, res, msgOf(e), Math.max(60, Math.round(((e.until || 0) - Date.now()) / 1000)));
      this.failed.set(u, { until: Date.now() + FAIL_MS, reason: msgOf(e) });
      if (this.failed.size > 5000) this.failed.delete(this.failed.keys().next().value);
      return this.fail(req, res, msgOf(e));
    }
  }

  fail(req, res, reason, maxAge = FAIL_MS / 1000) {
    // Cache the error so that the TV does not ask again all the time.
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'max-age=' + Math.round(maxAge), 'Access-Control-Allow-Origin': '*' }).end(tr('errors.imgFailed', { reason }, langOf(req)));
  }

  paths(u, width) {
    const key = keyOf(u, width);
    const file = join(this.dir, key.slice(0, 2), key);
    return { key, file, metaFile: file + '.json' };
  }

  async cached(u, width) {
    const { key, file, metaFile } = this.paths(u, width);
    try {
      const meta = JSON.parse(await readFile(metaFile, 'utf8'));
      const st = await stat(file);
      return { file, type: meta.type, size: st.size, key };
    } catch {
      return null;
    }
  }

  // The original is fetched once (width 0) – every size is then made from it, locally.
  // Simultaneous requests (e.g. two sizes of the same poster) share the fetch.
  original(u) {
    const k = 'orig|' + u;
    let job = this.inflight.get(k);
    if (!job) {
      job = this.fetchOriginal(u).finally(() => this.inflight.delete(k));
      this.inflight.set(k, job);
    }
    return job;
  }

  async fetchOriginal(u) {
    const hit = await this.cached(u, 0);
    if (hit) return hit;
    const { key, file, metaFile } = this.paths(u, 0);
    const r = await fetchWithTimeout(u, { timeout: FETCH_TIMEOUT, userAgent: 'Mozilla/5.0 (G3Hub)' });
    let type = (r.headers.get('content-type') || '').split(';')[0].trim();
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new LocalError('errors.imgTooLarge');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new LocalError('errors.imgTooLarge');
    if (!type.startsWith('image/') || type === 'image/svg+xml') type = sniff(buf);
    if (!type) throw new LocalError('errors.notImage');
    await writeAtomic(file, buf);
    await writeAtomic(metaFile, JSON.stringify({ type, u, at: Date.now() }));
    return { file, type, size: buf.length, key, buf };
  }

  async makeSize(u, width) {
    const orig = await this.original(u);
    const s = sharp;
    // SVG/GIF (and without sharp): the original as it is.
    if (!s || orig.type === 'image/svg+xml' || orig.type === 'image/gif') return orig;
    const { key, file, metaFile } = this.paths(u, width);
    const input = orig.buf || (await readFile(orig.file));
    let buf;
    let type = orig.type;
    try {
      buf = await this.resizeSlot(async () => {
        const img = s(input, { failOn: 'none' }).rotate().resize({ width, withoutEnlargement: true });
        if (type === 'image/png') return img.png({ compressionLevel: 6 }).toBuffer();
        type = 'image/jpeg';
        // Plain libjpeg-turbo: much faster than mozjpeg on one core, almost the same size.
        return img.jpeg({ quality: 80 }).toBuffer();
      });
    } catch (e) {
      warn('sharp could not scale an image', e.message);
      return orig;
    }
    await writeAtomic(file, buf);
    await writeAtomic(metaFile, JSON.stringify({ type, u, w: width, at: Date.now() }));
    return { file, type, size: buf.length, key };
  }

  send(req, res, file, type, size, etag) {
    const tag = `"${etag.slice(0, 16)}"`;
    const headers = {
      'Content-Type': type || 'application/octet-stream',
      'Cache-Control': 'public, max-age=604800',
      ETag: tag,
      'Access-Control-Allow-Origin': '*'
    };
    if (req.headers['if-none-match'] === tag) {
      res.writeHead(304, headers).end();
      return;
    }
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
    // Mark as recently used (for pruning).
    const now = new Date();
    utimes(file, now, now).catch(() => {});
  }

  // Keep the cache under the limit: remove the least recently used files.
  async prune() {
    try {
      await mkdir(this.dir, { recursive: true });
      const files = [];
      let total = 0;
      for (const sub of await readdir(this.dir)) {
        const d = join(this.dir, sub);
        let names;
        try {
          names = await readdir(d);
        } catch {
          continue;
        }
        for (const n of names) {
          if (n.endsWith('.json')) continue;
          const f = join(d, n);
          if (n.endsWith('.tmp')) {
            // Leftover half-written file (older than an hour): remove it.
            try { if (Date.now() - (await stat(f)).mtimeMs > 3600e3) await rm(f, { force: true }); } catch {}
            continue;
          }
          try {
            const st = await stat(f);
            files.push({ f, size: st.size, t: st.mtimeMs });
            total += st.size;
          } catch {}
        }
      }
      if (total <= CACHE_LIMIT) return;
      files.sort((a, b) => a.t - b.t);
      let removed = 0;
      for (const x of files) {
        if (total <= CACHE_LIMIT * 0.8) break;
        await rm(x.f, { force: true });
        await rm(x.f + '.json', { force: true });
        total -= x.size;
        removed++;
      }
      log(`image cache pruned: ${removed} files`);
    } catch (e) {
      warn('image cache', e.message);
    }
  }
}

function sniff(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  // SVG: require the <svg> tag itself (plain XML, e.g. an error page, is not an image).
  const head = b.slice(0, 1024).toString('utf8');
  if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return '';
}

// The image proxy is open (images are loaded without headers) – do not let it become a way into the home network.
// Providers' images live at public addresses.
export function isPrivateHost(u) {
  let host;
  try { host = new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return true; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '0.0.0.0') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || /^f[cd]/.test(host) || /^fe80/.test(host) || host.startsWith('::ffff:');
  return false;
}
