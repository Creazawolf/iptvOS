#!/usr/bin/env node
// G3 Hub – the IPTV brain for the launcher. Runs in an LXC on Proxmox (or anywhere with Node ≥ 18).
//
//   node hub/server.mjs [--port 8787] [--data <directory>] [--seed-demo <xtream-base-url>] [--demo-wallpapers <dev-server-address>]
//
// Web admin: http://<hub>:8787/   API: see docs/ARCHITECTURE.md §1
import { createServer, request as httpRequest } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './lib/api.mjs';
import { Catalog } from './lib/catalog.mjs';
import { Epg } from './lib/epg.mjs';
import { CORS, sendError, sendJson, serveStatic } from './lib/http.mjs';
import { langOf, setHubLanguage, tr } from './lib/i18n.mjs';
import { Images } from './lib/images.mjs';
import { Media } from './lib/media.mjs';
import { Sse } from './lib/sse.mjs';
import { Streams } from './lib/stream.mjs';
import { Store } from './lib/store.mjs';
import { Tmdb } from './lib/tmdb.mjs';
import { AerialProxy } from './lib/aerialproxy.mjs';
import { Wallpapers } from './lib/wallpapers.mjs';
import { gatePauses, log, onGatePause, parseArgs, removeStaleTmp, restoreGatePauses, setProviderHosts, VERSION, warn } from './lib/util.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || process.env.G3HUB_PORT) || 8787;
// Images on a port of their own: the browser (the TV) only has six connections per host:port, and a
// slow image must not make API calls (EPG, info) queue up. 0 = everything on the main port.
const imgPortWanted = args['img-port'] != null ? Number(args['img-port'])
  : process.env.G3HUB_IMG_PORT != null ? Number(process.env.G3HUB_IMG_PORT) : port + 1;
let imgPort = 0; // set when the image server is listening
const host = args.host || process.env.G3HUB_HOST || '0.0.0.0';
const dataDir = resolve(args.data || process.env.G3HUB_DATA || join(HERE, 'data'));
const webDir = join(HERE, 'web');

const store = new Store(dataDir);
// The hub's language: fallback for requests and content defaults (see lib/i18n.mjs).
setHubLanguage(() => store.settings.language);
await removeStaleTmp(dataDir);
await removeStaleTmp(join(dataDir, 'cache'));

// Demo provider for development: only if there are no playlists.
if (args['seed-demo'] && typeof args['seed-demo'] === 'string' && !store.playlists.length) {
  const p = store.addPlaylist({ name: 'Demo-IPTV', type: 'xtream', server: args['seed-demo'], username: 'demo', password: 'demo', format: 'm3u8' });
  store.data.seedDemo = p.id;
  store.scheduleSave();
}

// Provider hosts and pauses from the previous run apply straight away (see util.mjs).
const providerHosts = () => setProviderHosts(store.playlists.flatMap((p) => [p.server, p.m3uUrl, p.epgUrl]));
providerHosts();
restoreGatePauses(store.runtime.gates);
onGatePause(() => {
  store.runtime.gates = gatePauses();
  store.saveRuntime();
});

const sse = new Sse();
const catalog = new Catalog(store, dataDir);
const tmdb = new Tmdb(store, dataDir);
const epg = new Epg(store, catalog, dataDir);
const media = new Media(store, catalog, tmdb, sse, dataDir);
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const images = new Images(dataDir, () => new Set(store.playlists.flatMap((p) => [p.server, p.m3uUrl, p.epgUrl].map(hostOf)).filter(Boolean)));
// Stream proxy (films/episodes through the hub, with subtitles read out of the stream). Only the playlists' hosts.
const streams = new Streams({
  allowedHosts: () => new Set(store.playlists.map((p) => hostOf(p.server)).filter(Boolean)),
  userAgentFor: (h) => (store.playlists.find((p) => hostOf(p.server) === h) || {}).userAgent || ''
});
// Wallpapers and aerial films: the sources' lists are fetched and stored here, the TV gets a selection.
const wallpapers = new Wallpapers(dataDir, { demo: typeof args['demo-wallpapers'] === 'string' ? args['demo-wallpapers'] : '' });
// Aerial films from Apple's server go through the hub (the TV does not accept the server's certificate).
// In demo mode "Apple's" film is fetched from the dev server instead (the tests should not need the internet).
const demoWp = typeof args['demo-wallpapers'] === 'string' ? args['demo-wallpapers'] : '';
const aerialProxy = new AerialProxy(demoWp ? (opts, cb) => {
  const dev = new URL(demoWp);
  return httpRequest({ host: dev.hostname, port: dev.port, path: '/__mock/vod/1.mp4', method: opts.method, headers: opts.headers, agent: false }, cb);
} : null);
const api = createApi({ store, catalog, epg, media, images, tmdb, sse, streams, wallpapers, aerialProxy, dataDir, port, imgPort: () => imgPort });

// Curation/favourites/playlists changed → rebuild the index and tell the TV.
store.onChange((reason, rev) => {
  // Curation and favourites: only order/visibility is recalculated (fast). Playlists: the whole index.
  if (reason === 'curation' || reason === 'favorites') catalog.applyCuration();
  else if (reason === 'playlists') catalog.rebuild();
  if (reason === 'playlists') {
    providerHosts();
    catalog.checkSchedule();
  }
  sse.broadcast('rev', { rev, reason });
});

let statusTimer = null;
catalog.onRebuild((what) => {
  if (what !== 'status') return;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    sse.broadcast('status', (lang) => ({ playlists: store.playlists.map((p) => ({ id: p.id, ...catalog.status(p.id, lang) })) }), 'admin');
  }, 150);
});

await catalog.init();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  try {
    if (url.pathname.startsWith('/api/')) {
      if (await api(req, res, url)) return;
      sendJson(req, res, 404, { error: tr('errors.unknownPath', { path: url.pathname }, langOf(req)) });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      // Web admin (a single page; unknown paths give index.html).
      if (await serveStatic(req, res, webDir, url.pathname)) return;
      if (!/\.\w+$/.test(url.pathname) && (await serveStatic(req, res, webDir, '/index.html'))) return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(tr('errors.notFound', null, langOf(req)));
  } catch (e) {
    warn('server error', e);
    if (!res.headersSent) sendError(req, res, 500, e);
  }
});

server.keepAliveTimeout = 65000;
server.listen(port, host, () => {
  log(`G3 Hub ${VERSION} listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}  (data: ${dataDir}, language: ${store.settings.language})`);
});
server.on('error', (e) => {
  warn(`could not start on port ${port}: ${e.message}`);
  process.exit(1);
});

let imgServer = null;
if (imgPortWanted > 0) {
  imgServer = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/img') {
      try {
        await images.handle(req, res, url.searchParams.get('u'), url.searchParams.get('w'));
      } catch (e) {
        warn('image error', e.message);
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(tr('errors.imgOnly', null, langOf(req)));
  });
  imgServer.keepAliveTimeout = 65000;
  imgServer.on('error', (e) => {
    imgPort = 0;
    warn(`could not open image port ${imgPortWanted} (${e.message}) – images go through ${port}`);
  });
  imgServer.listen(imgPortWanted, host, () => {
    imgPort = imgPortWanted;
    log(`images on port ${imgPort}`);
  });
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('shutting down…');
  sse.close();
  catalog.stop();
  server.close();
  if (imgServer) imgServer.close();
  store.runtime.gates = gatePauses();
  store.saveRuntime();
  await Promise.all([store.flush(), tmdb.flush()]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
