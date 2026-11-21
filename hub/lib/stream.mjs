// Stream proxy for films and episodes, with subtitles read out of the same byte stream.
//
//   GET/HEAD /api/stream?u=<provider's address>      the TV plays from here instead of directly
//   GET      /api/subs?u=<same address>&track=N&after=K → { known, tracks, cues, next }
//
// Each request from the TV becomes exactly one request to the provider (same Range), and is aborted when
// the TV disconnects – so the provider never sees more connections than with direct playback (the account
// often allows only one, and the older one is dropped if a new one is opened). Bytes are passed on untouched;
// alongside, a parser reads the text tracks out of them (mkvsubs.mjs). The text for a line is therefore at
// the hub as soon as the TV has fetched that part of the file, i.e. before it is shown.
//
// If the TV starts in the middle of the file before the hub has seen the file's start (e.g. after a restart of the hub),
// the first megabytes are fetched separately first – one request at a time, never two at once.
import http from 'node:http';
import https from 'node:https';
import { CORS, HttpError } from './http.mjs';
import { LocalError } from './i18n.mjs';
import { MkvFile, MkvSubParser } from './mkvsubs.mjs';
import { log, warn } from './util.mjs';

const MAX_FILES = 8;               // files whose subtitles are kept in memory
const FILE_TTL = 8 * 3600e3;
const RESOLVE_TTL = 5 * 60e3;      // how long a redirect (to the provider's file server) is valid
const HEADER_BYTES = 8 * 1024 * 1024;
const IDLE_MS = 45000;

export class Streams {
  // allowedHosts(): Set of the playlists' hosts · userAgentFor(host): the playlist's User-Agent
  constructor({ allowedHosts, userAgentFor }) {
    this.allowedHosts = allowedHosts;
    this.userAgentFor = userAgentFor || (() => '');
    this.files = new Map();        // address -> MkvFile
    this.resolved = new Map();     // address -> { url, at }
    this.active = 0;
  }

  check(u) {
    let url;
    try { url = new URL(u); } catch { throw new HttpError(400, 'errors.badAddress'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'errors.httpOnly');
    if (!this.allowedHosts().has(url.host)) throw new HttpError(403, 'errors.notPlaylistAddress');
    return url;
  }

  file(u) {
    let f = this.files.get(u);
    if (f) {
      this.files.delete(u); // last = most recently used
    } else {
      f = new MkvFile();
      const now = Date.now();
      for (const [k, v] of this.files) if (this.files.size >= MAX_FILES || now - v.touched > FILE_TTL) this.files.delete(k);
    }
    f.touched = Date.now();
    this.files.set(u, f);
    return f;
  }

  // One request to the provider. Follows redirects (and remembers the target for a while, so that the panel
  // behind Cloudflare does not get a request per seek).
  open(u, headers, { method = 'GET', redirects = 5, useCache = true } = {}) {
    const hit = useCache ? this.resolved.get(u) : null;
    const target = hit && Date.now() - hit.at < RESOLVE_TTL ? hit.url : u;
    return new Promise((resolve, reject) => {
      const go = (addr, left) => {
        let url;
        try { url = new URL(addr); } catch { reject(new LocalError('errors.badRedirect')); return; }
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(url, { method, headers, agent: false }, (res) => {
          const code = res.statusCode;
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            if (left <= 0) { reject(new LocalError('errors.tooManyRedirects')); return; }
            let next;
            try { next = new URL(res.headers.location, url).toString(); } catch { reject(new LocalError('errors.badRedirect')); return; }
            go(next, left - 1);
            return;
          }
          if (code < 400 && addr !== u) this.resolved.set(u, { url: addr, at: Date.now() });
          if (code >= 400) this.resolved.delete(u);
          resolve({ res, req, final: addr });
        });
        req.setTimeout(IDLE_MS, () => req.destroy(new LocalError('errors.providerSilent')));
        req.on('error', reject);
        req.end();
      };
      go(target, redirects);
    }).then((r) => {
      // The saved target has expired (e.g. a time-limited link): ask the provider again.
      if (r.res.statusCode >= 400 && target !== u) {
        r.res.resume();
        return this.open(u, headers, { method, redirects, useCache: false });
      }
      return r;
    });
  }

  upstreamHeaders(url, range) {
    const h = { 'User-Agent': this.userAgentFor(url.host) || 'IPTVSmartersPro', Accept: '*/*', Connection: 'close' };
    if (range) h.Range = range;
    return h;
  }

  // The start of the file (the track descriptions), when the TV starts further in and the hub has not seen it yet.
  async ensureHeader(u, url, file) {
    if (file.header || file.headerTried) return;
    file.headerTried = true;
    try {
      const { res, req } = await this.open(u, this.upstreamHeaders(url, `bytes=0-${HEADER_BYTES - 1}`));
      if (res.statusCode >= 400) { res.resume(); return; }
      const parser = new MkvSubParser(file, 0, { headerOnly: true });
      await new Promise((resolve) => {
        const stop = () => { req.destroy(); resolve(); };
        res.on('data', (c) => { parser.push(c); if (parser.done || file.header) stop(); });
        res.on('end', resolve);
        res.on('error', resolve);
        res.on('close', resolve);
      });
    } catch (e) {
      warn('subtitles: could not read the start of the file:', e.message);
    }
  }

  async handle(req, res, u) {
    const url = this.check(u);
    const isMkv = /\.mkv$/i.test(url.pathname);
    const file = isMkv ? this.file(u) : null;
    const range = req.headers.range || '';
    const start = Number((/^bytes=(\d+)-/.exec(range) || [])[1]) || 0;

    if (req.method === 'HEAD') {
      // The provider's file server does not answer HEAD sensibly: ask for one byte and read the total.
      const { res: up } = await this.open(u, this.upstreamHeaders(url, 'bytes=0-0'));
      up.resume();
      const total = Number((/\/(\d+)$/.exec(up.headers['content-range'] || '') || [])[1]) || 0;
      const h = { ...CORS, 'Accept-Ranges': 'bytes', 'Content-Type': contentType(up, url), 'Cache-Control': 'no-store' };
      if (total) h['Content-Length'] = total;
      res.writeHead(up.statusCode >= 400 ? up.statusCode : 200, h).end();
      return;
    }

    if (file && start > 0) await this.ensureHeader(u, url, file);
    if (res.destroyed || req.destroyed) return;

    const { res: up, req: upReq } = await this.open(u, this.upstreamHeaders(url, range));
    const headers = { ...CORS, 'Accept-Ranges': 'bytes', 'Content-Type': contentType(up, url), 'Cache-Control': 'no-store' };
    for (const k of ['content-length', 'content-range', 'last-modified', 'etag']) if (up.headers[k]) headers[k] = up.headers[k];
    res.writeHead(up.statusCode, headers);
    if (up.statusCode >= 400) {
      up.pipe(res);
      return;
    }

    // Where in the file the response starts (Content-Range wins over what the TV asked for).
    const from = Number((/^bytes (\d+)-/.exec(up.headers['content-range'] || '') || [])[1]) || (up.statusCode === 206 ? start : 0);
    const parser = file ? new MkvSubParser(file, from) : null;
    this.active++;
    let bytes = 0;
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      this.active--;
      upReq.destroy();
      up.destroy();
    };
    up.on('data', (c) => {
      bytes += c.length;
      if (parser) parser.push(c);
      if (!res.write(c)) {
        up.pause();
        res.once('drain', () => up.resume());
      }
    });
    up.on('end', () => { res.end(); done(); });
    up.on('error', () => { res.destroy(); done(); });
    res.on('close', done); // the TV disconnected (seek, stop): disconnect from the provider at once
    res.on('error', done);
    if (file) file.touched = Date.now();
    log(`stream ${url.host}${from ? ' from ' + Math.round(from / 1048576) + ' MB' : ''}${file ? ' (reading subtitles)' : ''}`);
  }

  // Subtitles the hub has managed to read out. after = number of lines the TV already has for the track.
  subs(u, track, after) {
    this.check(u);
    const f = this.files.get(u);
    if (!f) return { known: false, tracks: [], cues: [], next: 0 };
    f.touched = Date.now();
    const list = Number.isInteger(track) && track >= 0 ? f.cuesOf(track) : [];
    const from = Math.max(0, Math.min(Number(after) || 0, list.length));
    return { known: f.header, tracks: f.publicTracks(), cues: list.slice(from, from + 2000), next: Math.min(list.length, from + 2000) };
  }

  status() {
    return { active: this.active, files: this.files.size };
  }
}

function contentType(up, url) {
  const t = String(up.headers['content-type'] || '');
  if (t && !/octet-stream|text\/html/i.test(t)) return t;
  if (/\.mkv$/i.test(url.pathname)) return 'video/x-matroska';
  if (/\.mp4$|\.m4v$/i.test(url.pathname)) return 'video/mp4';
  if (/\.avi$/i.test(url.pathname)) return 'video/x-msvideo';
  return t || 'application/octet-stream';
}
