import { Readable } from 'node:stream';
// Small helpers shared by every module.
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { localeOf, LocalError, msg } from './i18n.mjs';

export const VERSION = '1.3.0';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(t, ...args);
}

export function warn(...args) {
  const t = new Date().toISOString().slice(11, 19);
  console.warn(t, '⚠', ...args);
}

// Write a file atomically (tmp + rename) so that a power cut never leaves half-written JSON.
let tmpSeq = 0;
export async function writeAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  // A unique name even when two saves happen in the same millisecond.
  const tmp = `${file}.${process.pid}.${Date.now()}.${++tmpSeq}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

// Half-written files from a process that was killed in the middle of a save.
export async function removeStaleTmp(dir) {
  let n = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.tmp')) continue;
      await rm(join(dir, name), { force: true });
      n++;
    }
  } catch { /* the directory does not exist */ }
  return n;
}

// Text for searching: lower case, without diacritics (å→a, ö→o), only letters/digits.
export function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Remove provider prefixes such as "SE | ", "|EN| ", "[UK] ", "EN - " at the start of a name.
export function stripPrefix(name) {
  return String(name || '')
    .replace(/^\s*(\|[^|]{1,12}\|\s*|\[[^\]]{1,12}\]\s*|[A-Z0-9+&/.\-]{1,12}\s*\|\s+|[A-Z]{2,3}\s+-\s+)/, '')
    .trim();
}

// Title and year from e.g. "EN - The Movie (2023)".
export function splitTitle(raw, yearHint) {
  let title = stripPrefix(raw);
  let year = Number(yearHint) || null;
  const m = /\s*[([](\d{4})[)\]]\s*$/.exec(title);
  if (m) {
    if (!year) year = Number(m[1]);
    title = title.slice(0, m.index).trim();
  }
  return { title: title || String(raw || '').trim(), year: year && year > 1900 && year < 2100 ? year : null };
}

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Rating on a 0–10 scale.
export function rating(r, r5) {
  let n = num(r);
  if ((n == null || n === 0) && num(r5)) n = num(r5) * 2;
  if (n == null || n <= 0) return null;
  if (n > 10) n = n / 10;
  return Math.round(n * 10) / 10;
}

// Limit how many asynchronous jobs run at the same time.
export function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

// Simple LRU cache with a lifetime.
export class TTLCache {
  constructor(max = 500, ttl = 600000) {
    this.max = max;
    this.ttl = ttl;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key, value, ttl) {
    this.map.delete(key);
    this.map.set(key, { value, exp: Date.now() + (ttl || this.ttl) });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() {
    this.map.clear();
  }
}

// --- Be kind to the providers ----------------------------------------------------------------
// Xtream panels (XUI and others) block an IP address that sends too many calls ("flood") and
// then answer 403 to everything. Hence: a limited rate per host, and a pause when a host objects.
const PROVIDER_RULE = { interval: 400, concurrency: 2 }; // ≈ 2.5 calls/s to the provider's API
const DEFAULT_RULE = { interval: 60, concurrency: 6 };
const BLOCK_CODES = new Set([403, 429, 503, 509, 513]);
// Images on the provider's own host: 403 often just means a missing/protected logo. So three within two
// minutes pause only *images* from the host for a while – never the API (catalogue, EPG, info).
// (429/503/… on an image means the host is throttling us: then everything is paused.)
const IMAGE_403_STRIKES = 3;
const IMAGE_403_WINDOW = 2 * 60e3;
const IMAGE_PAUSE = 15 * 60e3;
const gates = new Map();

function gateFor(host) {
  let g = gates.get(host);
  if (!g) {
    g = { host, rule: DEFAULT_RULE, provider: false, active: 0, last: 0, high: [], queue: [], timer: null, pausedUntil: 0, imgPausedUntil: 0, strikes: 0, lastCode: 0, denied: [] };
    gates.set(host, g);
  }
  return g;
}

function markProvider(g) {
  g.provider = true;
  g.rule = PROVIDER_RULE; // logos on the same host also follow the stricter rate
}

// Hosts that belong to a provider (the playlist's server, M3U and EPG address) – marked straight away at
// start-up, so that images from there also follow the stricter rate and respect pauses before
// the hub has made its first API call after a restart.
export function setProviderHosts(urls) {
  for (const u of urls) {
    if (!u) continue;
    try { markProvider(gateFor(new URL(u).host)); } catch { /* invalid address */ }
  }
}

// The provider's own API calls (high) go before queued images.
function pump(g) {
  while (g.active < g.rule.concurrency && (g.high.length || g.queue.length)) {
    const wait = g.last + g.rule.interval - Date.now();
    if (wait > 0) {
      if (!g.timer) g.timer = setTimeout(() => { g.timer = null; pump(g); }, wait);
      return;
    }
    const job = g.high.length ? g.high.shift() : g.queue.shift();
    g.active++;
    g.last = Date.now();
    job().finally(() => { g.active--; pump(g); });
  }
}

const throughGate = (g, fn, high) => new Promise((resolve, reject) => {
  (high ? g.high : g.queue).push(() => Promise.resolve().then(fn).then(resolve, reject));
  pump(g);
});

const hhmm = (t) => new Date(t).toLocaleTimeString(localeOf(), { hour: '2-digit', minute: '2-digit' });

// State per host for the admin (paused providers).
export function gateStatus() {
  const now = Date.now();
  return [...gates.values()]
    .filter((g) => g.pausedUntil > now)
    .map((g) => ({ host: g.host, until: g.pausedUntil, code: g.lastCode, strikes: g.strikes }));
}

// Pauses survive a restart (see Catalog/server): read and set.
export function gatePauses() {
  const now = Date.now();
  const out = {};
  for (const g of gates.values()) if (g.pausedUntil > now) out[g.host] = { until: g.pausedUntil, code: g.lastCode, strikes: g.strikes };
  return out;
}

export function restoreGatePauses(saved) {
  const now = Date.now();
  for (const [host, v] of Object.entries(saved || {})) {
    if (!v || !(v.until > now)) continue;
    const g = gateFor(host);
    g.pausedUntil = v.until;
    g.lastCode = v.code || 0;
    g.strikes = v.strikes || 1;
  }
}

const pauseListeners = new Set();
export const onGatePause = (fn) => pauseListeners.add(fn);

function startPause(g, host, code) {
  g.strikes++;
  g.lastCode = code;
  const pause = Math.min(15 * 60e3 * 2 ** (g.strikes - 1), 2 * 3600e3);
  g.pausedUntil = Date.now() + pause;
  warn(`${host} answered ${code} – pausing requests to it until ${hhmm(g.pausedUntil)}`);
  for (const fn of pauseListeners) { try { fn(host, g.pausedUntil); } catch { /* ignore */ } }
}

// Fetch with a timeout. Throws on network errors and non-2xx.
//   opts.provider = true  for the provider's API (player_api.php, xmltv.php, get.php):
//                         stricter rate, and a pause of 15 min → 2 h when it answers 403/429/…
//   Everything else to a provider host (e.g. logos) follows the same rate and pauses.
export async function fetchWithTimeout(url, opts = {}) {
  const { timeout = 30000, headers = {}, provider = false, ...rest } = opts;
  const host = new URL(url).host;
  const g = gateFor(host);
  if (provider) markProvider(g);
  const strict = g.provider;
  const now0 = Date.now();
  if (strict && (g.pausedUntil > now0 || (!provider && g.imgPausedUntil > now0))) {
    const until = g.pausedUntil > now0 ? g.pausedUntil : g.imgPausedUntil;
    const err = new LocalError('errors.providerPaused', { host, code: g.lastCode || 403, time: hhmm(until) });
    err.status = g.lastCode || 403;
    err.paused = true;
    err.until = until;
    throw err;
  }
  const res = await throughGate(g, () => fetch(url, {
    redirect: 'follow',
    ...rest,
    headers: { 'User-Agent': opts.userAgent || 'IPTVSmartersPro', Accept: '*/*', ...headers },
    signal: AbortSignal.timeout(timeout)
  }), provider);
  if (!res.ok) {
    // (Calls that were already on their way when the pause began are not counted again.)
    if (strict && BLOCK_CODES.has(res.status) && g.pausedUntil <= Date.now()) {
      if (provider || res.status !== 403) startPause(g, host, res.status);
      else {
        const now = Date.now();
        g.denied = g.denied.filter((t) => now - t < IMAGE_403_WINDOW);
        g.denied.push(now);
        if (g.denied.length >= IMAGE_403_STRIKES) {
          g.denied = [];
          g.imgPausedUntil = Date.now() + IMAGE_PAUSE;
          warn(`${host}: several images refused (403) – pausing only images from there until ${hhmm(g.imgPausedUntil)}`);
        }
      }
    }
    try { res.body && res.body.cancel(); } catch { /* nothing */ }
    const err = new LocalError('errors.http', { status: res.status, host });
    err.status = res.status;
    throw err;
  }
  if (provider) g.strikes = 0;
  return res;
}

// Large lists (films can be 100+ MB of JSON): read as a stream and parse one element at a time,
// so that the whole response never sits in memory as a single string. Handles both [ {...}, ... ]
// and { "1": {...}, ... } (some panels answer with an object). map(element) → what is kept (or null).
export async function fetchJsonList(url, opts, map) {
  const res = await fetchWithTimeout(url, opts);
  const dec = new TextDecoder('utf-8');
  const out = [];
  let buf = '';
  let i = 0;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  let sawRoot = false;
  let head = '';
  const feed = (text) => {
    if (!text) return;
    if (head.length < 80) head += text.slice(0, 80);
    buf += text;
    for (; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === 92) esc = true;        // \
        else if (c === 34) inStr = false;     // "
        continue;
      }
      if (c === 34) { inStr = true; continue; }
      if (c === 123 || c === 91) {            // { [
        if (depth === 0) sawRoot = true;
        else if (depth === 1) start = i;
        depth++;
      } else if (c === 125 || c === 93) {     // } ]
        depth--;
        if (depth === 1 && start >= 0) {
          let v = null;
          try { v = JSON.parse(buf.slice(start, i + 1)); } catch { v = null; }
          const m = v && map(v);
          if (m) out.push(m);
          start = -1;
        }
      }
    }
    const keep = start >= 0 ? start : i;
    if (keep > 0) {
      buf = buf.slice(keep);
      i -= keep;
      if (start >= 0) start = 0;
    }
  };
  for await (const chunk of Readable.fromWeb(res.body)) feed(dec.decode(chunk, { stream: true }));
  feed(dec.decode());
  if (!sawRoot) throw new LocalError('errors.notJson', { snippet: head.replace(/\s+/g, ' ').slice(0, 60) || msg('errors.empty') });
  return out;
}

export async function fetchJson(url, opts) {
  const res = await fetchWithTimeout(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 80).replace(/\s+/g, ' ');
    throw new LocalError('errors.notJson', { snippet: snippet || msg('errors.empty') });
  }
}

// Read CLI flags:  --port 8787 --data ./x --seed-demo URL
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function moveItem(list, id, delta) {
  const i = list.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return false;
  list.splice(j, 0, list.splice(i, 1)[0]);
  return true;
}
