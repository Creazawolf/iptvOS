// All API routes. See docs/ARCHITECTURE.md §1 for the contract.
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { hasSharp } from './images.mjs';
import { HttpError, readBody, sendError, sendJson } from './http.mjs';
import { hubLang, isLang, langOf, msgOf, text } from './i18n.mjs';
import { catchupUrl, testPlaylist } from './providers.mjs';
import { search } from './search.mjs';
import { KINDS, publicPlaylist, sanitizePlaylist } from './store.mjs';
import { clamp, gateStatus, moveItem, VERSION } from './util.mjs';

const IMAGE_FIELDS = ['logo', 'poster', 'backdrop', 'still'];

export function createApi({ store, catalog, epg, media, images, tmdb, sse, streams, wallpapers, aerialProxy, dataDir, port, imgPort = () => 0 }) {
  const started = Date.now();
  let lastTv = null;
  const sortCache = new Map();
  let sortGen = -1;

  // --- Helpers -------------------------------------------------------------------------

  const baseUrl = (req) => {
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    return `${proto}://${req.headers.host || 'localhost:' + port}`;
  };

  // Base for images: the same host, but the image port (if it is running and we are not behind an https proxy).
  const imgBase = (req) => {
    const base = baseUrl(req);
    const p = imgPort();
    if (!p) return base;
    try {
      const u = new URL(base);
      if (u.protocol !== 'http:') return base;
      u.port = String(p);
      return u.origin;
    } catch {
      return base;
    }
  };

  // Rewrite image addresses to the hub's cache (if the image proxy is on).
  function imgRewriter(req) {
    if (!store.settings.imageProxy) return (o) => o;
    const base = baseUrl(req);
    const ib = imgBase(req);
    const prefix = ib + '/api/img?u=';
    const wrap = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) && !u.startsWith(base) && !u.startsWith(ib) ? prefix + encodeURIComponent(u) : u);
    const one = (o) => {
      if (!o || typeof o !== 'object') return o;
      let copy = null;
      for (const f of IMAGE_FIELDS) {
        if (o[f]) {
          const w = wrap(o[f]);
          if (w !== o[f]) {
            if (!copy) copy = { ...o };
            copy[f] = w;
          }
        }
      }
      return copy || o;
    };
    const fn = (x) => (Array.isArray(x) ? x.map(one) : one(x));
    fn.deep = (o) => {
      // For detail pages: seasons and episodes.
      const top = one(o);
      if (top && Array.isArray(top.seasons)) {
        return { ...top, seasons: top.seasons.map((s) => ({ ...one(s), episodes: s.episodes.map(one) })) };
      }
      return top;
    };
    return fn;
  }

  const tokenOf = (req, url) => req.headers['x-hub-token'] || url.searchParams.get('token') || '';

  function requireAdmin(req, url) {
    const t = store.settings.adminToken;
    if (t && tokenOf(req, url) !== t) throw new HttpError(401, 'errors.badAdminToken');
  }

  function requireTv(req, url) {
    const t = store.settings.tvToken;
    const tok = tokenOf(req, url);
    if (t && tok !== t && !(store.settings.adminToken && tok === store.settings.adminToken)) {
      throw new HttpError(401, 'errors.badToken');
    }
    lastTv = { at: Date.now(), addr: req.socket.remoteAddress, ua: String(req.headers['user-agent'] || '').slice(0, 120) };
  }

  const kindParam = (v) => {
    if (!KINDS.includes(v)) throw new HttpError(400, 'errors.badKind');
    return v;
  };

  function playlistStatus(p, lang) {
    const s = catalog.status(p.id, lang);
    return {
      ok: s.ok,
      refreshing: s.refreshing,
      step: s.step,
      error: s.error,
      warnings: s.warnings,
      updatedAt: s.updatedAt,
      counts: s.counts,
      expires: s.info ? s.info.expires : null,
      maxConnections: s.info ? s.info.maxConnections : null,
      activeConnections: s.info ? s.info.activeConnections : null,
      accountStatus: s.info ? s.info.status : null
    };
  }

  function bootstrap(req) {
    const img = imgRewriter(req);
    const lang = langOf(req);
    return {
      rev: store.rev,
      name: store.settings.name,
      version: VERSION,
      // What the hub can do: stream = films/episodes via /api/stream with subtitles on /api/subs.
      caps: { stream: !!streams, wallpapers: !!wallpapers },
      imgBase: imgBase(req),
      playlists: store.playlists.map((p) => ({ id: p.id, name: p.name, type: p.type, enabled: p.enabled, status: playlistStatus(p, lang) })),
      live: { categories: catalog.categories('live'), favorites: img(catalog.favoriteChannels()) },
      vod: { categories: catalog.categories('vod'), favorites: img(mediaFavs('vod')) },
      series: { categories: catalog.categories('series'), favorites: img(mediaFavs('series')) },
      continue: img(media.continueList(lang)),
      positions: media.positions()
    };
  }

  // Favourited films/series, most recently added first.
  function mediaFavs(kind) {
    return store.mediaFavorites(kind).slice().reverse()
      .map((id) => catalog.entry(kind, id))
      .filter(Boolean)
      .map((e) => e.o);
  }

  function sortedList(kind, category, sort) {
    // New index or changed curation (e.g. hidden categories in "Recently added"): start over, so that
    // old index generations do not linger in memory either.
    if (sortGen !== catalog.gen) {
      sortCache.clear();
      sortGen = catalog.gen;
    }
    const key = `${kind}|${category}|${sort}|${hubLang()}`;
    const hit = sortCache.get(key);
    if (hit) return hit;
    if (category === 'favorites') {
      const favs = store.mediaFavorites(kind).slice().reverse().map((id) => catalog.entry(kind, id)).filter(Boolean);
      return favs; // (no cache: changes when you star something)
    }
    let list = category === 'recent' ? catalog.visibleEntries(kind).slice() : catalog.entries(kind, category).slice();
    if (category === 'recent' || sort === 'added') list.sort((a, b) => (b.o.added || 0) - (a.o.added || 0));
    else if (sort === 'name') list.sort((a, b) => a.o.title.localeCompare(b.o.title, hubLang()));
    else if (sort === 'rating') list.sort((a, b) => (b.o.rating || 0) - (a.o.rating || 0));
    if (category === 'recent') list = list.slice(0, 200);
    if (sortCache.size > 200) sortCache.clear();
    sortCache.set(key, list);
    return list;
  }

  function listResponse(req, url, kind) {
    const category = url.searchParams.get('category') || 'recent';
    const sort = ['added', 'name', 'rating'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'added';
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = clamp(Number(url.searchParams.get('limit')) || 60, 1, 500);
    const list = sortedList(kind, category, sort);
    const page = list.slice(offset, offset + limit);
    if (tmdb.enabled) for (const e of page) if (!e.o.poster) tmdb.enrichLater(kind, e);
    return { total: list.length, items: imgRewriter(req)(page.map((e) => e.o)) };
  }

  function lanUrls() {
    const out = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
    }
    return out;
  }

  function adminCategories(kind) {
    const names = new Map(store.playlists.map((p) => [p.id, p.name]));
    return catalog.categories(kind, { all: true }).map((c) => ({ ...c, playlistName: names.get(c.playlistId) || '' }));
  }

  function moveVisibleCategory(kind, id, delta) {
    const k = catalog.idx[kind];
    const order = k.order.slice();
    const visible = order.filter((x) => k.visible.has(x));
    const i = visible.indexOf(id);
    const target = visible[i + delta];
    if (i < 0 || !target) return false;
    order.splice(order.indexOf(id), 1);
    const t = order.indexOf(target);
    order.splice(delta > 0 ? t + 1 : t, 0, id);
    store.curation(kind).order = order;
    store.changed('curation');
    return true;
  }

  // --- Routes -----------------------------------------------------------------------------

  const routes = [];
  const add = (method, path, handler) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  add('GET', '/api/health', () => ({ ok: true, version: VERSION, name: store.settings.name }));

  // TV
  // ?since=<hash from the previous response>: nothing changed → { same: true } (the TV is spared loading and redrawing).
  add('GET', '/api/tv/bootstrap', (req, url) => {
    requireTv(req, url);
    const body = bootstrap(req);
    const hash = createHash('sha1').update(JSON.stringify(body)).digest('base64url').slice(0, 16);
    if (url.searchParams.get('since') === hash) return { same: true, hash };
    body.hash = hash;
    return body;
  });

  add('GET', '/api/events', (req, url, res) => {
    const admin = url.searchParams.get('admin') === '1';
    if (admin) requireAdmin(req, url);
    else requireTv(req, url);
    sse.add(req, res, { rev: store.rev, kind: admin ? 'admin' : 'tv' });
    return undefined; // handled
  });

  add('GET', '/api/live/channels', (req, url) => {
    requireTv(req, url);
    const cat = url.searchParams.get('category');
    if (!cat) throw new HttpError(400, 'errors.missingCategory');
    const items = cat === 'favorites' ? catalog.favoriteChannels() : catalog.entries('live', cat).map((e) => e.o);
    return { items: imgRewriter(req)(items) };
  });

  add('GET', '/api/live/epg', async (req, url) => {
    requireTv(req, url);
    const ids = String(url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    return { epg: await epg.nowNext(ids) };
  });

  // Guide (grid): programmes for the channels in a category within a time window.
  //   /api/live/grid?category=ID|favorites&from=ms&hours=3&offset=0&limit=60
  add('GET', '/api/live/grid', async (req, url) => {
    requireTv(req, url);
    const cat = url.searchParams.get('category');
    if (!cat) throw new HttpError(400, 'errors.missingCategory');
    const now = Date.now();
    const from = Number(url.searchParams.get('from')) || now - 30 * 60e3;
    const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 3, 1), 12);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 60, 1), 200);
    const all = cat === 'favorites' ? catalog.favoriteChannels() : catalog.entries('live', cat).map((e) => e.o);
    const channels = all.slice(offset, offset + limit);
    const to = from + hours * 3600e3;
    const programs = await epg.grid(channels.map((c) => c.id), from, to);
    return { from, to, total: all.length, channels: imgRewriter(req)(channels), programs };
  });

  add('GET', '/api/live/guide', async (req, url) => {
    requireTv(req, url);
    const id = url.searchParams.get('id');
    if (!id) throw new HttpError(400, 'errors.missingId');
    return { items: await epg.guide(id) };
  });

  // Programme search in the guide: { items:[{ channel, program }] }
  add('GET', '/api/epg/search', (req, url) => {
    requireTv(req, url);
    const items = epg.search(url.searchParams.get('q') || '', { limit: clamp(Number(url.searchParams.get('limit')) || 40, 1, 100) });
    const img = imgRewriter(req);
    return { items: items.map((x) => ({ channel: img(x.channel), program: x.program })) };
  });

  // Catch-up: address for a past programme on a channel that supports it.
  //   /api/live/catchup?id=<channel>&start=<ms>&end=<ms>  → { url, start, end }
  add('GET', '/api/live/catchup', (req, url) => {
    requireTv(req, url);
    const id = url.searchParams.get('id');
    const e = catalog.entry('live', id);
    const p = catalog.playlistFor(id);
    if (!e || !p) throw new HttpError(404, 'errors.channelNotFound');
    if (!e.o.catchup) throw new HttpError(400, 'errors.noCatchup');
    if (p.type !== 'xtream') throw new HttpError(400, 'errors.catchupNeedsXtream');
    const now = Date.now();
    // A little margin: guides are often a minute or two out.
    const start = Number(url.searchParams.get('start')) - 2 * 60e3;
    const end = Math.min(Number(url.searchParams.get('end')) + 5 * 60e3, now);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new HttpError(400, 'errors.startEndRequired');
    if (start > now) throw new HttpError(400, 'errors.notStarted');
    if (now - start > (e.o.catchupDays || 3) * 86400e3 + 3600e3) throw new HttpError(410, 'errors.tooOldForCatchup');
    const raw = catalog.raw.get(p.id);
    const tz = raw && raw.info && raw.info.timezone;
    return { url: catchupUrl(p, e.sid, start, end, tz), start, end };
  });

  add('GET', '/api/vod/list', (req, url) => { requireTv(req, url); return listResponse(req, url, 'vod'); });
  add('GET', '/api/series/list', (req, url) => { requireTv(req, url); return listResponse(req, url, 'series'); });

  add('GET', '/api/vod/info', async (req, url) => {
    requireTv(req, url);
    const info = await media.vodInfo(url.searchParams.get('id'));
    if (!info) throw new HttpError(404, 'errors.movieNotFound');
    return imgRewriter(req)(info);
  });

  add('GET', '/api/series/info', async (req, url) => {
    requireTv(req, url);
    const info = await media.seriesInfo(url.searchParams.get('id'), langOf(req));
    if (!info) throw new HttpError(404, 'errors.seriesNotFound');
    return imgRewriter(req).deep(info);
  });

  add('GET', '/api/search', (req, url) => {
    requireTv(req, url);
    const r = search(catalog, url.searchParams.get('q') || '', {
      limit: clamp(Number(url.searchParams.get('limit')) || 30, 1, 200),
      all: url.searchParams.get('all') === '1'
    });
    const img = imgRewriter(req);
    return { live: img(r.live), vod: img(r.vod), series: img(r.series) };
  });

  // Wallpapers: the collections, a random selection from the chosen ones, and the aerial films for the screensaver.
  add('GET', '/api/wallpapers', async (req, url) => {
    requireTv(req, url);
    if (!wallpapers) throw new HttpError(404, 'errors.wallpapersOff');
    return { sets: await wallpapers.list(langOf(req)) };
  });

  add('GET', '/api/wallpapers/items', async (req, url) => {
    requireTv(req, url);
    if (!wallpapers) throw new HttpError(404, 'errors.wallpapersOff');
    const sets = (url.searchParams.get('sets') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
    return { items: await wallpapers.items(sets, clamp(Number(url.searchParams.get('limit')) || 30, 1, 100)) };
  });

  add('GET', '/api/wallpapers/aerial', async (req, url) => {
    requireTv(req, url);
    if (!wallpapers) throw new HttpError(404, 'errors.wallpapersOff');
    const r = await wallpapers.aerial(langOf(req));
    return aerialProxy ? r : { ...r, proxyHosts: [] };
  });

  // An aerial film from a server the TV cannot fetch from itself (see aerialproxy.mjs).
  add('GET', '/api/wallpapers/video', async (req, url, res) => {
    requireTv(req, url);
    if (!aerialProxy) throw new HttpError(404, 'errors.aerialOff');
    await aerialProxy.handle(req, res, url.searchParams.get('u') || '');
    return undefined;
  });

  // Film/episode through the hub: the same bytes as from the provider, and the subtitles are read out on the way.
  add('GET', '/api/stream', async (req, url, res) => {
    requireTv(req, url);
    if (!streams) throw new HttpError(404, 'errors.streamOff');
    await streams.handle(req, res, url.searchParams.get('u') || '');
    return undefined;
  });

  // Subtitles read out so far: { known, tracks:[{ index, codec, text, lang, name, default, forced }], cues:[[start, end, text]], next }
  add('GET', '/api/subs', (req, url) => {
    requireTv(req, url);
    if (!streams) throw new HttpError(404, 'errors.streamOff');
    const t = url.searchParams.get('track');
    return streams.subs(url.searchParams.get('u') || '', t == null || t === '' ? -1 : Number(t), Number(url.searchParams.get('after')) || 0);
  });

  add('GET', '/api/img', async (req, url, res) => {
    await images.handle(req, res, url.searchParams.get('u'), url.searchParams.get('w'));
    return undefined;
  });

  add('POST', '/api/tv/favorites/toggle', async (req, url) => {
    requireTv(req, url);
    const { id } = await readBody(req);
    if (!id) throw new HttpError(400, 'errors.missingId');
    const favs = store.data.favorites;
    const i = favs.indexOf(id);
    if (i >= 0) favs.splice(i, 1);
    else favs.push(id);
    store.changed('favorites');
    return { rev: store.rev, favorite: i < 0 };
  });

  // Favourite a film or series: { kind: 'vod'|'series', id }
  add('POST', '/api/tv/media-favorites/toggle', async (req, url) => {
    requireTv(req, url);
    const { kind, id } = await readBody(req);
    if ((kind !== 'vod' && kind !== 'series') || !id) throw new HttpError(400, 'errors.mediaFavoriteInput');
    const favs = store.data.mediaFavorites[kind];
    const i = favs.indexOf(id);
    if (i >= 0) favs.splice(i, 1);
    else favs.push(id);
    store.changed('mediaFavorites');
    return { rev: store.rev, favorite: i < 0 };
  });

  add('POST', '/api/tv/favorites/move', async (req, url) => {
    requireTv(req, url);
    const { id, delta } = await readBody(req);
    if (moveItem(store.data.favorites, id, Math.sign(Number(delta) || 0))) store.changed('favorites');
    return { rev: store.rev };
  });

  add('POST', '/api/tv/categories/move', async (req, url) => {
    requireTv(req, url);
    const { kind, id, delta } = await readBody(req);
    moveVisibleCategory(kindParam(kind), id, Math.sign(Number(delta) || 0));
    return { rev: store.rev };
  });

  add('POST', '/api/tv/categories/hide', async (req, url) => {
    requireTv(req, url);
    const { kind, id } = await readBody(req);
    const cur = store.curation(kindParam(kind));
    const i = cur.visible.indexOf(id);
    if (i >= 0) {
      cur.visible.splice(i, 1);
      store.changed('curation');
    }
    return { rev: store.rev };
  });

  add('POST', '/api/tv/progress', async (req, url) => {
    requireTv(req, url);
    return media.saveProgress(await readBody(req));
  });

  // Admin
  add('GET', '/api/admin/status', (req, url) => {
    requireAdmin(req, url);
    const lang = langOf(req);
    return {
      name: store.settings.name,
      version: VERSION,
      rev: store.rev,
      uptime: Math.round((Date.now() - started) / 1000),
      node: process.version,
      sharp: hasSharp(),
      tmdb: tmdb.enabled,
      dataDir,
      urls: lanUrls(),
      counts: catalog.counts(),
      favorites: catalog.favoriteChannels().length,
      favoritesMissing: store.favorites.length - catalog.favoriteChannels().length,
      continue: media.continueList().length,
      playlists: store.playlists.map((p) => ({ ...publicPlaylist(p), status: playlistStatus(p, lang) })),
      tv: { connected: sse.count('tv'), lastSeen: sse.lastTvSeen, lastRequest: lastTv },
      // Providers currently blocking the hub (the hub waits, see util.mjs).
      pauses: gateStatus(),
      streams: streams ? streams.status() : null,
      aerial: aerialProxy ? aerialProxy.status() : null
    };
  });

  // Backup: everything you have set up (playlists incl. passwords, curation, favourites, settings)
  // and Continue watching. The catalogue and the images are cache and are fetched again.
  add('GET', '/api/admin/backup', (req, url) => {
    requireAdmin(req, url);
    return { kind: 'g3hub-backup', version: 1, hub: VERSION, exportedAt: Date.now(), config: store.data, progress: store.progress };
  });

  add('POST', '/api/admin/restore', async (req, url) => {
    requireAdmin(req, url);
    const b = await readBody(req, 20 * 1024 * 1024);
    if (!b || b.kind !== 'g3hub-backup' || !b.config || !Array.isArray(b.config.playlists)) {
      throw new HttpError(400, 'errors.notBackup');
    }
    // The current token is kept (otherwise an old file could lock out both this session and the TV).
    const conn = (p) => JSON.stringify([p.type, p.server, p.username, p.password, p.m3uUrl, p.format, p.enabled]);
    const before = new Map(store.playlists.map((p) => [p.id, conn(p)]));
    const config = { ...b.config, settings: { ...(b.config.settings || {}), adminToken: store.settings.adminToken, tvToken: store.settings.tvToken } };
    store.replace(config, b.progress);
    // The catalogues: removed playlists are forgotten, new or changed ones are fetched again now.
    const now = new Set(store.playlists.map((p) => p.id));
    for (const id of before.keys()) if (!now.has(id)) await catalog.forget(id);
    for (const p of store.playlists) if (p.enabled && before.get(p.id) !== conn(p)) catalog.refresh(p.id);
    media.notify();
    return { ok: true, rev: store.rev, playlists: store.playlists.length };
  });

  add('GET', '/api/admin/playlists', (req, url) => {
    requireAdmin(req, url);
    return { items: store.playlists.map((p) => ({ ...publicPlaylist(p), status: playlistStatus(p, langOf(req)) })) };
  });

  add('POST', '/api/admin/playlists/test', async (req, url) => {
    requireAdmin(req, url);
    const body = await readBody(req);
    const old = body.id ? store.playlist(body.id) : null;
    const p = sanitizePlaylist(Object.assign({}, old || {}, body));
    if (old && !body.password) p.password = old.password;
    try {
      const info = await testPlaylist(p);
      if (info.entries) info.entries = text(info.entries, langOf(req));
      return { ok: true, info };
    } catch (e) {
      return { ok: false, error: text(msgOf(e), langOf(req)) };
    }
  });

  add('POST', '/api/admin/playlists', async (req, url) => {
    requireAdmin(req, url);
    const p = store.addPlaylist(await readBody(req));
    catalog.refresh(p.id);
    return { item: { ...publicPlaylist(p), status: playlistStatus(p, langOf(req)) } };
  });

  add('PUT', '/api/admin/playlists/:id', async (req, url, res, params) => {
    requireAdmin(req, url);
    const body = await readBody(req);
    const before = store.playlist(params.id);
    if (!before) throw new HttpError(404, 'errors.playlistNotFound');
    const snapshot = JSON.stringify([before.server, before.username, before.password, before.m3uUrl, before.format, before.type]);
    const p = store.updatePlaylist(params.id, body);
    const changedConn = snapshot !== JSON.stringify([p.server, p.username, p.password, p.m3uUrl, p.format, p.type]);
    if (p.enabled && (changedConn || !catalog.raw.has(p.id))) catalog.refresh(p.id);
    return { item: { ...publicPlaylist(p), status: playlistStatus(p, langOf(req)) } };
  });

  add('DELETE', '/api/admin/playlists/:id', async (req, url, res, params) => {
    requireAdmin(req, url);
    if (!store.removePlaylist(params.id)) throw new HttpError(404, 'errors.playlistNotFound');
    await catalog.forget(params.id);
    return { ok: true };
  });

  add('POST', '/api/admin/playlists/:id/refresh', (req, url, res, params) => {
    requireAdmin(req, url);
    if (!store.playlist(params.id)) throw new HttpError(404, 'errors.playlistNotFound');
    catalog.refresh(params.id);
    return { ok: true };
  });

  add('POST', '/api/admin/refresh', (req, url) => {
    requireAdmin(req, url);
    for (const p of store.playlists) if (p.enabled) catalog.refresh(p.id);
    return { ok: true };
  });

  add('GET', '/api/admin/categories', (req, url) => {
    requireAdmin(req, url);
    const kind = kindParam(url.searchParams.get('kind') || 'live');
    return { items: adminCategories(kind) };
  });

  add('PUT', '/api/admin/categories', async (req, url) => {
    requireAdmin(req, url);
    const kind = kindParam(url.searchParams.get('kind') || 'live');
    const body = await readBody(req);
    const cur = store.curation(kind);
    const exists = (id) => typeof id === 'string' && catalog.idx[kind].cats.has(id);
    if (Array.isArray(body.order)) cur.order = [...new Set(body.order.filter(exists))];
    if (Array.isArray(body.visible)) cur.visible = [...new Set(body.visible.filter(exists))];
    store.changed('curation');
    return { ok: true, rev: store.rev };
  });

  add('GET', '/api/admin/channels', (req, url) => {
    requireAdmin(req, url);
    const cat = url.searchParams.get('category');
    const q = (url.searchParams.get('q') || '').trim();
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = clamp(Number(url.searchParams.get('limit')) || 200, 1, 1000);
    let list;
    if (q) {
      list = search(catalog, q, { limit: 1000, all: true, kinds: ['live'] }).live;
      if (cat) list = list.filter((c) => c.categoryId === cat);
    } else if (cat === 'favorites') list = catalog.favoriteChannels();
    else if (cat) list = catalog.entries('live', cat).map((e) => e.o);
    else list = [];
    const favs = new Set(store.favorites);
    const cats = catalog.idx.live.cats;
    const items = list.slice(offset, offset + limit).map((c) => ({
      ...c,
      favorite: favs.has(c.id),
      categoryName: (cats.get(c.categoryId) || {}).name || '',
      categoryVisible: catalog.idx.live.visible.has(c.categoryId)
    }));
    return { total: list.length, items: imgRewriter(req)(items) };
  });

  add('GET', '/api/admin/favorites', (req, url) => {
    requireAdmin(req, url);
    const cats = catalog.idx.live.cats;
    const items = store.favorites.map((id) => {
      const e = catalog.entry('live', id);
      if (!e) return { id, missing: true, name: id };
      return { ...e.o, categoryName: (cats.get(e.o.categoryId) || {}).name || '' };
    });
    return { items: imgRewriter(req)(items) };
  });

  add('PUT', '/api/admin/favorites', async (req, url) => {
    requireAdmin(req, url);
    const { ids } = await readBody(req);
    if (!Array.isArray(ids)) throw new HttpError(400, 'errors.missingIds');
    store.data.favorites = [...new Set(ids.filter((x) => typeof x === 'string'))];
    store.changed('favorites');
    return { ok: true, rev: store.rev };
  });

  add('GET', '/api/admin/settings', (req, url) => {
    requireAdmin(req, url);
    return { settings: store.settings };
  });

  add('PUT', '/api/admin/settings', async (req, url) => {
    requireAdmin(req, url);
    const b = await readBody(req);
    const s = store.settings;
    if (typeof b.name === 'string') s.name = b.name.trim().slice(0, 60) || 'G3 Hub';
    if (typeof b.adminToken === 'string') s.adminToken = b.adminToken.trim();
    if (typeof b.tvToken === 'string') s.tvToken = b.tvToken.trim();
    if (b.refreshHours != null) s.refreshHours = clamp(Number(b.refreshHours) || 12, 1, 168);
    if (typeof b.tmdbKey === 'string') s.tmdbKey = b.tmdbKey.trim();
    // Empty = follow the hub's language (sv-SE / en-US, see tmdb.mjs).
    if (typeof b.tmdbLanguage === 'string') s.tmdbLanguage = b.tmdbLanguage.trim();
    if (b.imageProxy != null) s.imageProxy = !!b.imageProxy;
    const langChanged = isLang(b.language) && b.language !== s.language;
    if (langChanged) s.language = b.language;
    store.changed('settings');
    // Names the index sets (e.g. "Uncategorised") follow the hub's language.
    if (langChanged) catalog.rebuild();
    return { settings: s };
  });

  add('GET', '/api/admin/search', (req, url) => {
    requireAdmin(req, url);
    const r = search(catalog, url.searchParams.get('q') || '', { limit: 50, all: url.searchParams.get('all') !== '0' });
    const img = imgRewriter(req);
    return { live: img(r.live), vod: img(r.vod), series: img(r.series) };
  });

  add('DELETE', '/api/admin/progress', (req, url) => {
    requireAdmin(req, url);
    for (const k of Object.keys(store.progress)) store.setProgress(k, null);
    media.notify();
    return { ok: true };
  });

  // --- Dispatcher ---------------------------------------------------------------------------

  return async function handle(req, res, url) {
    for (const r of routes) {
      if (r.method !== req.method && !(req.method === 'HEAD' && r.method === 'GET')) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        const out = await r.handler(req, url, res, params);
        if (out !== undefined && !res.headersSent) sendJson(req, res, 200, out);
      } catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error(e);
        if (!res.headersSent) sendError(req, res, status, e);
      }
      return true;
    }
    return false;
  };
}
