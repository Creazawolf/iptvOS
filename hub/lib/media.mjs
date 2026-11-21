// Films and series: detail pages (via the provider, cached) and "Continue watching".
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { episodeUrl, movieUrl, xtreamSeriesInfo, xtreamVodInfo } from './providers.mjs';
import { LocalError, msg, text, tr } from './i18n.mjs';
import { apply } from './tmdb.mjs';
import { num, rating, TTLCache, warn, writeAtomic } from './util.mjs';

// Detail pages: fresh for this long, after which the saved version is shown straight away while a new one is fetched
// in the background (stale-while-revalidate). Saved on disk, so a restart costs no new calls
// to the provider. Films rarely change; series get new episodes.
const DAY = 86400e3;
const FRESH = { vod: 7 * DAY, series: 12 * 3600e3 };
const STALE_MAX = 60 * DAY;
const RETRY_MS = 60e3;          // failed lookup with no saved version: try again after a minute
const BACKOFF_MS = 10 * 60e3;   // failed background update: keep the old one for a while
const DISK_MAX = 6000;          // files in data/cache/info
const FINISHED = 0.95;
const KEEP_DAYS = 90;

function duration(info) {
  if (num(info.duration_secs)) return Number(info.duration_secs);
  const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(String(info.duration || '').trim());
  if (m) return m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
  if (num(info.episode_run_time)) return Number(info.episode_run_time) * 60;
  return null;
}

const first = (v) => (Array.isArray(v) ? v.find(Boolean) || '' : v || '');

// Generic names ("Season 2", "Avsnitt 5" – from the provider or an older cache) are replaced by the
// hub's own in the reader's language.
const GENERIC_SEASON = /^(season|säsong) \d+$/i;
const GENERIC_EPISODE = /^(episode|avsnitt) \d+$/i;

function trailerUrl(t) {
  if (!t) return '';
  if (/^https?:\/\//.test(t)) return t;
  return 'https://www.youtube.com/watch?v=' + encodeURIComponent(t);
}

function cleanEpisodeTitle(raw, seriesTitle) {
  let t = String(raw || '').trim();
  const m = /S\d{1,2}\s*E\d{1,4}\s*[-–:|]?\s*/i.exec(t);
  if (m) t = t.slice(m.index + m[0].length);
  if (seriesTitle && t.toLowerCase().startsWith(seriesTitle.toLowerCase())) t = t.slice(seriesTitle.length).replace(/^\s*[-–:|]\s*/, '');
  return t.trim(); // empty: "Episode N" in the reader's language (seriesInfo)
}

export class Media {
  constructor(store, catalog, tmdb, sse, dataDir) {
    this.store = store;
    this.catalog = catalog;
    this.tmdb = tmdb;
    this.sse = sse;
    this.cache = new TTLCache(400, STALE_MAX); // key -> { v, at, retry?, nextTry? }
    this.inflight = new Map();
    this.dir = dataDir ? join(dataDir, 'cache', 'info') : null;
    this.writes = 0;
  }

  file(key) {
    return this.dir ? join(this.dir, createHash('sha1').update(key).digest('hex') + '.json') : null;
  }

  async readDisk(key) {
    const f = this.file(key);
    if (!f) return null;
    try {
      const d = JSON.parse(await readFile(f, 'utf8'));
      return d && d.v && d.at && Date.now() - d.at < STALE_MAX ? { v: d.v, at: d.at } : null;
    } catch {
      return null;
    }
  }

  writeDisk(key, entry) {
    const f = this.file(key);
    if (!f) return;
    writeAtomic(f, JSON.stringify({ key, at: entry.at, v: entry.v })).catch((e) => warn('could not save info', e.message));
    if (++this.writes % 200 === 0) this.pruneDisk();
  }

  async pruneDisk() {
    try {
      const names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
      if (names.length <= DISK_MAX) return;
      const files = await Promise.all(names.map(async (n) => ({ f: join(this.dir, n), t: (await stat(join(this.dir, n)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
      files.sort((a, b) => a.t - b.t);
      for (const x of files.slice(0, files.length - DISK_MAX * 0.8)) await rm(x.f, { force: true });
    } catch { /* the directory does not exist yet */ }
  }

  async cached(key, fn) {
    const fresh = FRESH[key.split(':')[0]] || DAY;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = await this.readDisk(key);
      if (hit) this.cache.set(key, hit);
    }
    const now = Date.now();
    if (hit && hit.retry) {
      if (now - hit.at < RETRY_MS) return hit.v;
    } else if (hit) {
      if (now - hit.at < fresh) return hit.v;
      // Old but usable: answer straight away, fetch a new one in the background (not more often than BACKOFF_MS).
      if (!(hit.nextTry > now)) this.refresh(key, fn, hit).catch(() => {});
      return hit.v;
    }
    return this.refresh(key, fn, hit);
  }

  refresh(key, fn, prev) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const job = fn().then((v) => {
      // Failed lookups (e.g. when the provider blocks us): do not overwrite a good version.
      const retry = !!(v && v.__retry);
      if (retry) delete v.__retry;
      if (retry && prev && !prev.retry) {
        prev.nextTry = Date.now() + BACKOFF_MS;
        return prev.v;
      }
      const entry = { v, at: Date.now(), retry };
      this.cache.set(key, entry);
      if (!retry) this.writeDisk(key, entry);
      return v;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  async vodInfo(id) {
    const e = this.catalog.entry('vod', id);
    const p = this.catalog.playlistFor(id);
    if (!e || !p) return null;
    const out = await this.cached('vod:' + id, async () => {
      const o = {
        ...e.o,
        plot: '', genre: '', cast: '', director: '', duration: null, trailer: '',
        url: e.url || movieUrl(p, e.sid, e.ext)
      };
      if (p.type === 'xtream') {
        try {
          const d = await xtreamVodInfo(p, e.sid);
          const info = (d && !Array.isArray(d.info) && d.info) || {};
          const md = (d && !Array.isArray(d.movie_data) && d.movie_data) || {};
          o.poster = info.cover_big || info.movie_image || o.poster;
          o.backdrop = first(info.backdrop_path) || o.backdrop;
          o.plot = info.plot || info.description || '';
          o.genre = info.genre || '';
          o.cast = info.cast || info.actors || '';
          o.director = info.director || '';
          o.duration = duration(info);
          o.trailer = trailerUrl(info.youtube_trailer);
          if (o.rating == null) o.rating = rating(info.rating, info.rating_5based);
          if (!o.year && info.releasedate) o.year = num(String(info.releasedate).slice(0, 4));
          if (md.container_extension) o.ext = md.container_extension;
          if (!e.tmdb && info.tmdb_id) e.tmdb = String(info.tmdb_id);
        } catch (err) {
          warn(`movie ${id}: ${err.message}`);
          o.__retry = true;
        }
      }
      if (!o.poster || !o.backdrop || !o.plot) apply(o, await this.tmdb.lookup('vod', o.title, o.year, e.tmdb));
      // The list entry gets richer for next time (e.g. a backdrop in the hero area).
      if (!e.o.backdrop && o.backdrop) e.o.backdrop = o.backdrop;
      if (!e.o.poster && o.poster) e.o.poster = o.poster;
      return o;
    });
    // The address is worked out now (not from the cache), so that a changed server/user applies straight away.
    return { ...out, ext: undefined, url: e.url || movieUrl(p, e.sid, out.ext || e.ext), progress: this.progressFor('vod', id) };
  }

  async seriesInfo(id, lang) {
    const e = this.catalog.entry('series', id);
    const p = this.catalog.playlistFor(id);
    if (!e || !p) return null;
    const pl = p.id;
    const out = await this.cached('series:' + id, async () => {
      const o = { ...e.o, plot: e.plot || '', genre: e.genre || '', cast: '', director: '', trailer: '', seasons: [] };
      if (p.type === 'xtream') {
        try {
          const d = await xtreamSeriesInfo(p, e.sid);
          const info = (d && d.info) || {};
          o.plot = info.plot || o.plot;
          o.genre = info.genre || o.genre;
          o.cast = info.cast || '';
          o.director = info.director || '';
          o.trailer = trailerUrl(info.youtube_trailer);
          o.poster = info.cover || o.poster;
          o.backdrop = first(info.backdrop_path) || o.backdrop;
          const seasonMeta = new Map();
          for (const s of Array.isArray(d.seasons) ? d.seasons : []) {
            if (s && s.season_number != null) seasonMeta.set(Number(s.season_number), s);
          }
          let eps = d.episodes || {};
          // Some panels send a list of lists instead of an object.
          if (Array.isArray(eps)) {
            const obj = {};
            eps.forEach((list, i) => {
              const n = list && list[0] && list[0].season != null ? list[0].season : i + 1;
              obj[n] = list;
            });
            eps = obj;
          }
          const seasons = [];
          for (const key of Object.keys(eps)) {
            const list = Array.isArray(eps[key]) ? eps[key] : Object.values(eps[key] || {});
            const n = Number(key);
            const meta = seasonMeta.get(n) || {};
            seasons.push({
              season: n,
              // Empty: "Extras" / "Season N" in the reader's language (below).
              name: n !== 0 && meta.name && !GENERIC_SEASON.test(meta.name) ? meta.name : '',
              poster: meta.cover_big || meta.cover || '',
              episodes: list.filter(Boolean).map((ep, i) => {
                const info = ep.info || {};
                const epNum = num(ep.episode_num) || i + 1;
                return {
                  id: `${pl}:${ep.id}`,
                  season: num(ep.season) ?? n,
                  episode: epNum,
                  title: cleanEpisodeTitle(ep.title, o.title),
                  plot: info.plot || '',
                  duration: duration(info),
                  still: info.movie_image || info.cover_big || '',
                  sid: String(ep.id),
                  ext: ep.container_extension || ''
                };
              }).sort((a, b) => a.episode - b.episode)
            });
          }
          seasons.sort((a, b) => (a.season === 0) - (b.season === 0) || a.season - b.season);
          o.seasons = seasons;
        } catch (err) {
          warn(`series ${id}: ${err.message}`);
          o.__retry = true;
        }
      }
      if (!o.poster || !o.backdrop || !o.plot) apply(o, await this.tmdb.lookup('series', o.title, o.year, e.tmdb));
      if (!e.o.backdrop && o.backdrop) e.o.backdrop = o.backdrop;
      if (!e.o.poster && o.poster) e.o.poster = o.poster;
      return o;
    });
    // Watch status per episode.
    const seasons = out.seasons.map((s) => ({
      ...s,
      name: s.season === 0 ? tr('media.extras', null, lang) : s.name && !GENERIC_SEASON.test(s.name) ? s.name : tr('media.season', { n: s.season }, lang),
      episodes: s.episodes.map((ep) => {
        const { sid, ext, ...rest } = ep;
        return {
          ...rest,
          title: ep.title && !GENERIC_EPISODE.test(ep.title) ? ep.title : tr('media.episode', { n: ep.episode }, lang),
          url: sid != null ? episodeUrl(p, sid, ext) : ep.url,
          progress: this.progressFor('episode', ep.id)
        };
      })
    }));
    return { ...out, seasons };
  }

  // --- Continue watching -------------------------------------------------------------------

  progressFor(kind, id) {
    const p = this.store.progress[kind + ':' + id];
    return p ? { position: p.position, duration: p.duration, updated: p.updated } : null;
  }

  // subtitleMsg (stored next to subtitle) gives the episode line in the reader's language.
  continueList(lang) {
    const cutoff = Date.now() - KEEP_DAYS * 86400e3;
    const seen = new Set();
    return Object.values(this.store.progress)
      .filter((p) => p.updated > cutoff && this.catalog.playlistFor(p.id))
      .sort((a, b) => b.updated - a.updated)
      .filter((p) => {
        // One row per series: the most recently watched episode.
        if (p.kind !== 'episode' || !p.seriesId) return true;
        if (seen.has(p.seriesId)) return false;
        seen.add(p.seriesId);
        return true;
      })
      .slice(0, 20)
      .map(({ subtitleMsg, ...p }) => (subtitleMsg ? { ...p, subtitle: text(subtitleMsg, lang) } : p));
  }

  // All saved positions (for the TV: "Resume from" on every film and episode).
  positions(limit = 1500) {
    const out = {};
    Object.values(this.store.progress)
      .filter((p) => !p.next && p.position > 0)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, limit)
      .forEach((p) => { out[p.id] = [Math.round(p.position), Math.round(p.duration || 0)]; });
    return out;
  }

  // Keep the history reasonable: entries older than KEEP_DAYS or beyond 3000 are pruned.
  prune() {
    const all = Object.entries(this.store.progress).sort((a, b) => b[1].updated - a[1].updated);
    const cutoff = Date.now() - KEEP_DAYS * 86400e3;
    all.forEach(([k, p], i) => { if (i >= 3000 || p.updated < cutoff) this.store.setProgress(k, null); });
  }

  async saveProgress({ id, kind, seriesId, position, duration: dur }) {
    if (!id || (kind !== 'vod' && kind !== 'episode')) throw new LocalError('errors.progressInput');
    const key = kind + ':' + id;
    position = Math.max(0, Number(position) || 0);
    dur = Number(dur) || null;

    // The position is saved for every film and episode (so that you can go back to an older
    // episode and continue there). "Continue watching" still shows only one row per series.
    // A "next episode" suggestion for the series is replaced when you start watching something in it.
    if (kind === 'episode' && seriesId) {
      for (const k of Object.keys(this.store.progress)) {
        const p = this.store.progress[k];
        if (p.next && p.kind === 'episode' && p.seriesId === seriesId && k !== key) this.store.setProgress(k, null);
      }
    }

    const finished = dur && position / dur >= FINISHED;
    if (finished) {
      this.store.setProgress(key, null);
      if (kind === 'episode' && seriesId) await this.queueNextEpisode(seriesId, id);
      this.notify();
      return { ok: true, finished: true };
    }
    if (position < 10 && !(this.store.progress[key] && this.store.progress[key].next)) {
      // Barely started: do not save (but do not remove a "next episode" row either).
      return { ok: true, ignored: true };
    }
    const entry = await this.describe(kind, id, seriesId);
    this.store.setProgress(key, { ...entry, position, duration: dur, updated: Date.now() });
    if (Math.random() < 0.02) this.prune();
    this.notify();
    return { ok: true };
  }

  async describe(kind, id, seriesId) {
    if (kind === 'vod') {
      const e = this.catalog.entry('vod', id);
      const o = e ? e.o : {};
      return { id, kind, title: o.title || '', subtitle: o.year ? String(o.year) : '', poster: o.poster || '', backdrop: o.backdrop || '', year: o.year || null };
    }
    const s = seriesId ? this.catalog.entry('series', seriesId) : null;
    const so = s ? s.o : {};
    let subtitle = '';
    let subtitleMsg = null;
    let still = '';
    let url = '';
    try {
      const info = seriesId ? await this.seriesInfo(seriesId) : null;
      for (const season of (info && info.seasons) || []) {
        const ep = season.episodes.find((x) => x.id === id);
        if (ep) {
          subtitleMsg = msg('media.episodeLine', { season: ep.season, episode: ep.episode, title: ep.title });
          subtitle = text(subtitleMsg);
          still = ep.still;
          url = ep.url;
          break;
        }
      }
      if (info && !so.backdrop && info.backdrop) so.backdrop = info.backdrop;
    } catch {}
    const entry = { id, kind, seriesId: seriesId || null, title: so.title || '', subtitle, poster: so.poster || '', backdrop: so.backdrop || still || '', still, url };
    if (subtitleMsg) entry.subtitleMsg = subtitleMsg;
    return entry;
  }

  async queueNextEpisode(seriesId, id) {
    try {
      const info = await this.seriesInfo(seriesId);
      const all = [];
      for (const s of info.seasons) if (s.season !== 0) for (const ep of s.episodes) all.push(ep);
      const i = all.findIndex((ep) => ep.id === id);
      const next = i >= 0 ? all[i + 1] : null;
      if (!next) return;
      const entry = await this.describe('episode', next.id, seriesId);
      this.store.setProgress('episode:' + next.id, { ...entry, position: 0, duration: next.duration || null, updated: Date.now(), next: true });
    } catch (e) {
      warn('next episode', e.message);
    }
  }

  notify() {
    if (this.sse) this.sse.broadcast('continue', { count: this.continueList().length });
  }
}
