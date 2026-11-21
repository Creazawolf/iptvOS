// Providers: Xtream Codes (player_api.php) and M3U lists.
// Everything is normalised to the same compact form, see fetchCatalog().
import { createHash } from 'node:crypto';
import { LocalError, msg, msgOf, tr } from './i18n.mjs';
import { fetchJson, fetchJsonList, fetchWithTimeout, num, rating, splitTitle } from './util.mjs';

const BIG = 300000; // timeout for whole lists (large providers are sluggish)

// --- Xtream ---------------------------------------------------------------------------

function api(p, params) {
  const q = new URLSearchParams({ username: p.username, password: p.password, ...params });
  return `${p.server}/player_api.php?${q}`;
}

const enc = encodeURIComponent;

export function liveUrl(p, sid) {
  return `${p.server}/live/${enc(p.username)}/${enc(p.password)}/${sid}.${p.format === 'ts' ? 'ts' : 'm3u8'}`;
}

export function movieUrl(p, sid, ext) {
  return `${p.server}/movie/${enc(p.username)}/${enc(p.password)}/${sid}.${ext || 'mp4'}`;
}

// Catch-up (Xtream "timeshift"): the start time is given in the provider's time zone (server_info.timezone
// at login), the length in minutes. Always .ts – that variant is supported by practically every panel.
export function catchupUrl(p, sid, start, end, timezone) {
  const mins = Math.max(1, Math.ceil((end - start) / 60000));
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(start));
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(start));
  }
  const v = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const stamp = `${v.year}-${v.month}-${v.day}:${v.hour}-${v.minute}`;
  return `${p.server}/timeshift/${enc(p.username)}/${enc(p.password)}/${mins}/${stamp}/${sid}.ts`;
}

export function episodeUrl(p, epid, ext) {
  return `${p.server}/series/${enc(p.username)}/${enc(p.password)}/${epid}.${ext || 'mp4'}`;
}

const opts = (p, timeout) => ({ timeout, userAgent: p.userAgent || undefined, provider: true });

export async function xtreamLogin(p) {
  if (!p.server || !p.username) throw new LocalError('providers.serverAndUserRequired');
  const d = await fetchJson(api(p, {}), opts(p, 20000));
  const u = d && d.user_info;
  if (!u || Number(u.auth) !== 1) throw new LocalError('providers.loginDenied');
  return {
    status: u.status || '',
    message: u.message || '',
    expires: num(u.exp_date) ? Number(u.exp_date) * 1000 : null,
    maxConnections: num(u.max_connections),
    activeConnections: num(u.active_cons),
    trial: String(u.is_trial) === '1',
    formats: u.allowed_output_formats || [],
    timezone: d.server_info && d.server_info.timezone
  };
}

// Whole lists: streamed, one element at a time (see fetchJsonList).
function actionList(p, act, map, timeout = BIG) {
  return fetchJsonList(api(p, { action: act }), opts(p, timeout), map);
}

async function action(p, act, extra, timeout = BIG) {
  const d = await fetchJson(api(p, { action: act, ...(extra || {}) }), opts(p, timeout));
  return d;
}

const asList = (d) => (Array.isArray(d) ? d : d && typeof d === 'object' ? Object.values(d) : []);

const cats = (d) => asList(d)
  .filter((c) => c && c.category_id != null)
  .map((c) => ({ pid: String(c.category_id), name: String(c.category_name || tr('catalog.unnamed')).trim() }));

export async function xtreamCatalog(p, report = () => {}) {
  const info = await xtreamLogin(p);
  const out = { info, live: { cats: [], items: [] }, vod: { cats: [], items: [] }, series: { cats: [], items: [] }, errors: [] };

  report('live');
  // One list at a time (not in parallel): kinder to the provider and to memory.
  out.live.cats = cats(await action(p, 'get_live_categories'));
  out.live.items = await actionList(p, 'get_live_streams', (s) => (s.stream_id == null ? null : {
    sid: String(s.stream_id),
    name: String(s.name || '').trim(),
    logo: s.stream_icon || '',
    num: num(s.num),
    cat: s.category_id != null ? String(s.category_id) : '',
    epg: s.epg_channel_id || '',
    archive: Number(s.tv_archive) === 1,
    archiveDays: num(s.tv_archive_duration) || 0
  }));

  // Films and series: not every provider has them – errors here do not stop live TV.
  try {
    report('vod');
    out.vod.cats = cats(await action(p, 'get_vod_categories'));
    out.vod.items = await actionList(p, 'get_vod_streams', (s) => {
      if (s.stream_id == null) return null;
      const t = splitTitle(s.title || s.name, s.year);
      return {
        sid: String(s.stream_id),
        title: t.title,
        year: t.year,
        poster: s.stream_icon || '',
        rating: rating(s.rating, s.rating_5based),
        added: num(s.added),
        cat: s.category_id != null ? String(s.category_id) : '',
        ext: s.container_extension || 'mp4',
        tmdb: s.tmdb ? String(s.tmdb) : s.tmdb_id ? String(s.tmdb_id) : ''
      };
    });
  } catch (e) {
    out.errors.push(msg('providers.moviesFailed', { error: msgOf(e) }));
  }

  try {
    report('series');
    out.series.cats = cats(await action(p, 'get_series_categories'));
    out.series.items = await actionList(p, 'get_series', (s) => {
      if (s.series_id == null) return null;
      const t = splitTitle(s.title || s.name, s.year || (s.releaseDate || s.release_date || '').slice(0, 4));
      const bd = Array.isArray(s.backdrop_path) ? s.backdrop_path[0] : s.backdrop_path;
      return {
        sid: String(s.series_id),
        title: t.title,
        year: t.year,
        poster: s.cover || '',
        backdrop: bd || '',
        rating: rating(s.rating, s.rating_5based),
        added: num(s.last_modified),
        cat: s.category_id != null ? String(s.category_id) : '',
        tmdb: s.tmdb ? String(s.tmdb) : s.tmdb_id ? String(s.tmdb_id) : '',
        plot: s.plot || '',
        genre: s.genre || ''
      };
    });
  } catch (e) {
    out.errors.push(msg('providers.seriesFailed', { error: msgOf(e) }));
  }
  return out;
}

export async function xtreamVodInfo(p, sid) {
  return action(p, 'get_vod_info', { vod_id: sid }, 30000);
}

export async function xtreamSeriesInfo(p, sid) {
  return action(p, 'get_series_info', { series_id: sid }, 30000);
}

// Xtream sends EPG texts base64-encoded, but some panels send plain text.
const b64 = (s) => {
  if (!s) return '';
  const str = String(s).trim();
  if (str.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(str)) return str;
  const t = Buffer.from(str, 'base64').toString('utf8');
  return /[�\u0000-\u0008\u000E-\u001F]/.test(t) ? str : t;
};

function parseEpgTime(ts, str) {
  if (num(ts)) return Number(ts) * 1000;
  if (str) {
    const t = Date.parse(String(str).replace(' ', 'T'));
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export async function xtreamShortEpg(p, sid, limit = 4) {
  const d = await action(p, 'get_short_epg', { stream_id: sid, limit: String(limit) }, 15000);
  const list = (d && d.epg_listings) || [];
  return list.map((e) => ({
    title: b64(e.title).trim(),
    start: parseEpgTime(e.start_timestamp, e.start),
    end: parseEpgTime(e.stop_timestamp, e.end || e.stop),
    desc: b64(e.description).trim()
  })).filter((e) => e.start && e.end && e.title);
}

// --- M3U --------------------------------------------------------------------------------

const ATTR = /([\w-]+)="([^"]*)"/g;

export function parseM3u(text) {
  const live = { cats: [], items: [] };
  const vod = { cats: [], items: [] };
  const catIds = { live: new Map(), vod: new Map() };
  const catOf = (kind, name) => {
    const map = catIds[kind];
    // The id stays the same in every language (curation is keyed on it); only the name follows the hub.
    const key = name || 'Övrigt';
    if (!map.has(key)) {
      const pid = shortHash(kind + ':' + key);
      map.set(key, pid);
      (kind === 'live' ? live : vod).cats.push({ pid, name: name || tr('catalog.misc') });
    }
    return map.get(key);
  };

  const lines = text.split(/\r?\n/);
  let cur = null;
  let n = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      let m;
      ATTR.lastIndex = 0;
      while ((m = ATTR.exec(line))) attrs[m[1].toLowerCase()] = m[2];
      const comma = line.lastIndexOf(',');
      cur = { attrs, name: comma >= 0 ? line.slice(comma + 1).trim() : attrs['tvg-name'] || '' };
      continue;
    }
    if (line.startsWith('#EXTGRP:') && cur) {
      cur.attrs['group-title'] = cur.attrs['group-title'] || line.slice(8).trim();
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!cur) continue;
    const url = line;
    const a = cur.attrs;
    const isVod = /\/(movie|series)\//.test(url) || /\.(mp4|mkv|avi|mov)(\?|$)/i.test(url);
    const name = cur.name || a['tvg-name'] || tr('catalog.unnamed');
    if (isVod) {
      const t = splitTitle(name);
      vod.items.push({
        sid: shortHash(url),
        title: t.title,
        year: t.year,
        poster: a['tvg-logo'] || '',
        rating: null,
        added: null,
        cat: catOf('vod', a['group-title']),
        ext: (/\.(\w{2,4})(\?|$)/.exec(url) || [])[1] || 'mp4',
        tmdb: '',
        url
      });
    } else {
      n++;
      live.items.push({
        sid: shortHash(url),
        name,
        logo: a['tvg-logo'] || '',
        num: num(a['tvg-chno']) || n,
        cat: catOf('live', a['group-title']),
        epg: a['tvg-id'] || '',
        archive: !!a['catchup'] || !!a['tvg-rec'],
        url
      });
    }
    cur = null;
  }
  return { live, vod };
}

export async function m3uCatalog(p, report = () => {}) {
  if (!p.m3uUrl) throw new LocalError('providers.m3uMissing');
  report('live');
  const res = await fetchWithTimeout(p.m3uUrl, opts(p, BIG));
  const text = await res.text();
  if (!/#EXTM3U|#EXTINF/.test(text.slice(0, 4096))) throw new LocalError('providers.notM3u');
  const { live, vod } = parseM3u(text);
  return {
    info: { status: 'M3U', expires: null, maxConnections: null },
    live,
    vod,
    series: { cats: [], items: [] },
    errors: []
  };
}

export function shortHash(s) {
  return createHash('sha1').update(s).digest('base64url').slice(0, 10);
}

export async function testPlaylist(p) {
  if (p.type === 'm3u') {
    const res = await fetchWithTimeout(p.m3uUrl, { ...opts(p, 30000), headers: { Range: 'bytes=0-65535' } });
    const text = (await res.text()).slice(0, 65536);
    if (!/#EXTM3U|#EXTINF/.test(text)) throw new LocalError('providers.notM3u');
    return { status: 'M3U', entries: msg('providers.firstPart', { n: (text.match(/#EXTINF/g) || []).length }) };
  }
  return xtreamLogin(p);
}
