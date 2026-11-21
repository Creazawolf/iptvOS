/*
 * IPTV.source — the data source for the TV app. Two backends with the same methods and data format
 * (see docs/ARCHITECTURE.md §1–2):
 *
 *   hub     G3 Hub on your server (Proxmox). The selection, favourites, search and artwork are handled
 *           there, and changes from the web admin arrive straight away via /api/events (SSE).
 *   direct  Xtream Codes directly from the TV. The selection (favourites, category order, hidden)
 *           is stored on the TV under iptv.local.*.
 *
 * Mode: Store iptv.mode = 'hub' | 'direct' | '' (auto: the hub if an address is set, otherwise direct).
 *
 * Public (stable) API for the home screen and widgets:
 *   IPTV.ready · configured() · favorites() · continueWatching() · lastChannel() · onChange(fn)
 * More (for the TV view): IPTV.mode() · status() · boot() · categories(kind) · isFavorite(id)
 *   toggleFavorite(ch) · moveFavorite(id, d) · moveCategory(kind, id, d) · hideCategory(kind, id)
 *   progressFor(id) · saveProgress(p) · remember(ch) · recent() · reload()
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const u = IPTV.u;
  const CACHE_KEY = 'g3:iptv:boot:v1';
  const TIMEOUT = 9000;
  // The hub: "nothing has changed since the previous bootstrap".
  const SAME = { same: true };

  // --- Helpers ----------------------------------------------------------------------

  const num = (v) => {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  };

  function fold(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  }

  // "SE - Title (2019)" -> { title: 'Title', year: 2019 }
  function cleanTitle(name, year) {
    let t = String(name || '').trim();
    let y = num(year) || 0;
    const m = /\s*[([](\d{4})[)\]]\s*$/.exec(t);
    if (m) {
      if (!y) y = +m[1];
      t = t.slice(0, m.index).trim();
    }
    t = t.replace(/^[A-Z]{2,3}\s*[|:-]\s+/, '');
    return { title: t || String(name || ''), year: y || null };
  }

  function parseDuration(secs, str) {
    if (num(secs)) return num(secs);
    const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(String(str || '').trim());
    if (m) return m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
    const mm = /(\d+)\s*min/i.exec(String(str || ''));
    return mm ? +mm[1] * 60 : 0;
  }

  const firstOf = (v) => (Array.isArray(v) ? v[0] || '' : v || '');

  function moveIn(list, idOf, id, delta) {
    const i = list.findIndex((x) => String(idOf(x)) === String(id));
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return false;
    list.splice(j, 0, list.splice(i, 1)[0]);
    return true;
  }

  // Limited parallelism (e.g. for EPG in direct mode).
  function limiter(max) {
    let running = 0;
    const queue = [];
    function pump() {
      while (running < max && queue.length) {
        const job = queue.shift();
        running++;
        job.fn().then(job.resolve, job.reject).then(() => { running--; pump(); });
      }
    }
    return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
  }

  // --- Migration from v2 (flat keys + favourites in Store) -----------------------------

  function migrate() {
    const i = Store.get('iptv') || {};
    const d = i.direct || {};
    if ((i.server || i.username) && !d.server) {
      Store.set('iptv.direct', {
        server: i.server || '',
        username: i.username || '',
        password: i.password || '',
        format: i.format === 'ts' ? 'ts' : 'm3u8'
      });
    }
    if (i.server != null || i.username != null || i.password != null || i.format != null) {
      ['server', 'username', 'password', 'format'].forEach((k) => { if (i[k] != null) Store.set('iptv.' + k, null); });
    }
    const local = Store.get('iptv.local') || {};
    if (!local.migrated) {
      const old = Store.get('favorites.channels') || [];
      if (!local.favorites && old.length) Store.set('iptv.local.favorites', old.map(fixDirectChannel));
      Store.set('iptv.local.migrated', 1);
    }
  }

  // Channel from v2 (numeric id) or without a url -> direct format.
  function fixDirectChannel(ch) {
    if (!ch) return ch;
    const c = Object.assign({}, ch);
    if (/^\d+$/.test(String(c.id))) {
      c.streamId = +c.id;
      c.id = 'x:' + c.id;
      c.playlistId = 'x';
      if (c.categoryId != null && !/:/.test(String(c.categoryId))) c.categoryId = 'x:c:' + c.categoryId;
    }
    if (String(c.id).indexOf('x:') === 0) c.url = directUrl.live(c.streamId || String(c.id).slice(2));
    return c;
  }

  // --- Mode and addresses ------------------------------------------------------------------

  function normalizeHub(s) {
    s = String(s || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    s = s.replace(/\/+$/, '').replace(/\/api$/, '');
    // Without a port: the hub's default port.
    if (!/^https?:\/\/[^/]+:\d+/i.test(s) && !/^https:/i.test(s)) s = s.replace(/^(https?:\/\/[^/]+)/i, '$1:8787');
    return s;
  }

  function hubUrl() {
    const own = normalizeHub(Store.get('iptv.hub.url'));
    if (own) return own;
    // Preview in the browser: the dev server's hub (unless there is a direct account of your own).
    const directServer = String((Store.get('iptv.direct') || {}).server || '');
    const demo = !directServer || directServer.indexOf('demo.g3custom.test') >= 0;
    if (!TV.isTV && global.__DEV_HUB && demo && Store.get('iptv.mode') !== 'direct') {
      return normalizeHub(global.__DEV_HUB);
    }
    return '';
  }

  function mode() {
    const m = Store.get('iptv.mode');
    if (m === 'hub' || m === 'direct') return m;
    return hubUrl() ? 'hub' : 'direct';
  }

  // --- Hub -------------------------------------------------------------------------------------

  const hub = (function () {
    const token = () => String(Store.get('iptv.hub.token') || '').trim();

    function qs(params) {
      const parts = [];
      Object.keys(params || {}).forEach((k) => {
        if (params[k] != null && params[k] !== '') parts.push(k + '=' + encodeURIComponent(params[k]));
      });
      return parts.length ? '?' + parts.join('&') : '';
    }

    function request(path, opts) {
      opts = opts || {};
      const base = hubUrl();
      if (!base) return Promise.reject(Object.assign(new Error(tr('source.noHubAddress')), { friendly: true }));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT);
      // The hub answers with error messages in the TV's language (Accept-Language is CORS-safe, no preflight).
      const headers = { 'Accept-Language': I18n.lang };
      if (token()) headers['X-Hub-Token'] = token();
      if (opts.body) headers['Content-Type'] = 'application/json';
      return fetch(base + path + qs(opts.query), {
        method: opts.body ? 'POST' : 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store'
      })
        .then((r) => {
          if (r.status === 401 || r.status === 403) throw Object.assign(new Error(tr('source.hubToken')), { friendly: true, status: r.status });
          if (!r.ok) throw Object.assign(new Error(tr('source.hubHttpError', { status: r.status })), { friendly: true, status: r.status });
          return r.json();
        })
        .catch((e) => {
          if (e.friendly) throw e;
          const msg = e && e.name === 'AbortError' ? tr('source.hubTimeout') : tr('source.hubUnreachable', { url: base });
          throw Object.assign(new Error(msg), { friendly: true, cause: e });
        })
        .finally(() => clearTimeout(timer));
    }

    const get = (path, query, opts) => request(path, Object.assign({ query }, opts || {}));
    const post = (path, body) => request(path, { body: body || {} });

    return {
      kind: 'hub',
      health: () => get('/api/health', null, { timeout: 5000 }),
      // since = hash from the previous response → the hub answers { same: true } if nothing has changed.
      bootstrap: (since) => get('/api/tv/bootstrap', since ? { since } : null).then((r) => (r && r.same ? SAME : r)),
      channels: (category) => get('/api/live/channels', { category }, { timeout: 20000 }).then((r) => (r && r.items) || []),
      epg: (ids) => get('/api/live/epg', { ids: ids.join(',') }).then((r) => (r && r.epg) || {}),
      guide: (id) => get('/api/live/guide', { id }).then((r) => (r && r.items) || []),
      grid: (q) => get('/api/live/grid', q, { timeout: 20000 }),
      toggleMediaFavorite: (kind, id) => post('/api/tv/media-favorites/toggle', { kind, id }),
      vodList: (q) => get('/api/vod/list', q, { timeout: 20000 }),
      vodInfo: (id) => get('/api/vod/info', { id }, { timeout: 20000 }),
      seriesList: (q) => get('/api/series/list', q, { timeout: 20000 }),
      seriesInfo: (id) => get('/api/series/info', { id }, { timeout: 20000 }),
      search: (q, opts) => get('/api/search', { q, limit: (opts && opts.limit) || 30, all: opts && opts.all ? 1 : 0 }, { timeout: 15000 }),
      toggleFavorite: (id) => post('/api/tv/favorites/toggle', { id }),
      moveFavorite: (id, delta) => post('/api/tv/favorites/move', { id, delta }),
      moveCategory: (kind, id, delta) => post('/api/tv/categories/move', { kind, id, delta }),
      hideCategory: (kind, id) => post('/api/tv/categories/hide', { kind, id }),
      progress: (p) => post('/api/tv/progress', p),
      epgSearch: (q, limit) => get('/api/epg/search', { q, limit: limit || 40 }, { timeout: 12000 }).then((r) => (r && r.items) || []),
      catchup: (ch, prog) => get('/api/live/catchup', { id: ch.id, start: prog.start, end: prog.end }).then((r) => r.url),
      img(url, w) {
        if (!url || /^data:/.test(url)) return url || '';
        const base = hubUrl();
        if (!base || url.charAt(0) === '/') return url;
        // The hub's image port (its own port, see hub/server.mjs) – otherwise the main port.
        const ib = (S.boot && S.boot.imgBase) || base;
        if (url.indexOf(base + '/') === 0 || url.indexOf(ib + '/') === 0) {
          return w && url.indexOf('/api/img?') > 0 && !/[?&]w=/.test(url) ? url + '&w=' + Math.round(w) : url;
        }
        return ib + '/api/img?u=' + encodeURIComponent(url) + (w ? '&w=' + Math.round(w) : '') +
          (token() ? '&token=' + encodeURIComponent(token()) : '');
      },
      // Backgrounds and aerial videos (the hub keeps the sources' lists and hands out a selection).
      wallpapers: () => get('/api/wallpapers', null, { timeout: 8000 }).then((r) => (r && r.sets) || []),
      wallpaperItems: (sets, limit) => get('/api/wallpapers/items', { sets: sets.join(','), limit: limit || 30 }, { timeout: 15000 }).then((r) => (r && r.items) || []),
      aerial: () => get('/api/wallpapers/aerial', null, { timeout: 25000 }),
      // Videos from servers the TV cannot fetch from itself (Apple's) are played via the hub.
      aerialVideo: (u) => hubUrl() + '/api/wallpapers/video?u=' + encodeURIComponent(u) + (token() ? '&token=' + encodeURIComponent(token()) : ''),
      // Movie/episode via the hub (which extracts the subtitles from the stream) and what it has extracted so far.
      streamUrl: (u) => hubUrl() + '/api/stream?u=' + encodeURIComponent(u) + (token() ? '&token=' + encodeURIComponent(token()) : ''),
      subs: (u, track, after) => get('/api/subs', { u, track: track >= 0 ? track : '', after: after || 0 }, { timeout: 6000 }),
      eventsUrl: () => hubUrl() + '/api/events' + (token() ? '?token=' + encodeURIComponent(token()) : '')
    };
  })();

  // --- Direct to Xtream -----------------------------------------------------------------------

  const directUrl = {
    // In the browser the demo provider's streams are played from the dev server's test clips.
    live(id) {
      const X = IPTV.xtream;
      if (!X) return '';
      if (!TV.isTV && X.isDemo()) return '/__mock/stream/' + id + '.mp4';
      return X.liveUrl(id);
    },
    vod(id, ext) {
      const X = IPTV.xtream;
      if (!TV.isTV && X.isDemo()) return '/__mock/vod/' + id + '.mp4';
      return X.vodUrl(id, ext);
    },
    episode(id, ext) {
      const X = IPTV.xtream;
      if (!TV.isTV && X.isDemo()) return '/__mock/vod/' + id + '.mp4';
      return X.episodeUrl(id, ext);
    }
  };

  const direct = (function () {
    const X = () => IPTV.xtream;
    const L = (k) => Store.get('iptv.local.' + k);
    const setL = (k, v) => Store.set('iptv.local.' + k, v);
    const raw = (id) => String(id).split(':').pop();
    const TTL = 10 * 60 * 1000;
    const cache = {}; // key -> { at, promise }
    const epgLimit = limiter(2); // careful: panels block IP addresses that send too many requests

    function cached(key, fn, ttl) {
      const e = cache[key];
      if (e && Date.now() - e.at < (ttl || TTL)) return e.promise;
      const promise = fn().catch((err) => { delete cache[key]; throw err; });
      cache[key] = { at: Date.now(), promise };
      return promise;
    }

    const LIVE_PICK = ['stream_id', 'name', 'stream_icon', 'category_id', 'num', 'epg_channel_id', 'tv_archive'];
    const VOD_PICK = ['stream_id', 'name', 'title', 'year', 'stream_icon', 'category_id', 'rating', 'added', 'container_extension'];
    const SERIES_PICK = ['series_id', 'name', 'title', 'year', 'cover', 'category_id', 'rating', 'last_modified', 'backdrop_path', 'releaseDate'];

    function channel(s) {
      return {
        id: 'x:' + s.stream_id,
        playlistId: 'x',
        streamId: num(s.stream_id),
        name: String(s.name || '').trim(),
        logo: s.stream_icon || '',
        num: s.num != null && s.num !== '' ? num(s.num) : null,
        categoryId: 'x:c:' + s.category_id,
        epgId: s.epg_channel_id || '',
        url: directUrl.live(s.stream_id),
        catchup: !!num(s.tv_archive)
      };
    }

    function movie(s) {
      const t = cleanTitle(s.title || s.name, s.year);
      return {
        id: 'x:' + s.stream_id,
        title: t.title,
        year: t.year,
        poster: s.stream_icon || '',
        backdrop: '',
        rating: num(s.rating) || null,
        added: num(s.added),
        categoryId: 'x:c:' + s.category_id,
        ext: s.container_extension || 'mp4'
      };
    }

    function show(s) {
      const t = cleanTitle(s.title || s.name, s.year || String(s.releaseDate || '').slice(0, 4));
      return {
        id: 'x:' + s.series_id,
        title: t.title,
        year: t.year,
        poster: s.cover || '',
        backdrop: firstOf(s.backdrop_path),
        rating: num(s.rating) || null,
        added: num(s.last_modified),
        categoryId: 'x:c:' + s.category_id
      };
    }

    // Categories in the user's order, without hidden ones.
    function curate(kind, cats) {
      const order = L('catOrder.' + kind) || [];
      const hidden = L('catHidden.' + kind) || [];
      const list = (cats || []).map((c) => ({ id: 'x:c:' + c.category_id, name: String(c.category_name || '').trim(), count: null }));
      const pos = (id) => {
        const i = order.indexOf(id);
        return i < 0 ? 1e6 : i;
      };
      return list
        .map((c, i) => ({ c, i }))
        .sort((a, b) => pos(a.c.id) - pos(b.c.id) || a.i - b.i)
        .map((x) => x.c)
        .filter((c) => hidden.indexOf(c.id) < 0);
    }

    const rawCats = (kind) => cached('cats:' + kind, () => {
      const action = kind === 'live' ? 'get_live_categories' : kind === 'vod' ? 'get_vod_categories' : 'get_series_categories';
      return X().call(action).then((r) => (Array.isArray(r) ? r : []));
    });

    function bootstrap() {
      if (!X().configured()) return Promise.reject(Object.assign(new Error(tr('source.fillIn')), { friendly: true, setup: true }));
      return X().login().then((info) => Promise.all([
        rawCats('live'),
        rawCats('vod').catch(() => []),
        rawCats('series').catch(() => [])
      ]).then((r) => {
        const host = X().creds().server.replace(/^https?:\/\//, '');
        return {
          rev: L('rev') || 0,
          playlists: [{ id: 'x', name: host, type: 'xtream', enabled: true, status: { ok: true, info: info.user_info || {} } }],
          live: { categories: curate('live', r[0]), favorites: (L('favorites') || []).map(fixDirectChannel) },
          vod: { categories: curate('vod', r[1]), favorites: (L('mediaFav.vod') || []).slice() },
          series: { categories: curate('series', r[2]), favorites: (L('mediaFav.series') || []).slice() },
          continue: (L('progress') || []).slice().sort((a, b) => b.updated - a.updated)
        };
      }));
    }

    const liveIn = (catId) => cached('live:' + catId, () =>
      X().call('get_live_streams', { category_id: raw(catId) }, { pick: LIVE_PICK, timeout: 45000 }).then((r) => (Array.isArray(r) ? r : []).map(channel)));

    const allLive = () => cached('live:*', () =>
      X().call('get_live_streams', null, { pick: LIVE_PICK, timeout: 90000 }).then((r) => (Array.isArray(r) ? r : []).map(channel)), 30 * 60 * 1000);

    function channels(category) {
      if (category === 'favorites') return Promise.resolve((L('favorites') || []).map(fixDirectChannel));
      return liveIn(category);
    }

    // Xtream's short EPG, base64-encoded.
    function decode(s) {
      if (!s) return '';
      try {
        const bin = atob(String(s));
        try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
      } catch (e) { return String(s); }
    }
    function toMs(ts, str) {
      if (num(ts)) return num(ts) * 1000;
      const t = Date.parse(String(str || '').replace(' ', 'T'));
      return isNaN(t) ? 0 : t;
    }
    function programs(data) {
      return ((data && (data.epg_listings || data.listings)) || [])
        .map((l) => ({
          title: decode(l.title).trim(),
          desc: decode(l.description).trim(),
          start: toMs(l.start_timestamp, l.start),
          end: toMs(l.stop_timestamp || l.end_timestamp, l.end || l.stop)
        }))
        .filter((p) => p.start && p.end > p.start)
        .sort((a, b) => a.start - b.start);
    }
    function nowNextOf(list) {
      const t = Date.now();
      let now = null;
      let next = null;
      list.forEach((p) => {
        if (!now && p.start <= t && t < p.end) now = p;
        else if (p.start >= t && (!next || p.start < next.start)) next = p;
      });
      return { now, next };
    }

    function epg(ids) {
      const out = {};
      return Promise.all(ids.map((id) => epgLimit(() =>
        X().call('get_short_epg', { stream_id: raw(id), limit: 6 }, { timeout: 12000 })
          .then((d) => { out[id] = nowNextOf(programs(d)); }, () => { out[id] = { now: null, next: null }; })
      ))).then(() => out);
    }

    function guide(id) {
      return X().call('get_short_epg', { stream_id: raw(id), limit: 30 }, { timeout: 15000 }).then(programs);
    }

    // Guide without the hub: the day's programmes per channel, a few at a time (providers block anyone who "floods").
    function grid(q) {
      const from = q.from || Date.now() - 30 * 60000;
      const to = from + (q.hours || 3) * 3600000;
      const offset = q.offset || 0;
      return channels(q.category).then((all) => {
        const list = all.slice(offset, offset + (q.limit || 20));
        const programs = {};
        return Promise.all(list.map((c) => epgLimit(() => guide(c.id).then(
          (items) => { programs[c.id] = items.filter((x) => x.end > from && x.start < to); },
          () => { programs[c.id] = []; }
        )))).then(() => ({ from, to, total: all.length, channels: list, programs }));
      });
    }

    // --- Movies and series

    const vodIn = (catId) => cached('vod:' + catId, () =>
      X().call('get_vod_streams', catId === '*' ? null : { category_id: raw(catId) }, { pick: VOD_PICK, timeout: 90000 })
        .then((r) => (Array.isArray(r) ? r : []).map(movie)), catId === '*' ? 30 * 60 * 1000 : TTL);

    const seriesIn = (catId) => cached('series:' + catId, () =>
      X().call('get_series', catId === '*' ? null : { category_id: raw(catId) }, { pick: SERIES_PICK, timeout: 90000 })
        .then((r) => (Array.isArray(r) ? r : []).map(show)), catId === '*' ? 30 * 60 * 1000 : TTL);

    function visibleIds(kind) {
      return rawCats(kind).then((c) => curate(kind, c).map((x) => x.id));
    }

    function page(listP, q, kind) {
      q = q || {};
      const offset = num(q.offset);
      const limit = num(q.limit) || 60;
      return listP.then((list) => {
        let items = list;
        if (q.category === 'recent') {
          return visibleIds(kind).then((ids) => {
            items = list.filter((m) => ids.indexOf(m.categoryId) >= 0).slice().sort((a, b) => b.added - a.added);
            return { total: items.length, items: items.slice(offset, offset + limit) };
          });
        }
        if (q.sort === 'added') items = list.slice().sort((a, b) => b.added - a.added);
        else if (q.sort === 'name') items = list.slice().sort((a, b) => a.title.localeCompare(b.title, I18n.locale));
        else if (q.sort === 'rating') items = list.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0));
        return { total: items.length, items: items.slice(offset, offset + limit) };
      });
    }

    const vodList = (q) => page(vodIn(q && q.category && q.category !== 'recent' ? q.category : '*'), q, 'vod');
    const seriesList = (q) => page(seriesIn(q && q.category && q.category !== 'recent' ? q.category : '*'), q, 'series');

    function vodInfo(id) {
      return X().call('get_vod_info', { vod_id: raw(id) }, { timeout: 20000 }).then((r) => {
        const i = (r && r.info) || {};
        const d = (r && r.movie_data) || {};
        const t = cleanTitle(i.name || d.name, String(i.releasedate || i.release_date || '').slice(0, 4));
        const ext = d.container_extension || 'mp4';
        return {
          id: 'x:' + (d.stream_id || raw(id)),
          title: t.title,
          year: t.year,
          poster: i.cover_big || i.movie_image || '',
          backdrop: firstOf(i.backdrop_path),
          rating: num(i.rating) || null,
          added: num(d.added),
          categoryId: d.category_id ? 'x:c:' + d.category_id : null,
          duration: parseDuration(i.duration_secs, i.duration),
          plot: i.plot || i.description || '',
          genre: i.genre || '',
          cast: i.cast || i.actors || '',
          director: i.director || '',
          trailer: i.youtube_trailer || '',
          url: directUrl.vod(d.stream_id || raw(id), ext)
        };
      });
    }

    function seriesInfo(id) {
      return X().call('get_series_info', { series_id: raw(id) }, { timeout: 25000 }).then((r) => {
        const i = (r && r.info) || {};
        const t = cleanTitle(i.name || i.title, i.year || String(i.releaseDate || i.release_date || '').slice(0, 4));
        const seasonsMeta = {};
        ((r && r.seasons) || []).forEach((s) => { seasonsMeta[String(s.season_number)] = s; });
        const eps = (r && r.episodes) || {};
        const seasons = Object.keys(eps)
          .sort((a, b) => num(a) - num(b))
          .map((key) => {
            const meta = seasonsMeta[key] || {};
            return {
              season: num(key),
              name: meta.name || tr('source.season', { season: key }),
              episodes: (eps[key] || []).map((e) => {
                const info = e.info || {};
                let title = String(e.title || '').trim();
                // "Series – S01E02 – Title" -> "Title"
                const m = /S\d{1,2}\s*E\d{1,3}\s*[-–:]\s*(.+)$/i.exec(title);
                if (m) title = m[1].trim();
                return {
                  id: 'x:e:' + e.id,
                  season: num(e.season || key),
                  episode: num(e.episode_num),
                  title: title || tr('source.episode', { episode: e.episode_num }),
                  plot: info.plot || '',
                  duration: parseDuration(info.duration_secs, info.duration),
                  still: info.movie_image || '',
                  url: directUrl.episode(e.id, e.container_extension || 'mp4')
                };
              }).sort((a, b) => a.episode - b.episode)
            };
          });
        return {
          id: 'x:' + raw(id),
          title: t.title,
          year: t.year,
          poster: i.cover || '',
          backdrop: firstOf(i.backdrop_path),
          rating: num(i.rating) || null,
          plot: i.plot || '',
          genre: i.genre || '',
          cast: i.cast || '',
          director: i.director || '',
          seasons
        };
      });
    }

    // --- Search (loads the full lists once, with only the fields that are needed)

    const folded = new WeakMap(); // item -> folded name

    function search(q, opts) {
      const f = fold(q);
      const limit = (opts && opts.limit) || 30;
      if (!f) return Promise.resolve({ live: [], vod: [], series: [] });
      const words = f.split(' ');
      const score = (x, name) => {
        // Folded names are computed once per item (the lists can have 100,000 items).
        let n = folded.get(x);
        if (n == null) { n = fold(name); folded.set(x, n); }
        if (!words.every((w) => n.indexOf(w) >= 0)) return -1;
        if (n === f) return 0;
        if (n.indexOf(f) === 0) return 1;
        if ((' ' + n).indexOf(' ' + words[0]) >= 0) return 2;
        return 3;
      };
      const rank = (list, nameOf) => list
        .map((x) => ({ x, s: score(x, nameOf(x)) }))
        .filter((r) => r.s >= 0)
        .sort((a, b) => a.s - b.s || nameOf(a.x).length - nameOf(b.x).length)
        .slice(0, limit)
        .map((r) => r.x);
      return Promise.all([
        Promise.all([allLive(), visibleIds('live')]).then((r) => {
          const favs = (L('favorites') || []).map(fixDirectChannel);
          const all = opts && opts.all;
          const pool = favs.concat(r[0].filter((c) => all || r[1].indexOf(c.categoryId) >= 0));
          const seen = {};
          return rank(pool.filter((c) => (seen[c.id] ? false : (seen[c.id] = true))), (c) => c.name);
        }).catch(() => []),
        vodIn('*').then((l) => rank(l, (m) => m.title)).catch(() => []),
        seriesIn('*').then((l) => rank(l, (s) => s.title)).catch(() => [])
      ]).then((r) => ({ live: r[0], vod: r[1], series: r[2] }));
    }

    // --- Selection (stored on the TV)

    const bump = () => setL('rev', (L('rev') || 0) + 1);

    function toggleFavorite(id, ch) {
      const list = (L('favorites') || []).slice();
      const i = list.findIndex((c) => String(c.id) === String(id));
      if (i >= 0) list.splice(i, 1);
      else if (ch) list.push(minimal(ch));
      setL('favorites', list);
      bump();
      return Promise.resolve({ rev: L('rev'), favorite: i < 0 });
    }

    // Favourite movies/series (stored on the TV in direct mode).
    function toggleMediaFavorite(kind, id, item) {
      const key = 'mediaFav.' + kind;
      const list = (L(key) || []).slice();
      const i = list.findIndex((x) => String(x.id) === String(id));
      if (i >= 0) list.splice(i, 1);
      else if (item) list.unshift(item);
      setL(key, list);
      bump();
      return Promise.resolve({ rev: L('rev'), favorite: i < 0 });
    }

    function moveFavorite(id, delta) {
      const list = (L('favorites') || []).slice();
      moveIn(list, (c) => c.id, id, delta);
      setL('favorites', list);
      bump();
      return Promise.resolve({ rev: L('rev') });
    }

    function moveCategory(kind, id, delta) {
      return rawCats(kind).then((cats) => {
        const visible = curate(kind, cats).map((c) => c.id);
        const order = (L('catOrder.' + kind) || []).filter((x) => visible.indexOf(x) >= 0);
        visible.forEach((x) => { if (order.indexOf(x) < 0) order.push(x); });
        moveIn(order, (x) => x, id, delta);
        setL('catOrder.' + kind, order);
        bump();
        return { rev: L('rev') };
      });
    }

    function hideCategory(kind, id) {
      const hidden = (L('catHidden.' + kind) || []).slice();
      if (hidden.indexOf(id) < 0) hidden.push(id);
      setL('catHidden.' + kind, hidden);
      bump();
      return Promise.resolve({ rev: L('rev') });
    }

    // All categories (including hidden ones) – for the settings page in direct mode.
    function allCategories(kind) {
      const hidden = L('catHidden.' + kind) || [];
      return rawCats(kind).then((cats) => cats.map((c) => {
        const id = 'x:c:' + c.category_id;
        return { id, name: String(c.category_name || '').trim(), visible: hidden.indexOf(id) < 0 };
      }));
    }

    function setHidden(kind, ids) {
      setL('catHidden.' + kind, ids.slice());
      bump();
    }

    function progress(p) {
      const list = (L('progress') || []).filter((x) => String(x.id) !== String(p.id));
      if (!(p.duration && p.position / p.duration >= 0.95)) list.unshift(Object.assign({}, p, { updated: Date.now() }));
      setL('progress', list.slice(0, 40));
      return Promise.resolve({ ok: true });
    }

    function clear() {
      Object.keys(cache).forEach((k) => delete cache[k]);
    }

    // Catch-up directly against Xtream: the start time in the provider's time zone (server_info.timezone).
    function catchup(ch, prog) {
      return X().login().then((info) => {
        const tz = (info && info.server_info && info.server_info.timezone) || 'UTC';
        const start = prog.start - 2 * 60000;
        const end = Math.min(prog.end + 5 * 60000, Date.now());
        const mins = Math.max(1, Math.ceil((end - start) / 60000));
        let parts;
        try {
          parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(start));
        } catch (e) {
          parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(start));
        }
        const v = {};
        parts.forEach((x) => { v[x.type] = x.value; });
        const c = X().creds();
        const sid = ch.streamId || raw(ch.id);
        if (!TV.isTV && X().isDemo()) return '/__mock/vod/' + sid + '.mp4';
        return c.server + '/timeshift/' + encodeURIComponent(c.username) + '/' + encodeURIComponent(c.password) + '/' + mins + '/' +
          v.year + '-' + v.month + '-' + v.day + ':' + v.hour + '-' + v.minute + '/' + sid + '.ts';
      });
    }

    return {
      kind: 'direct',
      epgSearch: () => Promise.resolve([]),
      catchup,
      bootstrap, channels, epg, guide, grid, vodList, vodInfo, seriesList, seriesInfo, search,
      toggleFavorite, toggleMediaFavorite, moveFavorite, moveCategory, hideCategory, progress, allCategories, setHidden, clear,
      img: (url) => url || ''
    };
  })();

  // Minimal channel object to store (favourites, recently watched).
  function minimal(ch) {
    return {
      id: ch.id,
      playlistId: ch.playlistId || null,
      streamId: ch.streamId || null,
      name: ch.name,
      logo: ch.logo || '',
      num: ch.num != null ? ch.num : null,
      categoryId: ch.categoryId || null,
      epgId: ch.epgId || '',
      url: ch.url || '',
      catchup: !!ch.catchup
    };
  }

  // --- State -------------------------------------------------------------------------------

  const S = {
    boot: null,         // latest bootstrap
    parts: null,        // signature per part (see partsOf) – so that only real changes are announced
    loadedAt: 0,        // latest successful fetch
    status: 'idle',     // idle | loading | ok | error
    error: null,
    key: '',            // which source the boot belongs to
    loading: null,
    retryTimer: null,
    retryDelay: 0
  };

  const active = () => (mode() === 'hub' ? hub : direct);
  const sourceKey = () => {
    if (mode() === 'hub') return 'hub|' + hubUrl();
    const c = IPTV.xtream ? IPTV.xtream.creds() : {};
    return 'direct|' + c.server + '|' + c.username;
  };

  function configured() {
    if (mode() === 'hub') return !!hubUrl();
    return !!(IPTV.xtream && IPTV.xtream.configured());
  }

  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      return c && c.key === sourceKey() ? c.boot : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ key: S.key, boot: S.boot }));
    } catch (e) { /* full – ignore it */ }
  }

  function emptyBoot() {
    return { rev: 0, playlists: [], live: { categories: [], favorites: [] }, vod: { categories: [], favorites: [] }, series: { categories: [], favorites: [] }, continue: [], positions: {} };
  }

  // Signature per part of the bootstrap. What the home screen and the TV view show – plus rev, which the hub
  // increments when the catalogue or the selection has changed (then the channel lists may have new content).
  function partsOf(b) {
    return {
      rev: String(b.rev),
      live: JSON.stringify([b.live.categories, b.live.favorites]),
      media: JSON.stringify([b.vod, b.series]),
      cont: JSON.stringify([b.continue, b.positions]),
      lists: JSON.stringify((b.playlists || []).map((p) => [p.id, p.name, p.enabled, !!(p.status && p.status.ok), (p.status && p.status.error) || '']))
    };
  }

  // Switch to a new bootstrap. Only notifies if something has actually changed (or force), so that an
  // unchanged reload (returning to the app, poll, SSE) does not rebuild the home screen and the TV view.
  // Returns true if something changed.
  function apply(boot, reason, force) {
    const b = Object.assign(emptyBoot(), boot || {});
    b.live = Object.assign({ categories: [], favorites: [] }, b.live || {});
    b.vod = Object.assign({ categories: [], favorites: [] }, b.vod || {});
    b.series = Object.assign({ categories: [], favorites: [] }, b.series || {});
    b.continue = b.continue || [];
    b.positions = b.positions || {};
    const parts = partsOf(b);
    const prev = S.parts;
    S.boot = b;
    S.parts = parts;
    const changed = prev ? Object.keys(parts).filter((k) => parts[k] !== prev[k]) : Object.keys(parts);
    if (!changed.length && !force) return false;
    mirrorFavorites();
    // Only Continue watching/positions: a narrower reason (the TV view does not need to reload channel lists).
    const only = changed.length === 1 ? changed[0] : '';
    IPTV.emit('change', only === 'cont' && !force ? 'continue' : reason || 'bootstrap');
    return true;
  }

  // Reasons the TV view must always be told about (source switched, the user asked for it, catalogue changed).
  const FORCE = { config: 1, manual: 1, catalog: 1, playlists: 1 };

  function load(reason) {
    clearTimeout(S.retryTimer);
    if (!configured()) {
      S.status = 'idle';
      S.error = null;
      S.key = sourceKey();
      apply(emptyBoot(), reason || 'config', true);
      return Promise.resolve(S.boot);
    }
    if (S.loading) {
      // A change arrived while a fetch was in progress: fetch once more afterwards (the one in progress may
      // have started before the change). The stronger reason wins.
      if (reason && reason !== 'visible' && reason !== 'poll' && (!S.again || FORCE[reason])) S.again = reason;
      return S.loading;
    }
    const key = sourceKey();
    if (S.key !== key) {
      S.key = key;
      S.parts = null;
      const c = readCache();
      apply(c || emptyBoot(), 'cache', true);
    }
    S.status = S.boot && S.boot.rev != null && S.status === 'ok' ? 'ok' : 'loading';
    const src = active();
    // The hub: send the hash of what we already have (not for an empty/new source).
    const since = src === hub && S.boot && S.boot.hash && !FORCE[reason] ? S.boot.hash : null;
    S.loading = src.bootstrap(since)
      .then((boot) => {
        S.loading = null;
        if (sourceKey() !== key) return S.boot;
        const wasOk = S.status === 'ok';
        S.status = 'ok';
        S.error = null;
        S.retryDelay = 0;
        S.loadedAt = Date.now();
        if (boot !== SAME && apply(boot, reason || 'bootstrap', !!FORCE[reason])) writeCache();
        if (!wasOk) IPTV.emit('status', 'ok');
        if (S.again) {
          const again = S.again;
          S.again = null;
          setTimeout(() => load(again), 0);
        }
        return S.boot;
      })
      .catch((err) => {
        S.loading = null;
        S.again = null;
        S.status = 'error';
        S.error = err;
        IPTV.emit('status', 'error');
        console.warn('[iptv] bootstrap failed:', err && err.message);
        // Try again with an increasing pause (the hub may restart, the network may come back).
        if (!(err && err.setup)) {
          S.retryDelay = Math.min(300000, S.retryDelay ? S.retryDelay * 2 : 20000);
          S.retryTimer = setTimeout(() => load('retry'), S.retryDelay);
        }
        return S.boot;
      });
    return S.loading;
  }

  // Reload only the bootstrap (e.g. after a change in the web admin). The hub's reason is passed on, so that
  // a new catalogue always reaches the TV view (the channel lists' content is not visible in the bootstrap).
  let remoteReason = '';
  const reloadSoon = u.debounce(() => {
    const r = remoteReason;
    remoteReason = '';
    load(r === 'catalog' || r === 'playlists' ? r : 'remote');
  }, 250);

  // --- Live updates from the hub (SSE) --------------------------------------------------------

  let es = null;
  let esUrl = '';
  function connectEvents() {
    const want = mode() === 'hub' && configured() && !document.hidden && typeof EventSource !== 'undefined' ? hub.eventsUrl() : '';
    if (want === esUrl) return;
    if (es) { try { es.close(); } catch (e) { /* ignore */ } }
    es = null;
    esUrl = want;
    if (!want) return;
    try {
      es = new EventSource(want);
      es.addEventListener('rev', (e) => {
        let d = {};
        try { d = JSON.parse(e.data) || {}; } catch (x) { /* ignore */ }
        if (d.reason === 'catalog' || d.reason === 'playlists') remoteReason = d.reason;
        if (!S.boot || d.rev !== S.boot.rev) reloadSoon();
      });
      // Continue watching changed (e.g. on another device): the bootstrap has the list. Not while something is
      // playing here – then it is the TV's own saves (every 10 s) echoing back.
      es.addEventListener('continue', () => {
        if (IPTV.player && IPTV.player.current()) return;
        reloadSoon();
      });
      es.onopen = () => { if (S.status === 'error') load('reconnect'); };
    } catch (e) {
      es = null;
    }
  }

  // Fallback if SSE does not work: refetch every five minutes (hub without an open SSE) or every 30
  // (direct mode – every bootstrap means requests to the provider).
  const sseOpen = () => !!(es && es.readyState === 1);
  setInterval(() => {
    if (!configured() || document.hidden || S.loading || sseOpen()) return;
    if (mode() === 'direct' && Date.now() - S.loadedAt < 30 * 60 * 1000) return;
    load('poll');
  }, 5 * 60 * 1000);

  // Back in the app: the hub answers cheaply ({ same }) if nothing has changed; direct mode asks
  // the provider at most every ten minutes.
  document.addEventListener('visibilitychange', () => {
    connectEvents();
    if (document.hidden || !configured() || S.status === 'loading') return;
    if (mode() === 'direct' && S.status === 'ok' && Date.now() - S.loadedAt < 10 * 60 * 1000) return;
    load('visible');
  });

  // --- Favourites -----------------------------------------------------------------------------

  const favorites = () => (S.boot ? S.boot.live.favorites.slice() : []);
  const isFavorite = (id) => favorites().some((c) => String(c.id) === String(id));

  // Local changes (before the source has answered): update the signature too, otherwise the next
  // bootstrap with the same content counts as a change.
  function touched() {
    if (S.boot) {
      S.parts = partsOf(S.boot);
      // What we show now differs from the hub's version – the next fetch must be a full one (no since),
      // so that a change that failed at the hub is rolled back.
      S.boot.hash = null;
    }
    writeCache();
  }

  function setFavorites(list, reason) {
    S.boot.live.favorites = list;
    mirrorFavorites();
    touched();
    IPTV.emit('change', reason || 'favorites');
  }

  function toggleFavorite(ch) {
    if (!ch || !S.boot) return Promise.resolve(false);
    const list = favorites();
    const i = list.findIndex((c) => String(c.id) === String(ch.id));
    const adding = i < 0;
    if (adding) list.push(minimal(ch)); else list.splice(i, 1);
    setFavorites(list);
    return active().toggleFavorite(ch.id, ch).then((r) => {
      if (S.boot && r && r.rev != null) S.boot.rev = r.rev;
      return adding;
    }, (err) => {
      UI.toast(tr('source.favSaveFailed', { error: err.message }), 5000);
      load('favorites');
      return !adding;
    });
  }

  function moveFavorite(id, delta) {
    const list = favorites();
    if (!moveIn(list, (c) => c.id, id, delta)) return Promise.resolve(false);
    setFavorites(list);
    return active().moveFavorite(id, delta).then(() => true, (err) => {
      UI.toast(tr('source.moveFailed', { error: err.message }), 5000);
      load('favorites');
      return false;
    });
  }

  // --- Favourite movies and series -------------------------------------------------------------

  const mediaFavorites = (kind) => (S.boot && S.boot[kind] && S.boot[kind].favorites ? S.boot[kind].favorites.slice() : []);
  const isMediaFavorite = (kind, id) => mediaFavorites(kind).some((x) => String(x.id) === String(id));

  // item = { id, title, year, poster, backdrop, rating, … } (what is shown on the shelf)
  function toggleMediaFavorite(kind, item) {
    if (!item || !S.boot || !S.boot[kind]) return Promise.resolve(false);
    const list = mediaFavorites(kind);
    const i = list.findIndex((x) => String(x.id) === String(item.id));
    const adding = i < 0;
    const slim = { id: item.id, title: item.title, year: item.year || null, poster: item.poster || '', backdrop: item.backdrop || '', rating: item.rating || null, categoryId: item.categoryId || null };
    if (adding) list.unshift(slim); else list.splice(i, 1);
    S.boot[kind].favorites = list;
    touched();
    IPTV.emit('change', 'mediaFavorites');
    const a = active();
    if (!a.toggleMediaFavorite) return Promise.resolve(adding);
    return a.toggleMediaFavorite(kind, item.id, slim).then((r) => {
      if (S.boot && r && r.rev != null) S.boot.rev = r.rev;
      return adding;
    }, (err) => {
      UI.toast(tr('source.favSaveFailed', { error: err.message }), 5000);
      load('mediaFavorites');
      return !adding;
    });
  }

  // --- Categories -----------------------------------------------------------------------------

  const categories = (kind) => (S.boot && S.boot[kind] ? S.boot[kind].categories.slice() : []);

  function moveCategory(kind, id, delta) {
    const list = categories(kind);
    if (!moveIn(list, (c) => c.id, id, delta)) return Promise.resolve(false);
    S.boot[kind].categories = list;
    touched();
    IPTV.emit('change', 'categories');
    return active().moveCategory(kind, id, delta).then(() => true, (err) => {
      UI.toast(tr('source.moveCategoryFailed', { error: err.message }), 5000);
      load('categories');
      return false;
    });
  }

  function hideCategory(kind, id) {
    S.boot[kind].categories = categories(kind).filter((c) => String(c.id) !== String(id));
    touched();
    IPTV.emit('change', 'categories');
    return active().hideCategory(kind, id).then(() => true, (err) => {
      UI.toast(tr('source.hideCategoryFailed', { error: err.message }), 5000);
      load('categories');
      return false;
    });
  }

  // --- Continue watching ---------------------------------------------------------------------

  const continueWatching = () => (S.boot ? S.boot.continue.slice() : []);
  // Where you were in each movie and episode. The TV's own record (written every 10 s) takes precedence over the hub's.
  const POS_KEY = 'iptv.pos';          // (older: lived in the settings)
  const POS_STORE = 'g3:iptv:pos:v1';   // now: its own key – written every 10 s during playback
  const POS_MAX = 800;
  let posMap = null;
  let posTimer = null;

  function positions() {
    if (posMap) return posMap;
    try { posMap = JSON.parse(localStorage.getItem(POS_STORE)) || null; } catch (e) { posMap = null; }
    if (!posMap) {
      posMap = Object.assign({}, Store.get(POS_KEY) || {});
      if (Object.keys(posMap).length) {
        savePositions(true);
        Store.set(POS_KEY, null);
      }
    }
    return posMap;
  }

  function savePositions(now) {
    clearTimeout(posTimer);
    const write = () => { try { localStorage.setItem(POS_STORE, JSON.stringify(posMap || {})); } catch (e) { /* full */ } };
    if (now) write();
    else posTimer = setTimeout(write, 1500);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && posTimer) savePositions(true); });
  const unfinished = (pos, dur) => pos >= 10 && (!dur || pos / dur < 0.95);

  function progressFor(id) {
    const k = String(id);
    const cont = continueWatching().find((p) => String(p.id) === k) || null;
    const loc = positions()[k];
    const hub = S.boot && S.boot.positions ? S.boot.positions[k] : null;
    let pos = null;
    let dur = 0;
    if (loc) { pos = loc[0]; dur = loc[1]; } else if (hub) { pos = hub[0]; dur = hub[1]; } else if (cont) { pos = cont.position; dur = cont.duration; }
    if (pos == null || !unfinished(pos, dur)) return null;
    return Object.assign({}, cont || { id: k }, { position: pos, duration: dur || (cont && cont.duration) || 0 });
  }

  function rememberPosition(p, final) {
    const map = positions();
    const k = String(p.id);
    if (p.duration > 0 && p.position / p.duration >= 0.95) delete map[k];
    else if (p.position >= 10) map[k] = [Math.round(p.position), Math.round(p.duration || 0), Date.now()];
    else return;
    const keys = Object.keys(map);
    if (keys.length > POS_MAX) keys.sort((a, b) => map[a][2] - map[b][2]).slice(0, keys.length - POS_MAX).forEach((x) => delete map[x]);
    savePositions(!!final);
  }

  // p = { id, kind:'vod'|'episode', seriesId?, title, poster, backdrop, position, duration, … }
  function saveProgress(p, opts) {
    if (!p || !p.id) return Promise.resolve();
    const final = !!(opts && opts.final);
    rememberPosition(p, final);
    if (!S.boot) return Promise.resolve();
    const done = p.duration > 0 && p.position / p.duration >= 0.95;
    const before = continueWatching().map((x) => x.id).join('|');
    let list = continueWatching().filter((x) => String(x.id) !== String(p.id));
    // An episode replaces earlier episodes of the same series.
    if (p.seriesId) list = list.filter((x) => String(x.seriesId || '') !== String(p.seriesId));
    if (!done && p.position > 20) list.unshift(Object.assign({}, p, { updated: Date.now() }));
    S.boot.continue = list.slice(0, 40);
    // The bootstrap cache (the whole selection) is only written when the list has changed or playback has ended –
    // not every 10 seconds (the position is in POS_STORE and at the hub).
    const reordered = before !== list.map((x) => x.id).join('|');
    if (reordered || final) writeCache();
    if (reordered || final) IPTV.emit('change', 'continue');
    const body = {
      id: p.id, kind: p.kind, seriesId: p.seriesId || null,
      position: Math.round(p.position), duration: Math.round(p.duration || 0),
      title: p.title || '', poster: p.poster || '', backdrop: p.backdrop || '',
      season: p.season || null, episode: p.episode || null, seriesTitle: p.seriesTitle || ''
    };
    return active().progress(body).catch((e) => console.warn('[iptv] progress', e && e.message));
  }

  // --- Recently watched / last channel ----------------------------------------------------------

  function fixStored(ch) {
    if (!ch) return null;
    return /^\d+$/.test(String(ch.id)) || (String(ch.id).indexOf('x:') === 0 && mode() === 'direct') ? fixDirectChannel(ch) : ch;
  }

  const lastChannel = () => fixStored(Store.get('iptv.lastChannel'));
  const recent = () => (Store.get('iptv.recent') || []).map(fixStored).filter(Boolean);

  function remember(ch) {
    if (!ch) return;
    const m = minimal(ch);
    Store.set('iptv.lastChannel', m);
    const list = recent().filter((c) => String(c.id) !== String(ch.id));
    list.unshift(m);
    Store.set('iptv.recent', list.slice(0, 20));
  }

  // --- Compatibility with the v2 home screen (Store 'favorites.channels') ---------------------

  let mirroring = false;
  function mirrorFavorites() {
    const now = JSON.stringify(favorites().map(minimal));
    if (JSON.stringify(Store.get('favorites.channels') || []) === now) return;
    mirroring = true;
    try { Store.set('favorites.channels', JSON.parse(now)); } finally { mirroring = false; }
  }

  // --- Changed settings -----------------------------------------------------------------------

  let started = false;
  Store.on((path) => {
    if (!started) return;
    if (path === 'favorites.channels' && !mirroring && S.boot) {
      // Someone else (an older home screen) changed the list – carry it over to the source.
      const theirs = Store.get('favorites.channels') || [];
      const mine = favorites();
      const ids = (l) => l.map((c) => String(c.id));
      theirs.filter((c) => ids(mine).indexOf(String(c.id)) < 0).forEach((c) => toggleFavorite(c));
      mine.filter((c) => ids(theirs).indexOf(String(c.id)) < 0).forEach((c) => toggleFavorite(c));
      return;
    }
    if (path === '*' || path === 'iptv' || path === 'iptv.mode' || /^iptv\.(hub|direct)/.test(path)) {
      if (direct.clear) direct.clear();
      if (IPTV.epg && IPTV.epg.clear) IPTV.epg.clear();
      S.key = '';
      reloadConfig();
    }
  });

  const reloadConfig = u.debounce(() => {
    connectEvents();
    load('config');
  }, 400);

  // --- Connection test (settings) --------------------------------------------------------------

  function test() {
    if (mode() === 'hub') {
      return hub.health().then((h) => hub.bootstrap().then((b) => ({ mode: 'hub', health: h, boot: b })));
    }
    return IPTV.xtream.login().then((info) => direct.bootstrap().then((b) => ({ mode: 'direct', info, boot: b })));
  }

  // --- Start -------------------------------------------------------------------------------------

  migrate();
  started = true;

  // The source the TV view and search use. The methods delegate to the active mode.
  const source = {};
  ['epg', 'guide', 'grid', 'vodList', 'vodInfo', 'seriesList', 'seriesInfo', 'search', 'progress', 'epgSearch', 'catchup'].forEach((m) => {
    source[m] = function () { const a = active(); return a[m].apply(a, arguments); };
  });

  // Channel lists per category: one shared cache for the Live tab, the channel list in full screen and
  // the guide (previously each fetched its own copy). Cleared when the catalogue/selection changes.
  const CH_TTL = 10 * 60 * 1000;
  const chCache = {};
  source.channels = (cat) => {
    if (cat === 'favorites') return active().channels(cat);
    const key = S.key + '|' + cat;
    const e = chCache[key];
    if (e && Date.now() - e.at < CH_TTL) return e.promise;
    const promise = active().channels(cat).catch((err) => { delete chCache[key]; throw err; });
    chCache[key] = { at: Date.now(), promise };
    return promise;
  };
  IPTV.onChange((reason) => {
    if (reason === 'continue' || reason === 'favorites' || reason === 'mediaFavorites') return;
    Object.keys(chCache).forEach((k) => delete chCache[k]);
  });
  source.bootstrap = () => load('manual');
  source.img = (url, w) => active().img(url, w);
  source.kind = () => mode();
  source.toggleFavorite = (id) => toggleFavorite(favorites().find((c) => String(c.id) === String(id)) || { id });
  source.moveFavorite = moveFavorite;
  source.moveCategory = moveCategory;
  source.hideCategory = hideCategory;
  source.hub = hub;
  source.direct = direct;

  IPTV.source = source;
  IPTV.mode = mode;
  IPTV.hubUrl = hubUrl;
  IPTV.normalizeHub = normalizeHub;
  IPTV.configured = configured;
  IPTV.status = () => ({ state: S.status, error: S.error, mode: mode(), boot: S.boot });
  IPTV.boot = () => S.boot;
  IPTV.categories = categories;
  IPTV.favorites = favorites;
  IPTV.isFavorite = isFavorite;
  IPTV.toggleFavorite = toggleFavorite;
  IPTV.moveFavorite = moveFavorite;
  IPTV.moveCategory = moveCategory;
  IPTV.hideCategory = hideCategory;
  IPTV.continueWatching = continueWatching;
  IPTV.progressFor = progressFor;
  IPTV.mediaFavorites = mediaFavorites;
  IPTV.isMediaFavorite = isMediaFavorite;
  IPTV.toggleMediaFavorite = toggleMediaFavorite;
  IPTV.saveProgress = saveProgress;
  IPTV.lastChannel = lastChannel;
  IPTV.recent = recent;
  IPTV.remember = remember;
  IPTV.reload = () => { S.key = ''; return load('manual'); };
  IPTV.test = test;
  IPTV.fold = fold;
  IPTV.minimal = minimal;

  // Catch-up ("watch after broadcast"): past (or ongoing, from the start) programmes on channels where
  // the provider keeps the broadcasts. Played in the movie player (seek, pause), without Continue watching.
  IPTV.catchup = {
    available(ch, prog) {
      const now = Date.now();
      return !!(ch && ch.catchup && prog && prog.start < now && now - prog.start < (ch.catchupDays || 3) * 86400000);
    },
    play(ch, prog) {
      return Promise.all([source.catchup(ch, prog), IPTV.loadUi ? IPTV.loadUi() : null]).then((r) => {
        const url = r[0];
        const d = new Date(prog.start);
        const day = IPTV.reminders ? IPTV.reminders.day(prog.start) : d.toLocaleDateString(I18n.locale);
        IPTV.playback.play({
          id: 'catchup:' + ch.id + ':' + prog.start,
          kind: 'catchup',
          url,
          title: prog.title,
          plot: prog.desc || '',
          kicker: ch.name + ' · ' + day + ' ' + u.time(prog.start),
          duration: Math.round((Math.min(prog.end, Date.now()) - prog.start) / 1000) + 420
        }, { start: 120 });
      }, (e) => UI.toast(tr('source.catchupFailed', { error: e.message }), 5000));
    }
  };

  // Older API (the v2 home screen and the settings page use IPTV.api.*).
  IPTV.api = {
    configured,
    isDemo: () => mode() === 'direct' && !!IPTV.xtream && IPTV.xtream.isDemo(),
    login: () => (mode() === 'direct' ? IPTV.xtream.login() : test().then((r) => ({ user_info: {}, hub: r }))),
    categories: () => Promise.resolve(categories('live')),
    streams: (catId) => source.channels(catId),
    playbackUrl: (ch) => (ch && ch.url) || '',
    loaded: () => Promise.resolve(favorites())
  };

  // Resolve IPTV.ready when the first fetch is done (or after at most 6 s, with the cache).
  S.key = sourceKey();
  if (configured()) apply(readCache() || emptyBoot(), 'cache', true);
  else apply(emptyBoot(), 'config', true);
  IPTV.ready = new Promise((resolve) => {
    const t = setTimeout(resolve, 6000);
    load('start').then(() => { clearTimeout(t); resolve(); });
  });
  connectEvents();
})(window);
