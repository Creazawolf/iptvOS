// The catalogue: every playlist's channels, films and series in memory, with your curation applied.
//
// The raw catalogue per playlist is cached in data/cache/<id>.json and fetched again every `refreshHours`.
// The index is rebuilt when a catalogue has loaded or the curation has changed (a few ms even for 22,000 channels).
//
// Global IDs:  channel/film/series/episode  "<pl>:<id>",  categories  "<pl>:c:<id>" (live),
//              "<pl>:v:<id>" (films), "<pl>:s:<id>" (series).
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hubLang, msg, msgOf, text, tr } from './i18n.mjs';
import { liveUrl, m3uCatalog, xtreamCatalog } from './providers.mjs';
import { KINDS } from './store.mjs';
import { log, norm, stripPrefix, warn, writeAtomic } from './util.mjs';

const CAT_TAG = { live: 'c', vod: 'v', series: 's' };

// Categories shown from the start when a new playlist is loaded (the rest are hidden – 22,000 channels is too many).
const SWEDISH = /(^|[^a-z])(se|sv|swe|sweden|sverige|svensk[a]?|svenska|nordic|norden|scandinavia)([^a-z]|$)/i;
const ENGLISH = /(^|[^a-z])(en|eng|english|uk|gb|us|usa|united kingdom|united states)([^a-z]|$)/i;
// Which categories count as "local" follows the hub's language (Settings › Hub language).
const LOCAL = { sv: SWEDISH, en: ENGLISH };
const localCats = () => LOCAL[hubLang()] || ENGLISH;
const NEWISH = /(nya|new|latest|senaste|recent|popul|top|trending)/i;

// The demo provider's curation (--seed-demo).
const DEMO_CURATION = {
  live: ['SE | SVERIGE HD', 'SE | SPORT', 'SE | NYHETER', 'SE | FILM & SERIER', 'SE | BARN', 'SE | DOKUMENTÄR', 'SPORT | ALLSVENSKAN', 'SPORT | SHL'],
  vod: ['SE | Svenska filmer', 'EN | Nya filmer 2026', 'EN | Action', 'EN | Komedi', 'EN | Drama', 'EN | Thriller', 'EN | Sci-Fi & Fantasy', '4K | UHD-filmer', 'NETFLIX | Filmer', 'SE | Barnfilmer (svenskt tal)'],
  series: ['SE | Svenska serier', 'EN | Drama', 'EN | Kriminal', 'NETFLIX | Serier', 'MAX | Serier', 'NORDIC | Noir', 'EN | Komedi'],
  favorites: ['SVT1 HD', 'SVT2 HD', 'TV4 HD', 'Kanal 5 HD', 'TV3 HD', 'Sjuan', 'TV6', 'SVT24', 'V Sport Fotboll', 'SVT Nyheter']
};

export class Catalog {
  constructor(store, dataDir) {
    this.store = store;
    this.cacheDir = join(dataDir, 'cache');
    this.raw = new Map(); // playlistId -> normalised catalogue
    this.state = new Map(); // playlistId -> { refreshing, step, error, updatedAt, ms, errors }
    this.queue = Promise.resolve();
    this.listeners = new Set();
    this.idx = emptyIndex();
    this.timer = null;
    // Increases on every rebuild and curation change – caches that depend on the curation are keyed on it.
    this.gen = 0;
  }

  onRebuild(fn) {
    this.listeners.add(fn);
  }

  async init() {
    for (const p of this.store.playlists) {
      const file = join(this.cacheDir, `${p.id}.json`);
      if (!existsSync(file)) continue;
      try {
        const t0 = Date.now();
        this.raw.set(p.id, JSON.parse(readFileSync(file, 'utf8')));
        const r = this.raw.get(p.id);
        this.state.set(p.id, { refreshing: false, updatedAt: r.fetchedAt, error: null, errors: r.errors || [] });
        log(`catalogue ${p.id} loaded from cache (${r.live.items.length} channels, ${r.vod.items.length} movies, ${r.series.items.length} series) in ${Date.now() - t0} ms`);
      } catch (e) {
        warn(`could not read the cache for ${p.id}`, e.message);
      }
    }
    this.rebuild();
    this.checkSchedule();
    this.timer = setInterval(() => this.checkSchedule(), 10 * 60 * 1000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  // Fetch again the playlists whose catalogue is older than refreshHours.
  checkSchedule() {
    const maxAge = Math.max(1, Number(this.store.settings.refreshHours) || 12) * 3600e3;
    for (const p of this.store.playlists) {
      if (!p.enabled) continue;
      const raw = this.raw.get(p.id);
      const st = this.state.get(p.id);
      if (st && st.refreshing) continue;
      // After an error: wait at least 15 min before the next attempt.
      if (st && st.error && Date.now() - (st.failedAt || 0) < 15 * 60e3) continue;
      // An attempt that never finished (e.g. the hub died midway, out of memory): wait 30 min
      // counted from the attempt – otherwise a crash turns into a loop of heavy calls to the provider.
      const attempt = this.store.runtime.attempts[p.id] || 0;
      if (attempt > ((raw && raw.fetchedAt) || 0) && Date.now() - attempt < 30 * 60e3) continue;
      if (!raw || Date.now() - raw.fetchedAt > maxAge) this.refresh(p.id);
    }
  }

  // step, error and warnings are stored as messages ({ key, vars }) or, from older caches, plain
  // text; they are returned as text in lang.
  status(id, lang) {
    const st = this.state.get(id) || {};
    const raw = this.raw.get(id);
    return {
      ok: !!raw && !st.error,
      refreshing: !!st.refreshing,
      step: st.step ? text(st.step, lang) : null,
      error: st.error ? text(st.error, lang) : null,
      warnings: ((raw && raw.errors) || []).map((w) => text(w, lang)),
      updatedAt: raw ? raw.fetchedAt : null,
      ms: st.ms || null,
      info: raw ? raw.info : null,
      counts: raw ? { live: raw.live.items.length, vod: raw.vod.items.length, series: raw.series.items.length } : { live: 0, vod: 0, series: 0 }
    };
  }

  // Queues a refetch (one at a time so that we do not overload the provider).
  refresh(id) {
    const st = this.state.get(id) || {};
    if (st.refreshing) return st.promise;
    st.refreshing = true;
    st.step = msg('catalog.step.waiting');
    this.state.set(id, st);
    st.promise = this.queue = this.queue.then(() => this.doRefresh(id)).catch(() => {});
    this.emitStatus();
    return st.promise;
  }

  async doRefresh(id) {
    const p = this.store.playlist(id);
    const st = this.state.get(id);
    if (!p) {
      this.state.delete(id);
      return;
    }
    const t0 = Date.now();
    st.step = msg('catalog.step.loggingIn');
    this.emitStatus();
    this.store.runtime.attempts[id] = t0;
    await this.store.saveRuntime();
    try {
      const fn = p.type === 'm3u' ? m3uCatalog : xtreamCatalog;
      const data = await fn(p, (step) => {
        st.step = { live: msg('catalog.step.live'), vod: msg('catalog.step.vod'), series: msg('catalog.step.series') }[step] || step;
        this.emitStatus();
      });
      data.fetchedAt = Date.now();
      this.raw.set(id, data);
      st.error = null;
      st.updatedAt = data.fetchedAt;
      st.ms = Date.now() - t0;
      log(`catalogue ${id} fetched in ${st.ms} ms: ${data.live.items.length} channels, ${data.vod.items.length} movies, ${data.series.items.length} series${data.errors.length ? ' (' + data.errors.map((w) => text(w, 'en')).join('; ') + ')' : ''}`);
      writeAtomic(join(this.cacheDir, `${id}.json`), JSON.stringify(data)).catch((e) => warn('could not save the cache', e.message));
      this.rebuild();
      this.store.changed('catalog');
    } catch (e) {
      st.error = msgOf(e);
      st.failedAt = Date.now();
      warn(`catalogue ${id} failed: ${text(st.error, 'en')}`);
    } finally {
      st.refreshing = false;
      st.step = null;
      st.promise = null;
      this.emitStatus();
    }
  }

  emitStatus() {
    for (const fn of this.listeners) fn('status');
  }

  async forget(id) {
    this.raw.delete(id);
    this.state.delete(id);
    await rm(join(this.cacheDir, `${id}.json`), { force: true });
    this.rebuild();
  }

  // --- Index ------------------------------------------------------------------------------

  rebuild() {
    const t0 = Date.now();
    this.applyNewCategories();
    const idx = emptyIndex();
    const favorites = new Set(this.store.favorites);

    for (const p of this.store.playlists) {
      if (!p.enabled) continue;
      const raw = this.raw.get(p.id);
      if (!raw) continue;
      const pid = p.id;

      for (const kind of KINDS) {
        const tag = CAT_TAG[kind];
        const k = idx[kind];
        for (const c of raw[kind].cats) {
          const id = `${pid}:${tag}:${c.pid}`;
          if (k.cats.has(id)) continue;
          k.cats.set(id, { id, name: c.name, count: 0, playlistId: pid });
          k.byCat.set(id, []);
          k.providerOrder.push(id);
        }
      }

      for (const s of raw.live.items) {
        const categoryId = `${pid}:c:${s.cat}`;
        const o = {
          id: `${pid}:${s.sid}`,
          playlistId: pid,
          name: s.name,
          logo: s.logo || '',
          num: s.num,
          categoryId,
          epgId: s.epg || '',
          url: s.url || liveUrl(p, s.sid),
          catchup: !!s.archive,
          // How many days back the provider keeps (Xtream: tv_archive_duration). Unknown → 3.
          catchupDays: s.archive ? Math.min(Number(s.archiveDays) || 3, 14) : 0
        };
        addItem(idx.live, o, categoryId, s.name, { sid: s.sid });
      }
      for (const s of raw.vod.items) {
        const categoryId = `${pid}:v:${s.cat}`;
        const o = {
          id: `${pid}:${s.sid}`,
          title: s.title,
          year: s.year,
          poster: s.poster || '',
          backdrop: '',
          rating: s.rating,
          added: s.added,
          categoryId
        };
        addItem(idx.vod, o, categoryId, s.title, { sid: s.sid, ext: s.ext, tmdb: s.tmdb, url: s.url || null });
      }
      for (const s of raw.series.items) {
        const categoryId = `${pid}:s:${s.cat}`;
        const o = {
          id: `${pid}:${s.sid}`,
          title: s.title,
          year: s.year,
          poster: s.poster || '',
          backdrop: s.backdrop || '',
          rating: s.rating,
          added: s.added,
          categoryId
        };
        addItem(idx.series, o, categoryId, s.title, { sid: s.sid, tmdb: s.tmdb, plot: s.plot, genre: s.genre });
      }
    }

    // Channels are sorted by number within the category (the provider's order otherwise).
    for (const list of idx.live.byCat.values()) {
      if (list.some((e) => e.o.num != null)) list.sort((a, b) => (a.o.num ?? 1e9) - (b.o.num ?? 1e9));
    }

    this.applyCuration(idx, false);
    idx.favorites = favorites;
    this.idx = idx;
    this.builtAt = Date.now();
    const ms = Date.now() - t0;
    if (ms > 30) log(`index built in ${ms} ms (${idx.live.items.size} channels, ${idx.vod.items.size} movies, ${idx.series.items.size} series)`);
    for (const fn of this.listeners) fn('rebuild');
  }

  // Order, visibility and favourites – without rebuilding the search index (takes ~1 s with 100,000 entries).
  applyCuration(idx = this.idx, notify = true) {
    if (!idx) return;
    this.gen++;
    for (const kind of KINDS) {
      const k = idx[kind];
      const cur = this.store.curation(kind);
      const seen = new Set();
      k.order = [];
      for (const id of cur.order) if (k.cats.has(id) && !seen.has(id)) { seen.add(id); k.order.push(id); }
      for (const id of k.providerOrder) if (!seen.has(id)) { seen.add(id); k.order.push(id); }
      k.visible = new Set(cur.visible.filter((id) => k.cats.has(id)));
      for (const [id, list] of k.byCat) {
        const c = k.cats.get(id);
        if (c) c.count = list.length;
      }
      // Categories that are not in the category list but have content (provider error).
      for (const [id, list] of k.byCat) if (!k.cats.has(id) && list.length) {
        k.cats.set(id, { id, name: tr('catalog.uncategorised'), count: list.length, playlistId: id.split(':')[0] });
        k.providerOrder.push(id); // so that it remains when only the curation is recalculated
        k.order.push(id);
      }
    }
    if (notify) {
      idx.favorites = new Set(this.store.favorites);
      for (const fn of this.listeners) fn('rebuild');
    }
  }

  // New categories: remember them, and pick a sensible selection the first time a playlist is loaded.
  applyNewCategories() {
    let changed = false;
    const seed = this.store.data.seedDemo;
    for (const p of this.store.playlists) {
      const raw = this.raw.get(p.id);
      if (!raw) continue;
      const isSeed = seed && seed === p.id;
      for (const kind of KINDS) {
        const tag = CAT_TAG[kind];
        const cur = this.store.curation(kind);
        const known = new Set(cur.known);
        const ids = raw[kind].cats.map((c) => ({ id: `${p.id}:${tag}:${c.pid}`, name: c.name }));
        const fresh = ids.filter((c) => !known.has(c.id));
        if (!fresh.length) continue;
        const firstTime = fresh.length === ids.length;
        for (const c of fresh) cur.known.push(c.id);
        if (firstTime) {
          let pick;
          if (isSeed) pick = ids.filter((c) => DEMO_CURATION[kind].includes(c.name)).sort((a, b) => DEMO_CURATION[kind].indexOf(a.name) - DEMO_CURATION[kind].indexOf(b.name));
          else if (kind === 'live') pick = ids.filter((c) => localCats().test(c.name)).slice(0, 12);
          else pick = ids.filter((c) => localCats().test(c.name) || NEWISH.test(c.name)).slice(0, 12);
          if (!pick.length) pick = ids.slice(0, kind === 'live' ? 5 : 8);
          for (const c of pick) if (!cur.visible.includes(c.id)) cur.visible.push(c.id);
          // The chosen ones first in the order.
          cur.order = pick.map((c) => c.id).concat(cur.order.filter((id) => !pick.some((c) => c.id === id)));
        }
        changed = true;
      }
      if (isSeed && raw.live.items.length) {
        const byName = new Map();
        for (const s of raw.live.items) if (!byName.has(s.name)) byName.set(s.name, `${p.id}:${s.sid}`);
        const favs = DEMO_CURATION.favorites.map((n) => byName.get(n)).filter(Boolean);
        if (favs.length && !this.store.favorites.length) this.store.data.favorites = favs;
        delete this.store.data.seedDemo;
        changed = true;
      }
    }
    // Only save – the index is rebuilt straight afterwards and the TV gets a new rev via 'catalog'.
    if (changed) this.store.scheduleSave();
  }

  // --- Queries -------------------------------------------------------------------------------

  categories(kind, { all = false } = {}) {
    const k = this.idx[kind];
    const out = [];
    for (const id of k.order) {
      const c = k.cats.get(id);
      if (!c) continue;
      const visible = k.visible.has(id);
      if (!all && !visible) continue;
      out.push(all ? { ...c, visible } : { id: c.id, name: c.name, count: c.count });
    }
    return out;
  }

  isVisibleCategory(kind, id) {
    return this.idx[kind].visible.has(id);
  }

  entries(kind, categoryId) {
    return this.idx[kind].byCat.get(categoryId) || [];
  }

  entry(kind, id) {
    return this.idx[kind].items.get(id) || null;
  }

  // All entries in visible categories (for "recently added" and search).
  visibleEntries(kind) {
    const k = this.idx[kind];
    const out = [];
    for (const id of k.order) if (k.visible.has(id)) {
      const list = k.byCat.get(id);
      if (list) for (const e of list) out.push(e);
    }
    return out;
  }

  favoriteChannels() {
    const out = [];
    for (const id of this.store.favorites) {
      const e = this.idx.live.items.get(id);
      if (e) out.push(e.o);
    }
    return out;
  }

  playlistFor(id) {
    const pid = String(id).split(':')[0];
    const p = this.store.playlist(pid);
    return p && p.enabled ? p : null;
  }

  counts() {
    const v = (kind) => this.categories(kind).reduce((n, c) => n + c.count, 0);
    return {
      live: this.idx.live.items.size,
      vod: this.idx.vod.items.size,
      series: this.idx.series.items.size,
      liveVisible: v('live'),
      vodVisible: v('vod'),
      seriesVisible: v('series'),
      categories: {
        live: this.idx.live.cats.size,
        vod: this.idx.vod.cats.size,
        series: this.idx.series.cats.size,
        liveVisible: this.idx.live.visible.size,
        vodVisible: this.idx.vod.visible.size,
        seriesVisible: this.idx.series.visible.size
      }
    };
  }
}

function emptyKind() {
  return { cats: new Map(), byCat: new Map(), items: new Map(), order: [], providerOrder: [], visible: new Set() };
}

function emptyIndex() {
  return { live: emptyKind(), vod: emptyKind(), series: emptyKind(), favorites: new Set() };
}

// An entry in the index: o = the public object, n/n2 = search text with and without prefix.
function addItem(k, o, categoryId, name, extra) {
  if (k.items.has(o.id)) return;
  const n = norm(name);
  const stripped = norm(stripPrefix(name));
  const e = Object.assign({ o, n, n2: stripped !== n ? stripped : null }, extra);
  k.items.set(o.id, e);
  let list = k.byCat.get(categoryId);
  if (!list) {
    list = [];
    k.byCat.set(categoryId, list);
  }
  list.push(e);
}
