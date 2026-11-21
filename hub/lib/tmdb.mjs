// Optional enhancement of covers, backdrops and plots via TMDB (themoviedb.org).
// Requires an API key (v3 key or v4 "Read Access Token") under Settings.
// The provider's TMDB id is used if there is one, otherwise search by title + year. Responses are cached in tmdb.json.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { regionOf } from './i18n.mjs';
import { fetchJson, limiter, warn, writeAtomic } from './util.mjs';

const IMG = 'https://image.tmdb.org/t/p/';
const DAY = 86400e3;
const MAX_ENTRIES = 20000; // tmdb.json must not grow without limit – the oldest lookups are dropped first

export class Tmdb {
  constructor(store, dataDir) {
    this.store = store;
    this.file = join(dataDir, 'tmdb.json');
    this.cache = {};
    if (existsSync(this.file)) {
      try {
        this.cache = JSON.parse(readFileSync(this.file, 'utf8')) || {};
      } catch {}
    }
    this.limit = limiter(3);
    this.inflight = new Map();
    this.saveTimer = null;
    this.backgroundQueue = new Set();
    this.backgroundRunning = false;
  }

  get enabled() {
    return !!this.store.settings.tmdbKey;
  }

  peek(kind, title, year, tmdbId) {
    return this.cache[key(kind, title, year, tmdbId)] || null;
  }

  // { poster, backdrop, plot, rating, genre } or null.
  async lookup(kind, title, year, tmdbId, { timeout = 5000 } = {}) {
    if (!this.enabled || !title) return null;
    const k = key(kind, title, year, tmdbId);
    const hit = this.cache[k];
    if (hit && Date.now() - hit.at < (hit.miss ? 7 : 60) * DAY) return hit.miss ? null : hit;
    if (this.inflight.has(k)) return this.inflight.get(k);
    const job = this.limit(() => this.fetch(kind, title, year, tmdbId, timeout))
      .then((r) => {
        this.cache[k] = r ? { ...r, at: Date.now() } : { miss: true, at: Date.now() };
        this.scheduleSave();
        return r;
      })
      .catch((e) => {
        warn(`TMDB: ${e.message}`);
        return null;
      })
      .finally(() => this.inflight.delete(k));
    this.inflight.set(k, job);
    return job;
  }

  async fetch(kind, title, year, tmdbId, timeout) {
    const type = kind === 'series' ? 'tv' : 'movie';
    // Set in the admin, or from the hub's language (sv-SE / en-US).
    const lang = this.store.settings.tmdbLanguage || regionOf(this.store.settings.language);
    let item = null;
    if (tmdbId && /^\d+$/.test(tmdbId)) {
      try {
        item = await this.get(`/${type}/${tmdbId}`, { language: lang }, timeout);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    if (!item) {
      const params = { query: title, language: lang, include_adult: 'false' };
      if (year) params[type === 'tv' ? 'first_air_date_year' : 'year'] = String(year);
      const r = await this.get(`/search/${type}`, params, timeout);
      item = r && r.results && r.results[0];
      if (!item && year) {
        delete params.year;
        delete params.first_air_date_year;
        const r2 = await this.get(`/search/${type}`, params, timeout);
        item = r2 && r2.results && r2.results[0];
      }
    }
    if (!item) return null;
    // Swedish plots are often missing – fill in with English.
    let plot = item.overview || '';
    if (!plot && item.id) {
      try {
        const en = await this.get(`/${type}/${item.id}`, { language: 'en-US' }, timeout);
        plot = (en && en.overview) || '';
      } catch {}
    }
    return {
      id: item.id,
      poster: item.poster_path ? IMG + 'w500' + item.poster_path : '',
      backdrop: item.backdrop_path ? IMG + 'w1280' + item.backdrop_path : '',
      plot,
      rating: item.vote_average ? Math.round(item.vote_average * 10) / 10 : null,
      genre: Array.isArray(item.genres) ? item.genres.map((g) => g.name).join(', ') : ''
    };
  }

  async get(path, params, timeout) {
    const keyStr = this.store.settings.tmdbKey.trim();
    const q = new URLSearchParams(params);
    const headers = { Accept: 'application/json' };
    // A v4 token (long JWT) is sent as Bearer, a v3 key as api_key.
    if (keyStr.length > 40) headers.Authorization = 'Bearer ' + keyStr;
    else q.set('api_key', keyStr);
    return fetchJson(`https://api.themoviedb.org/3${path}?${q}`, { timeout, headers, userAgent: 'G3Hub/1.0' });
  }

  // Fill in missing covers in the background (for lists), at a calm pace.
  enrichLater(kind, entry) {
    if (!this.enabled || this.backgroundQueue.size > 500) return;
    this.backgroundQueue.add({ kind, entry });
    if (!this.backgroundRunning) this.runBackground();
  }

  async runBackground() {
    this.backgroundRunning = true;
    for (const job of this.backgroundQueue) {
      this.backgroundQueue.delete(job);
      const o = job.entry.o;
      const r = await this.lookup(job.kind, o.title, o.year, job.entry.tmdb, { timeout: 8000 });
      if (r) apply(o, r);
      await new Promise((res) => setTimeout(res, 120));
    }
    this.backgroundRunning = false;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 3000);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const keys = Object.keys(this.cache);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => (this.cache[a].at || 0) - (this.cache[b].at || 0));
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete this.cache[k];
    }
    this.saving = writeAtomic(this.file, JSON.stringify(this.cache)).catch(() => {});
    return this.saving;
  }

  // On exit: save whatever is pending.
  async flush() {
    if (this.saveTimer) await this.save();
    else if (this.saving) await this.saving;
  }
}

// Only fill in what is missing.
export function apply(o, r) {
  if (!r) return o;
  if (!o.poster && r.poster) o.poster = r.poster;
  if (!o.backdrop && r.backdrop) o.backdrop = r.backdrop;
  if ('plot' in o && !o.plot && r.plot) o.plot = r.plot;
  if (o.rating == null && r.rating) o.rating = r.rating;
  if ('genre' in o && !o.genre && r.genre) o.genre = r.genre;
  return o;
}

const key = (kind, title, year, tmdbId) => (tmdbId ? `${kind}:id:${tmdbId}` : `${kind}:${String(title).toLowerCase()}:${year || ''}`);
