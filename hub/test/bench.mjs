#!/usr/bin/env node
// Load test: a synthetic catalogue with 22,000 channels, 30,000 films and 4,000 series
// is put in the cache (no provider needed) and the response times are measured.
//   node hub/test/bench.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORDS = ['Silent', 'Harbor', 'Golden', 'Signal', 'Kingdom', 'Frozen', 'River', 'Midnight', 'Empire', 'Echo', 'Storm', 'Glass', 'Atlas', 'Hidden', 'Code', 'Tide', 'Nordic', 'Sport', 'News', 'Kids'];
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const cats = (n, p) => Array.from({ length: n }, (_, i) => ({ pid: String(i + 1), name: `${p} ${i + 1} | ${pick(WORDS)}` }));
const live = { cats: cats(400, 'C'), items: [] };
for (let i = 0; i < 22000; i++) live.items.push({ sid: String(100000 + i), name: `${pick(['SE', 'UK', 'DE', 'US'])} | ${pick(WORDS)} ${pick(WORDS)} ${i}`, logo: '', num: i + 1, cat: String(1 + (i % 400)), epg: '', archive: false });
const vod = { cats: cats(60, 'V'), items: [] };
for (let i = 0; i < 30000; i++) vod.items.push({ sid: String(300000 + i), title: `${pick(WORDS)} ${pick(WORDS)} ${i}`, year: 1980 + (i % 46), poster: '', rating: 5 + (i % 50) / 10, added: 1700000000 + i * 60, cat: String(1 + (i % 60)), ext: 'mp4', tmdb: '' });
const series = { cats: cats(30, 'S'), items: [] };
for (let i = 0; i < 4000; i++) series.items.push({ sid: String(9000 + i), title: `${pick(WORDS)} ${pick(WORDS)} ${i}`, year: 2000 + (i % 26), poster: '', backdrop: '', rating: 7, added: 1700000000 + i, cat: String(1 + (i % 30)), tmdb: '', plot: '', genre: '' });

const dataDir = mkdtempSync(join(tmpdir(), 'g3hub-bench-'));
mkdirSync(join(dataDir, 'cache'), { recursive: true });
writeFileSync(join(dataDir, 'cache', 'p1.json'), JSON.stringify({ fetchedAt: Date.now(), info: {}, live, vod, series, errors: [] }));
const visible = (n, tag) => Array.from({ length: n }, (_, i) => `p1:${tag}:${i + 1}`);
writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
  rev: 1,
  settings: { refreshHours: 9999 },
  playlists: [{ id: 'p1', name: 'Bench', type: 'xtream', server: 'http://127.0.0.1:9', username: 'x', password: 'y', format: 'm3u8', enabled: true }],
  curation: {
    live: { order: [], visible: visible(20, 'c'), known: visible(400, 'c') },
    vod: { order: [], visible: visible(30, 'v'), known: visible(60, 'v') },
    series: { order: [], visible: visible(15, 's'), known: visible(30, 's') }
  },
  favorites: ['p1:100000', 'p1:100001', 'p1:100002'],
  nextPlaylist: 2
}));

const port = await new Promise((r) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const hub = spawn(process.execPath, [join(ROOT, 'hub', 'server.mjs'), '--port', String(port), '--data', dataDir], { stdio: ['ignore', 'pipe', 'inherit'] });
let log = '';
hub.stdout.on('data', (c) => { log += c; });
const H = `http://localhost:${port}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(H + '/api/health')).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

async function med(path, n = 9) {
  const t = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await fetch(H + path, { headers: { 'Accept-Encoding': 'gzip' } });
    await r.arrayBuffer();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return t[Math.floor(n / 2)];
}

console.log((log.match(/catalogue.*|index.*/g) || []).join('\n'));
const rows = [
  ['bootstrap', '/api/tv/bootstrap'],
  ['channels (55)', '/api/live/channels?category=p1:c:1'],
  ['movies recent', '/api/vod/list?category=recent&limit=60'],
  ['movies category', '/api/vod/list?category=p1:v:1&limit=60'],
  ['movies sort=name', '/api/vod/list?category=p1:v:2&sort=name&limit=60'],
  ['search "storm"', '/api/search?q=storm'],
  ['search "s" (all)', '/api/search?q=s&all=1'],
  ['search "golden harbor"', '/api/search?q=golden%20harbor&all=1'],
  ['admin categories', '/api/admin/categories?kind=live'],
  ['admin channel search', '/api/admin/channels?q=nordic']
];
for (const [name, path] of rows) console.log(`${name.padEnd(22)} ${(await med(path)).toFixed(1).padStart(6)} ms`);
const { execFileSync } = await import('node:child_process');
console.log(`memory (RSS): ${Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(hub.pid)]).toString().trim()) / 1024)} MB`);
hub.kill('SIGTERM');
rmSync(dataDir, { recursive: true, force: true });
