#!/usr/bin/env node
// Preview an app in the browser:  npm run dev [-- app] [-- --port 8080] [-- --no-hub] [-- --build]
//   --build   try the package that gets installed on the TV (build/<app>: bundled scripts, lazy loading)
//   --demo-wallpapers   wallpapers and aerial videos from mock data instead of the real sources
//   Also starts the IPTV hub (hub/server.mjs) on port+707 with the demo provider, and
//   puts window.__DEV_HUB in index.html so that the launcher finds it.
//   /lib/*            served from shared/
//   /__proxy?url=…    fetches external URLs (as the service does on the TV – no CORS problems)
//   /__mock/…         mock data, see scripts/dev-mocks.mjs
//   /__xtream/…       demo provider with real Xtream paths (~22,000 channels, movies, series)
//   /__fixtures/…     files fetched from the TV (app list, icons) in build/dev-fixtures/root
// Everything else is served from apps/<app>/.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { appDir, BUILD, ROOT, SHARED, stage } from './lib.mjs';

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 8080;
const name = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port') || 'launcher';
const built = args.includes('--build');
if (built) {
  const r = await stage(name, { dev: true });
  if (r.sizes) for (const [f, s] of Object.entries(r.sizes)) console.log(`  bundle: ${f} ${s.files} files → ${(s.after / 1024).toFixed(0)} kB`);
}
const root = built ? join(BUILD, name) : appDir(name);
const withHub = !args.includes('--no-hub');
const hubPort = port + 707;

const mocksFile = join(ROOT, 'scripts', 'dev-mocks.mjs');
const mocks = existsSync(mocksFile) ? await import(mocksFile) : null;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4'
};

function resolvePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^([/\\])+/, '');
  const [base, rel] = !built && (clean.startsWith('lib' + sep) || clean.startsWith('lib/'))
    ? [SHARED, clean.slice(4)]
    : [root, clean || 'index.html'];
  const full = join(base, rel);
  return full.startsWith(base) ? full : null; // no ../ escapes
}

function pickFields(body, fields) {
  try {
    const data = JSON.parse(body);
    if (!Array.isArray(data)) return body;
    return JSON.stringify(data.map((it) => {
      if (!it || typeof it !== 'object') return it;
      const o = {};
      for (const f of fields) if (it[f] !== undefined) o[f] = it[f];
      return o;
    }));
  } catch {
    return body;
  }
}

async function proxy(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//.test(target)) {
    res.writeHead(400).end('url missing');
    return;
  }
  // Mocked URLs (e.g. the demo IPTV) are answered locally.
  if (mocks && mocks.handleProxy) {
    const handled = await mocks.handleProxy(target, res);
    if (handled) return;
  }
  try {
    const r = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Web0S; Linux) G3Custom/1.0' },
      signal: AbortSignal.timeout(20000)
    });
    let body = await r.text();
    const pick = url.searchParams.get('pick');
    if (pick) body = pickFields(body, pick.split(','));
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Proxy error: ' + e.message);
  }
}

// --- The IPTV hub as a child process -----------------------------------------------

let hub = null;

function startHub() {
  const server = join(ROOT, 'hub', 'server.mjs');
  if (!withHub || !existsSync(server)) return;
  const dataDir = join(ROOT, 'build', `hub-data-${port}`);
  // --demo-wallpapers: wallpapers and aerial videos from mock data (the tests should not need the internet).
  hub = spawn(process.execPath, [server, '--port', String(hubPort), '--data', dataDir,
    '--seed-demo', `http://localhost:${port}/__xtream`].concat(args.includes('--demo-wallpapers') ? ['--demo-wallpapers', `http://localhost:${port}`] : []),
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (chunk) => chunk.toString().split('\n').filter(Boolean).map((l) => '  [hub] ' + l).join('\n') + '\n';
  hub.stdout.on('data', (c) => process.stdout.write(prefix(c)));
  hub.stderr.on('data', (c) => process.stderr.write(prefix(c)));
  hub.on('exit', (code) => {
    if (code) console.warn(`  [hub] exited (code ${code})`);
    hub = null;
  });
}

function stopHub() {
  if (hub) {
    try { hub.kill('SIGTERM'); } catch {}
    hub = null;
  }
}

process.on('exit', stopHub);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopHub();
    process.exit(0);
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/__proxy') return proxy(req, res, url);
  if (url.pathname.startsWith('/__xtream/') && mocks && mocks.handleXtream) {
    if (await mocks.handleXtream(req, res, url)) return;
  }
  if (url.pathname.startsWith('/__mock/') && mocks && mocks.handle) {
    if (await mocks.handle(req, res, url)) return;
  }

  // Real icon files and the app list from the TV (fetched into build/dev-fixtures/root).
  if (url.pathname.startsWith('/__fixtures/')) {
    const base = join(ROOT, 'build', 'dev-fixtures', 'root');
    const full = normalize(join(base, decodeURIComponent(url.pathname.slice('/__fixtures'.length))));
    if (full.startsWith(base) && existsSync(full)) {
      res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(full));
    } else {
      res.writeHead(404).end();
    }
    return;
  }

  let file = resolvePath(req.url);
  try {
    if (!file) throw new Error('forbidden');
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    let body = await readFile(file);
    // Tell the launcher where the dev hub is (only in the browser, never in the package).
    if (hub && file === join(root, 'index.html')) {
      body = body.toString('utf8').replace('<script', `<script>window.__DEV_HUB="http://localhost:${hubPort}"</script>\n  <script`);
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found: ' + req.url);
  }
}).listen(port, () => {
  console.log(`\n  ${name} running at http://localhost:${port}\n`);
  startHub();
  if (hub) console.log(`  IPTV hub: http://localhost:${hubPort}  (web admin + API, demo data)\n`);
  console.log('  Arrow keys = navigate · Enter = OK (hold = menu) · Esc = Back');
  console.log('  R/G/Y/B = colour buttons · PgUp/PgDn = channel up/down · 0–9 = digits · I = info\n');
});
