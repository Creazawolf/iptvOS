// Settings, playlists, curation and favourites in config.json (+ watch history in progress.json).
// Every change increases `rev`, which the TV watches via /api/events.
import { existsSync, readFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isLang, tr } from './i18n.mjs';
import { log, warn, writeAtomic } from './util.mjs';

export const KINDS = ['live', 'vod', 'series'];

const DEFAULT_SETTINGS = {
  name: 'G3 Hub',
  adminToken: '',
  tvToken: '',
  refreshHours: 12,
  tmdbKey: '',
  tmdbLanguage: '', // empty = from language: sv-SE / en-US
  imageProxy: true,
  language: 'en' // 'en' | 'sv': fallback for requests without a known language, and content defaults
};

const emptyCuration = () => ({ order: [], visible: [], known: [] });

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'config.json');
    this.progressFile = join(dir, 'progress.json');
    // Runtime state that should survive a restart: provider pauses and latest fetch attempts.
    this.runtimeFile = join(dir, 'runtime.json');
    this.listeners = new Set();
    this.saveTimer = null;
    this.progressTimer = null;
    this.data = this.load();
    if (this.migrated) this.save();
    this.progress = this.loadProgress();
    this.runtime = this.loadRuntime();
  }

  loadRuntime() {
    try {
      const r = JSON.parse(readFileSync(this.runtimeFile, 'utf8')) || {};
      return { gates: r.gates || {}, attempts: r.attempts || {} };
    } catch {
      return { gates: {}, attempts: {} };
    }
  }

  // Written straight away (small), so that a crash shortly afterwards does not lose it.
  saveRuntime() {
    this.runtimeSaving = (this.runtimeSaving || Promise.resolve()).then(() =>
      writeAtomic(this.runtimeFile, JSON.stringify(this.runtime)).catch((e) => warn('could not save runtime.json', e.message)));
    return this.runtimeSaving;
  }

  load() {
    let d = {};
    const existed = existsSync(this.file);
    if (existed) {
      try {
        d = JSON.parse(readFileSync(this.file, 'utf8'));
      } catch (e) {
        try {
          writeAtomic(this.file + '.bad', readFileSync(this.file));
        } catch {}
        // The latest working copy (saved at most once an hour, see save()).
        try {
          d = JSON.parse(readFileSync(this.file + '.1', 'utf8'));
          warn('could not read config.json – using config.json.1 (the broken file is kept as .bad)', e.message);
        } catch {
          warn('could not read config.json – starting over (the old file is kept as .bad)', e.message);
          d = {};
        }
      }
    }
    // Hubs from before the language setting were Swedish-only: keep them Swedish.
    if (existed && !(d && d.settings && d.settings.language)) {
      d = d && typeof d === 'object' ? d : {};
      d.settings = { ...(d.settings || {}), language: 'sv' };
      this.migrated = true;
    }
    return normalize(d);
  }

  // Restore from a backup (see /api/admin/restore). rev keeps going up so that the TV
  // sees the change.
  replace(data, progress) {
    const rev = this.data.rev;
    data = JSON.parse(JSON.stringify(data));
    // A backup from before the language setting comes from a Swedish hub.
    if (data.settings && !data.settings.language) data.settings.language = 'sv';
    this.data = normalize(data);
    this.data.rev = Math.max(rev, this.data.rev);
    for (const p of this.data.playlists) {
      const n = Number(String(p.id || '').replace(/^p/, ''));
      if (n >= this.data.nextPlaylist) this.data.nextPlaylist = n + 1;
    }
    if (progress && typeof progress === 'object') {
      this.progress = JSON.parse(JSON.stringify(progress));
      this.saveProgress();
    }
    this.changed('playlists');
  }

  loadProgress() {
    if (!existsSync(this.progressFile)) return {};
    try {
      return JSON.parse(readFileSync(this.progressFile, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  get settings() { return this.data.settings; }
  get playlists() { return this.data.playlists; }
  get favorites() { return this.data.favorites; }
  mediaFavorites(kind) { return this.data.mediaFavorites[kind] || []; }
  get rev() { return this.data.rev; }
  curation(kind) { return this.data.curation[kind]; }

  playlist(id) {
    return this.data.playlists.find((p) => p.id === id) || null;
  }

  // Call after every change. reason is passed on to the listeners (SSE, index).
  changed(reason, { bump = true } = {}) {
    if (bump) this.data.rev++;
    this.scheduleSave();
    for (const fn of this.listeners) {
      try {
        fn(reason, this.data.rev);
      } catch (e) {
        warn('listener threw', e);
      }
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 300);
  }

  // Saves are queued so that two never write at the same time.
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saving = (this.saving || Promise.resolve()).then(async () => {
      try {
        // Keep a copy of the last saved state (once an hour) to fall back on.
        if (Date.now() - (this.backupAt || 0) > 3600e3 && existsSync(this.file)) {
          await copyFile(this.file, this.file + '.1').catch(() => {});
          this.backupAt = Date.now();
        }
        await writeAtomic(this.file, JSON.stringify(this.data, null, 2));
      } catch (e) {
        warn('could not save config.json', e.message);
      }
    });
    return this.saving;
  }

  scheduleProgressSave() {
    clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => this.saveProgress(), 2000);
  }

  async saveProgress() {
    clearTimeout(this.progressTimer);
    this.progressTimer = null;
    try {
      await writeAtomic(this.progressFile, JSON.stringify(this.progress));
    } catch (e) {
      warn('could not save progress.json', e.message);
    }
  }

  // On exit: save whatever is pending and wait for saves already in progress.
  async flush() {
    if (this.saveTimer) await this.save();
    else if (this.saving) await this.saving;
    if (this.progressTimer) await this.saveProgress();
    if (this.runtimeSaving) await this.runtimeSaving;
  }

  // --- Playlists ---------------------------------------------------------------------

  addPlaylist(input) {
    const p = sanitizePlaylist(input);
    p.id = 'p' + this.data.nextPlaylist++;
    p.created = Date.now();
    this.data.playlists.push(p);
    this.changed('playlists');
    log(`playlist added: ${p.id} ${p.name}`);
    return p;
  }

  updatePlaylist(id, input) {
    const p = this.playlist(id);
    if (!p) return null;
    const next = sanitizePlaylist(Object.assign({}, p, input));
    // Empty password in the form = keep the old one.
    if (input && input.password === '' && p.password) next.password = p.password;
    Object.assign(p, next, { id: p.id, created: p.created });
    this.changed('playlists');
    return p;
  }

  removePlaylist(id) {
    const i = this.data.playlists.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.data.playlists.splice(i, 1);
    const prefix = id + ':';
    this.data.favorites = this.data.favorites.filter((f) => !f.startsWith(prefix));
    for (const k of ['vod', 'series']) this.data.mediaFavorites[k] = this.data.mediaFavorites[k].filter((f) => !f.startsWith(prefix));
    for (const k of KINDS) {
      const c = this.data.curation[k];
      c.order = c.order.filter((x) => !x.startsWith(prefix));
      c.visible = c.visible.filter((x) => !x.startsWith(prefix));
      c.known = c.known.filter((x) => !x.startsWith(prefix));
    }
    this.changed('playlists');
    return true;
  }

  // --- Watch history ---------------------------------------------------------------------

  setProgress(key, entry) {
    if (entry) this.progress[key] = entry;
    else delete this.progress[key];
    this.scheduleProgressSave();
  }
}

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  d.version = 1;
  d.rev = Number(d.rev) || 1;
  d.settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
  if (!isLang(d.settings.language)) d.settings.language = DEFAULT_SETTINGS.language;
  d.playlists = Array.isArray(d.playlists) ? d.playlists.filter((p) => p && typeof p.id === 'string') : [];
  d.curation = d.curation || {};
  for (const k of KINDS) d.curation[k] = Object.assign(emptyCuration(), d.curation[k] || {});
  d.favorites = Array.isArray(d.favorites) ? d.favorites : [];
  d.mediaFavorites = d.mediaFavorites || {};
  for (const k of ['vod', 'series']) d.mediaFavorites[k] = Array.isArray(d.mediaFavorites[k]) ? d.mediaFavorites[k] : [];
  d.nextPlaylist = Number(d.nextPlaylist) || d.playlists.length + 1;
  return d;
}

export function sanitizePlaylist(input) {
  const s = (v) => (v == null ? '' : String(v).trim());
  const type = input.type === 'm3u' ? 'm3u' : 'xtream';
  let server = s(input.server).replace(/\/+$/, '');
  if (server && !/^https?:\/\//i.test(server)) server = 'http://' + server;
  // Pasted addresses such as "http://x:8080/player_api.php?..." → just the base address.
  server = server.replace(/\/(player_api|get|xmltv)\.php.*$/i, '');
  return {
    name: s(input.name) || (type === 'm3u' ? tr('catalog.m3uName') : 'Xtream'),
    type,
    server: type === 'xtream' ? server : '',
    username: type === 'xtream' ? s(input.username) : '',
    password: type === 'xtream' ? s(input.password) : '',
    m3uUrl: type === 'm3u' ? s(input.m3uUrl) : '',
    epgUrl: s(input.epgUrl),
    format: input.format === 'ts' ? 'ts' : 'm3u8',
    userAgent: s(input.userAgent),
    enabled: input.enabled !== false
  };
}

// Playlist without secrets (for admin lists and the TV).
export function publicPlaylist(p) {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    server: p.server,
    username: p.username,
    hasPassword: !!p.password,
    m3uUrl: p.m3uUrl,
    epgUrl: p.epgUrl,
    format: p.format,
    userAgent: p.userAgent,
    enabled: p.enabled,
    created: p.created
  };
}
