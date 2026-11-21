// EPG: "now and next", the day's schedule and the schedule for a whole category.
//   Xtream: the provider's xmltv.php is fetched as ONE file (every 12 hours) and only your channels
//           (visible categories + favourites) are kept – on disk too, so a restart does not require
//           a new download. get_short_epg per channel is only used if xmltv.php does not work,
//           and then at a careful pace (panels block IP addresses that "flood").
//   M3U / own XMLTV address: the same thing with the address you entered.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { xtreamShortEpg } from './providers.mjs';
import { fetchWithTimeout, limiter, log, norm, sleep, TTLCache, warn, writeAtomic } from './util.mjs';

const TTL = 10 * 60 * 1000;
const XMLTV_MAX_AGE = 12 * 3600e3;
const XMLTV_RETRY = 60 * 60e3;
// New channels in the curation → reload xmltv after 3 h at the earliest (the file is large, and the provider
// should not get the same heavy call often).
const XMLTV_GROW_DELAY = 3 * 3600e3;
// Channels outside the curation that the TV asked for anyway (search hits, last channel). Kept so that they
// are included in the next download – otherwise they would trigger a new download again and again.
const EXTRA_MAX = 300;
// Past programmes are only kept for channels with catch-up (at most this many days back).
const CATCHUP_MAX_DAYS = 7;
const PAST_DEFAULT = 3 * 3600e3;

function xmltvUrl(p) {
  if (p.epgUrl) return p.epgUrl;
  if (p.type !== 'xtream' || !p.server) return null;
  const q = new URLSearchParams({ username: p.username, password: p.password });
  return `${p.server}/xmltv.php?${q}`;
}

export class Epg {
  constructor(store, catalog, dataDir) {
    this.store = store;
    this.catalog = catalog;
    this.dir = dataDir ? join(dataDir, 'cache') : null;
    this.cache = new TTLCache(20000, TTL);
    this.inflight = new Map();
    this.limit = limiter(2);
    // playlistId -> { at, byChannel: Map(epgId -> [Program]), wanted: Set, loading, failed, restored }
    this.xmltv = new Map();
    this.normTitles = new WeakMap(); // programme -> title for searching (worked out once)
  }

  async programs(id, count) {
    const e = this.catalog.entry('live', id);
    const p = this.catalog.playlistFor(id);
    if (!e || !p) return [];

    const url = xmltvUrl(p);
    if (url) {
      const st = await this.xmltvState(p);
      // First download in progress: wait a while (usually enough), otherwise answer empty.
      if (!st.byChannel && st.loading) await Promise.race([st.loading, sleep(4000)]);
      if (st.byChannel) {
        this.maybeGrow(p, st, e.o.epgId && e.o.epgId.toLowerCase());
        return (e.o.epgId && st.byChannel.get(e.o.epgId.toLowerCase())) || [];
      }
      // First download in progress – answer empty rather than asking channel by channel.
      if (!st.failed) return [];
    }
    if (p.type !== 'xtream') return [];

    const key = id + ':' + (count > 8 ? 'g' : 's');
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const job = this.limit(() => xtreamShortEpg(p, e.sid, count))
      .then((list) => {
        this.cache.set(key, list);
        return list;
      })
      .catch((err) => {
        // Short negative cache so that a broken channel is not asked again all the time.
        this.cache.set(key, [], 60000);
        if (!/HTTP 4/.test(err.message)) warn(`EPG ${id}: ${err.message}`);
        return [];
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  async nowNext(ids) {
    const now = Date.now();
    const out = {};
    await Promise.all(ids.map(async (id) => {
      const list = await this.programs(id, 6);
      let cur = null;
      let next = null;
      for (const p of list) {
        if (p.end <= now) continue;
        if (!cur && p.start <= now) cur = p;
        else if (!next && p.start > now) next = p;
        if (cur && next) break;
      }
      out[id] = { now: cur, next };
    }));
    return out;
  }

  // The rest of the day (the next 24 hours, at most 40 programmes).
  async guide(id) {
    const now = Date.now();
    const list = await this.programs(id, 40);
    return list.filter((p) => p.end > now && p.start < now + 24 * 3600e3).slice(0, 40);
  }

  // Schedule for several channels within a time window (for the TV's grid).
  async grid(ids, from, to) {
    const out = {};
    await Promise.all(ids.map(async (id) => {
      const list = await this.programs(id, 40);
      out[id] = list.filter((p) => p.end > from && p.start < to);
    }));
    return out;
  }

  // --- XMLTV ---------------------------------------------------------------------------------

  wantedFor(p, st) {
    const wanted = new Set(st && st.extra ? st.extra : []);
    for (const e of this.catalog.visibleEntries('live')) if (e.o.playlistId === p.id && e.o.epgId) wanted.add(e.o.epgId.toLowerCase());
    for (const c of this.catalog.favoriteChannels()) if (c.playlistId === p.id && c.epgId) wanted.add(c.epgId.toLowerCase());
    return wanted;
  }

  // epgId -> how far back programmes are kept (ms since the epoch). Only catch-up channels get more than 3 h.
  pastFor(p) {
    const now = Date.now();
    const out = new Map();
    const add = (c) => {
      if (c.playlistId !== p.id || !c.epgId || !c.catchup) return;
      const from = now - Math.min(c.catchupDays || 3, CATCHUP_MAX_DAYS) * 86400e3;
      const k = c.epgId.toLowerCase();
      if (!out.has(k) || out.get(k) > from) out.set(k, from);
    };
    for (const e of this.catalog.visibleEntries('live')) add(e.o);
    for (const c of this.catalog.favoriteChannels()) add(c);
    return out;
  }

  // Programme search in the guide ("Allsvenskan"): what is on now and later, plus past programmes on
  // channels with catch-up. Only your channels (visible categories and favourites).
  search(q, { limit = 40 } = {}) {
    const words = norm(q).split(' ').filter(Boolean);
    if (!words.length) return [];
    const now = Date.now();
    const chans = new Map(); // "<pl>|<epgid>" -> channel (favourites first)
    const put = (c) => {
      if (!c.epgId) return;
      const k = c.playlistId + '|' + c.epgId.toLowerCase();
      if (!chans.has(k)) chans.set(k, c);
    };
    for (const c of this.catalog.favoriteChannels()) put(c);
    for (const e of this.catalog.visibleEntries('live')) put(e.o);
    const hits = [];
    for (const [pid, st] of this.xmltv) {
      if (!st.byChannel) continue;
      for (const [epgId, list] of st.byChannel) {
        const ch = chans.get(pid + '|' + epgId);
        if (!ch) continue;
        const oldest = ch.catchup ? now - Math.min(ch.catchupDays || 3, CATCHUP_MAX_DAYS) * 86400e3 : now;
        for (const p of list) {
          if (p.end <= oldest) continue;
          let n = this.normTitles.get(p);
          if (n == null) {
            n = ' ' + norm(p.title);
            this.normTitles.set(p, n);
          }
          if (!words.every((w) => n.includes(' ' + w))) continue;
          hits.push({ channel: ch, program: p, live: p.start <= now && p.end > now, past: p.end <= now });
        }
      }
    }
    // What is on now first, then upcoming in time order, past ones last (most recent first).
    hits.sort((a, b) => (b.live - a.live) || (a.past - b.past) || (a.past ? b.program.start - a.program.start : a.program.start - b.program.start));
    return hits.slice(0, limit).map((h) => ({ channel: h.channel, program: h.program }));
  }

  async xmltvState(p) {
    let st = this.xmltv.get(p.id);
    if (!st) {
      st = { at: 0, byChannel: null, wanted: new Set(), extra: new Set(), loading: null, failed: false, restored: false };
      this.xmltv.set(p.id, st);
    }
    if (!st.restored) {
      st.restored = true;
      await this.restore(p, st);
    }
    const age = Date.now() - st.at;
    if (!st.loading && (age > XMLTV_MAX_AGE || (st.failed && age > XMLTV_RETRY) || (!st.byChannel && !st.failed && !st.at))) {
      st.loading = this.loadXmltv(p, st);
    }
    return st;
  }

  // Channels added to the curation after the latest download: fetch again, but not too often.
  maybeGrow(p, st, epgId) {
    if (!epgId || st.wanted.has(epgId)) return;
    if (!st.extra.has(epgId)) {
      st.extra.add(epgId);
      // Oldest out first (a Set keeps insertion order).
      while (st.extra.size > EXTRA_MAX) st.extra.delete(st.extra.values().next().value);
    }
    if (st.loading) return;
    if (st.wanted.size && Date.now() - st.at < XMLTV_GROW_DELAY) return;
    st.loading = this.loadXmltv(p, st);
  }

  file(p) {
    return this.dir ? join(this.dir, `${p.id}.epg.json`) : null;
  }

  async restore(p, st) {
    const f = this.file(p);
    if (!f) return;
    try {
      const d = JSON.parse(await readFile(f, 'utf8'));
      if (!d || !d.at || Date.now() - d.at > 36 * 3600e3) return;
      st.byChannel = new Map(Object.entries(d.channels || {}));
      st.wanted = new Set(d.wanted || []);
      st.extra = new Set(d.extra || []);
      st.at = d.at;
      log(`EPG ${p.id}: ${st.byChannel.size} channels from disk`);
    } catch { /* no saved EPG */ }
  }

  async loadXmltv(p, st) {
    const url = xmltvUrl(p);
    const wanted = this.wantedFor(p, st);
    const t0 = Date.now();
    try {
      // Nothing chosen yet: do not download the provider's whole EPG needlessly.
      if (!wanted.size) {
        st.byChannel = st.byChannel || new Map();
        st.wanted = wanted;
        st.at = Date.now();
        st.failed = false;
        return;
      }
      const res = await fetchWithTimeout(url, { timeout: 15 * 60e3, userAgent: p.userAgent || undefined, provider: true });
      let stream = Readable.fromWeb(res.body);
      if (/\.gz(\?|$)/i.test(url) || /gzip/.test(res.headers.get('content-type') || '')) stream = stream.pipe(createGunzip());
      const byChannel = await parseXmltv(stream, wanted, this.pastFor(p));
      st.byChannel = byChannel;
      st.wanted = wanted;
      st.at = Date.now();
      st.failed = false;
      this.cache.clear();
      log(`EPG ${p.id}: xmltv with ${byChannel.size} of ${wanted.size} channels in ${Math.round((Date.now() - t0) / 1000)} s`);
      const f = this.file(p);
      if (f) {
        const channels = {};
        for (const [k, v] of byChannel) channels[k] = v;
        writeAtomic(f, JSON.stringify({ at: st.at, wanted: [...wanted], extra: [...st.extra], channels })).catch((e) => warn('could not save EPG', e.message));
      }
    } catch (e) {
      st.at = Date.now();
      // If we have nothing at all: fall back to get_short_epg (carefully). Otherwise keep the old one.
      if (!st.byChannel) st.failed = true;
      warn(`EPG ${p.id}: xmltv failed (${e.message})`);
    } finally {
      st.loading = null;
    }
  }
}

function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(s || '');
  if (!m) return null;
  const tz = m[7] || '+0000';
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${tz.slice(0, 3)}:${tz.slice(3)}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const unxml = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .trim();

async function parseXmltv(stream, wanted, pastFor = new Map()) {
  const from = Date.now() - PAST_DEFAULT;
  const oldest = Math.min(from, ...pastFor.values());
  const to = Date.now() + 36 * 3600e3;
  const out = new Map();
  let buf = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    buf += chunk;
    let end;
    while ((end = buf.indexOf('</programme>')) >= 0) {
      const start = buf.lastIndexOf('<programme', end);
      const block = start >= 0 ? buf.slice(start, end) : '';
      buf = buf.slice(end + 12);
      if (!block) continue;
      const ch = /channel="([^"]*)"/.exec(block);
      const id = ch ? unxml(ch[1]).toLowerCase() : '';
      if (!id || !wanted.has(id)) continue;
      const s = xmltvTime((/start="([^"]*)"/.exec(block) || [])[1]);
      const e = xmltvTime((/stop="([^"]*)"/.exec(block) || [])[1]);
      if (!s || !e || e < oldest || s > to) continue;
      if (e < from && !(pastFor.has(id) && e >= pastFor.get(id))) continue;
      const title = unxml((/<title[^>]*>([\s\S]*?)<\/title>/.exec(block) || [])[1]);
      const desc = unxml((/<desc[^>]*>([\s\S]*?)<\/desc>/.exec(block) || [])[1]);
      if (!out.has(id)) out.set(id, []);
      out.get(id).push({ title, start: s, end: e, desc });
    }
    // Guard against gigantic blocks without an end tag.
    if (buf.length > 4e6) buf = buf.slice(-1e6);
  }
  for (const list of out.values()) list.sort((a, b) => a.start - b.start);
  return out;
}
