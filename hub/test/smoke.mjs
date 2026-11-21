#!/usr/bin/env node
// Smoke test for the hub: starts the demo provider + a hub on free ports and goes through every route.
//   node hub/test/smoke.mjs            (or  npm --prefix hub test)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { Tmdb } from '../lib/tmdb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const mocks = await import(join(ROOT, 'scripts', 'dev-mocks.mjs'));

const results = [];
let failed = 0;

function ok(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  if (!cond) failed++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? '  ' + extra : ''}`);
}

const freePort = () => new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});

// --- Demo provider -------------------------------------------------------------------------
const mockPort = await freePort();
const mockServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/__xtream/') && (await mocks.handleXtream(req, res, url))) return;
  if (url.pathname.startsWith('/__mock/') && (await mocks.handle(req, res, url))) return;
  res.writeHead(404).end();
});
await new Promise((r) => mockServer.listen(mockPort, r));
const XT = `http://localhost:${mockPort}/__xtream`;

// --- Hub -------------------------------------------------------------------------------------
const hubPort = await freePort();
const dataDir = mkdtempSync(join(tmpdir(), 'g3hub-test-'));
const hub = spawn(process.execPath, [join(ROOT, 'hub', 'server.mjs'), '--port', String(hubPort), '--data', dataDir, '--seed-demo', XT], { stdio: ['ignore', 'pipe', 'pipe'] });
let hubLog = '';
hub.stdout.on('data', (c) => { hubLog += c; });
hub.stderr.on('data', (c) => { hubLog += c; });
const H = `http://localhost:${hubPort}`;

function cleanup() {
  try { hub.kill('SIGTERM'); } catch {}
  mockServer.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

async function req(path, opts = {}) {
  const t0 = performance.now();
  const res = await fetch(H + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const ms = performance.now() - t0;
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, ms, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(150);
  }
  return null;
}

async function median(path, n = 7) {
  const times = [];
  for (let i = 0; i < n; i++) times.push((await req(path)).ms);
  times.sort((a, b) => a - b);
  return times[Math.floor(n / 2)];
}

// Read SSE events.
function openEvents(path) {
  const events = [];
  const r = http.get(H + path, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (ev) events.push({ event: ev[1], data: data ? JSON.parse(data[1]) : null });
      }
    });
  });
  return { events, close: () => r.destroy() };
}

try {
  console.log(`\nG3 Hub smoke test  (hub :${hubPort}, provider :${mockPort})\n`);

  const health = await waitFor(async () => (await req('/api/health')).data.ok);
  ok('the hub starts', health);
  const loaded = await waitFor(async () => {
    const s = (await req('/api/admin/status')).data;
    return s.playlists[0] && s.playlists[0].status.ok && s;
  }, 60000);
  ok('the demo catalogue loads', loaded, loaded ? `${loaded.counts.live} channels, ${loaded.counts.vod} movies, ${loaded.counts.series} series` : hubLog.slice(-400));

  // --- CORS
  {
    const r = await fetch(H + '/api/tv/favorites/toggle', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    ok('CORS preflight', r.status === 204 && r.headers.get('access-control-allow-origin') === '*' && /content-type/i.test(r.headers.get('access-control-allow-headers')));
  }

  // --- Bootstrap
  const boot = await req('/api/tv/bootstrap');
  const b = boot.data;
  ok('bootstrap', boot.status === 200 && typeof b.rev === 'number' && b.live.categories.length > 0 && b.vod.categories.length > 0 && b.series.categories.length > 0 && Array.isArray(b.continue),
    `${b.live.categories.length} live categories, ${b.live.favorites.length} favourites`);
  ok('demo curation (favourites + Swedish categories)', b.live.favorites.length >= 8 && b.live.categories[0].name.startsWith('SE'));
  const fav0 = b.live.favorites[0];
  ok('channel object matches the contract', fav0 && ['id', 'playlistId', 'name', 'logo', 'num', 'categoryId', 'epgId', 'url', 'catchup'].every((k) => k in fav0) && /\/live\/demo\/demo\/\d+\.m3u8$/.test(fav0.url));
  ok('image proxy rewrites logos (separate image port)', fav0 && b.imgBase === `http://localhost:${hubPort + 1}` && fav0.logo.startsWith(b.imgBase + '/api/img?u='), b.imgBase);
  {
    const r = await fetch(fav0.logo + '&w=160');
    ok('the image port responds', r.status === 200 || r.status === 502, `HTTP ${r.status}`);
    const again = await req('/api/tv/bootstrap?since=' + b.hash);
    ok('bootstrap ?since=hash → same', again.data && again.data.same === true && again.data.hash === b.hash);
  }

  // --- Channels
  const cat = b.live.categories[0];
  const ch = await req(`/api/live/channels?category=${encodeURIComponent(cat.id)}`);
  ok('channels per category', ch.status === 200 && ch.data.items.length === cat.count, `${ch.data.items.length} channels`);
  const favs = await req('/api/live/channels?category=favorites');
  ok('channels: favorites', favs.data.items.length === b.live.favorites.length);
  const allCats = (await req('/api/admin/categories?kind=live')).data.items;
  const biggest = allCats.reduce((a, c) => (c.count > a.count ? c : a), allCats[0]);
  const big = await req(`/api/live/channels?category=${encodeURIComponent(biggest.id)}`);
  ok('large category', big.data.items.length === biggest.count, `${biggest.count} channels in ${big.ms.toFixed(0)} ms`);

  // --- EPG
  const ids = b.live.favorites.slice(0, 3).map((c) => c.id);
  const epg = await req('/api/live/epg?ids=' + ids.join(','));
  ok('EPG now/next', epg.status === 200 && epg.data.epg[ids[0]] && epg.data.epg[ids[0]].now && epg.data.epg[ids[0]].now.title && epg.data.epg[ids[0]].next, epg.data.epg[ids[0]] && epg.data.epg[ids[0]].now ? epg.data.epg[ids[0]].now.title : '');
  const guide = await req('/api/live/guide?id=' + ids[0]);
  ok('EPG schedule', guide.data.items.length > 5, `${guide.data.items.length} programmes`);

  // --- Films
  const recent = await req('/api/vod/list?category=recent&limit=20');
  ok('movies: recently added', recent.data.items.length === 20 && recent.data.items[0].added >= recent.data.items[19].added, `total ${recent.data.total}`);
  const vcat = b.vod.categories[0];
  const vl = await req(`/api/vod/list?category=${encodeURIComponent(vcat.id)}&sort=name&limit=500`);
  ok('movies per category (sort=name)', vl.data.total === vcat.count && vl.data.items[0].title.localeCompare(vl.data.items[1].title, 'en') <= 0);
  const movie = recent.data.items[0];
  const mi = await req('/api/vod/info?id=' + encodeURIComponent(movie.id));
  ok('movie info', mi.status === 200 && mi.data.url && mi.data.plot && mi.data.duration > 0 && mi.data.backdrop, `${mi.data.title} (${mi.data.year})`);

  // --- Series
  const sl = await req('/api/series/list?category=recent&limit=10');
  ok('series: recently added', sl.data.items.length === 10);
  const series = sl.data.items[0];
  const si = await req('/api/series/info?id=' + encodeURIComponent(series.id));
  const s1 = si.data.seasons && si.data.seasons[0];
  ok('series info with seasons and episodes', si.status === 200 && s1 && s1.episodes.length > 0 && s1.episodes[0].url && s1.episodes[0].still, `${si.data.seasons.length} seasons`);
  {
    // The provider's "Säsong 1" is a generic name: it is shown in the reader's language.
    const siSv = await req('/api/series/info?id=' + encodeURIComponent(series.id), { headers: { 'Accept-Language': 'sv' } });
    ok('series info: season names in the language of the reader', s1.name === 'Season ' + s1.season && siSv.data.seasons[0].name === 'Säsong ' + s1.season, `${s1.name} / ${siSv.data.seasons[0].name}`);
  }

  // --- Search
  const s = await req('/api/search?q=svt');
  ok('search channels', s.data.live.length >= 3 && s.data.live.every((c) => /svt/i.test(c.name)), s.data.live.slice(0, 3).map((c) => c.name).join(', '));
  const s2 = await req('/api/search?q=hockey&all=1');
  ok('search everything (all=1)', s2.data.live.length > 0);
  const s3 = await req('/api/search?q=' + encodeURIComponent(movie.title.split(' ').slice(-1)[0]));
  ok('search movies', s3.data.vod.length > 0);
  const s4 = await req('/api/search?q=' + encodeURIComponent('skargardsnatt'));
  ok('search without diacritics', s4.data.vod.some((m) => /Skärgårdsnatt/.test(m.title)) || s4.data.series.some((m) => /Skärgårdsnatt/.test(m.title)));

  // --- SSE + TV changes
  const ev = openEvents('/api/events');
  await waitFor(() => ev.events.length > 0, 3000);
  ok('SSE: first rev', ev.events[0] && ev.events[0].event === 'rev');
  const target = big.data.items[5].id;
  const t1 = await req('/api/tv/favorites/toggle', { method: 'POST', body: { id: target } });
  ok('favourite on', t1.data.favorite === true);
  const gotRev = await waitFor(() => ev.events.find((e) => e.event === 'rev' && e.data.reason === 'favorites'), 3000);
  ok('SSE: rev after a favourite change', gotRev, gotRev ? `rev ${gotRev.data.rev}` : '');
  const boot2 = (await req('/api/tv/bootstrap')).data;
  ok('the favourite shows in bootstrap', boot2.live.favorites.some((c) => c.id === target) && boot2.rev > b.rev);
  await req('/api/tv/favorites/move', { method: 'POST', body: { id: target, delta: -1 } });
  const boot3 = (await req('/api/tv/bootstrap')).data;
  ok('move favourite', boot3.live.favorites[boot3.live.favorites.length - 2].id === target);
  await req('/api/tv/favorites/toggle', { method: 'POST', body: { id: target } });

  const c2 = b.live.categories[1];
  await req('/api/tv/categories/move', { method: 'POST', body: { kind: 'live', id: c2.id, delta: -1 } });
  const boot4 = (await req('/api/tv/bootstrap')).data;
  ok('move category', boot4.live.categories[0].id === c2.id);
  await req('/api/tv/categories/hide', { method: 'POST', body: { kind: 'live', id: c2.id } });
  const boot5 = (await req('/api/tv/bootstrap')).data;
  ok('hide category', !boot5.live.categories.some((c) => c.id === c2.id));

  // --- Continue watching
  await req('/api/tv/progress', { method: 'POST', body: { id: movie.id, kind: 'vod', position: 600, duration: 5400 } });
  let cont = (await req('/api/tv/bootstrap')).data.continue;
  ok('continue watching: movie saved', cont.some((p) => p.id === movie.id && p.position === 600 && p.title));
  const gotCont = await waitFor(() => ev.events.find((e) => e.event === 'continue'), 3000);
  ok('SSE: continue event', gotCont);
  const ep = s1.episodes[0];
  await req('/api/tv/progress', { method: 'POST', body: { id: ep.id, kind: 'episode', seriesId: series.id, position: (ep.duration || 2400) - 30, duration: ep.duration || 2400 } });
  cont = (await req('/api/tv/bootstrap')).data.continue;
  const next = s1.episodes[1] || (si.data.seasons[1] && si.data.seasons[1].episodes[0]);
  ok('finished episode → the next episode is queued', !next || cont.some((p) => p.id === next.id && p.next), next ? next.title : 'no next episode');
  await req('/api/tv/progress', { method: 'POST', body: { id: movie.id, kind: 'vod', position: 5300, duration: 5400 } });
  cont = (await req('/api/tv/bootstrap')).data.continue;
  ok('a finished movie is removed', !cont.some((p) => p.id === movie.id));
  const mi2 = await req('/api/vod/info?id=' + encodeURIComponent(movie.id));
  ok('movie info has a progress field', 'progress' in mi2.data);
  ev.close();

  // --- Image proxy
  const imgUrl = mi.data.poster;
  const i1 = await req(new URL(imgUrl).pathname + new URL(imgUrl).search + '&w=300');
  ok('image proxy', i1.status === 200 && /image\//.test(i1.headers.get('content-type')), `${i1.headers.get('content-type')} ${i1.data.byteLength} B`);
  const i2 = await req(new URL(imgUrl).pathname + new URL(imgUrl).search + '&w=300');
  ok('image proxy caches', i2.status === 200 && i2.ms < i1.ms + 5, `${i1.ms.toFixed(0)} → ${i2.ms.toFixed(0)} ms`);
  const bad = await req('/api/img?u=file%3A%2F%2F%2Fetc%2Fpasswd');
  ok('image proxy rejects non-http', bad.status === 400);

  // --- Admin
  const pls = (await req('/api/admin/playlists')).data.items;
  ok('admin: playlists without passwords', pls.length === 1 && !('password' in pls[0]) && pls[0].hasPassword);
  const t = await req('/api/admin/playlists/test', { method: 'POST', body: { type: 'xtream', server: XT, username: 'demo', password: 'fel' } });
  ok('admin: test with a wrong password (English by default)', t.data.ok === false && /refused/.test(t.data.error), t.data.error);
  const tSv = await req('/api/admin/playlists/test', { method: 'POST', body: { type: 'xtream', server: XT, username: 'demo', password: 'fel' }, headers: { 'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8' } });
  ok('admin: test with a wrong password (Accept-Language: sv)', tSv.data.ok === false && /nekades/.test(tSv.data.error), tSv.data.error);
  const t2 = await req('/api/admin/playlists/test', { method: 'POST', body: { id: pls[0].id } });
  ok('admin: test with the saved password', t2.data.ok === true);
  const cats = (await req('/api/admin/categories?kind=live')).data.items;
  const want = cats.filter((c) => /^UK \|/.test(c.name)).map((c) => c.id);
  await req('/api/admin/categories?kind=live', { method: 'PUT', body: { visible: want, order: want.concat(cats.map((c) => c.id).filter((id) => !want.includes(id))) } });
  const boot6 = (await req('/api/tv/bootstrap')).data;
  ok('admin: choose categories', boot6.live.categories.length === want.length && boot6.live.categories.every((c) => c.name.startsWith('UK')));
  const chs = await req('/api/admin/channels?q=eurosport');
  ok('admin: channel search across everything', chs.data.total > 0 && 'favorite' in chs.data.items[0] && 'categoryName' in chs.data.items[0]);
  const favIds = boot6.live.favorites.map((c) => c.id).reverse();
  await req('/api/admin/favorites', { method: 'PUT', body: { ids: favIds } });
  ok('admin: favourite order', (await req('/api/tv/bootstrap')).data.live.favorites[0].id === favIds[0]);

  // --- Backup, provider pause, programme search, catch-up
  {
    const st = await req('/api/admin/status');
    ok('admin: status has pauses', Array.isArray(st.data.pauses));
    const bk = await req('/api/admin/backup');
    ok('admin: backup', bk.status === 200 && bk.data.kind === 'g3hub-backup' && bk.data.config.playlists.length > 0 && bk.data.config.playlists[0].password);
    const favBefore = bk.data.config.favorites.slice();
    await req('/api/admin/favorites', { method: 'PUT', body: { ids: favBefore.slice(1) } });
    const rs = await req('/api/admin/restore', { method: 'POST', body: bk.data });
    const after = await req('/api/admin/favorites');
    ok('admin: restore', rs.status === 200 && after.data.items.map((f) => f.id).join() === favBefore.join(), `${favBefore.length} favourites`);
    const bad = await req('/api/admin/restore', { method: 'POST', body: { hej: 1 } });
    ok('admin: restore rejects a wrong file', bad.status === 400);
    await req('/api/live/epg?ids=' + encodeURIComponent(favBefore[0]));
    await new Promise((r) => setTimeout(r, 2500));
    const es = await req('/api/epg/search?q=nyheter');
    ok('programme search', es.status === 200 && Array.isArray(es.data.items), `${es.data.items.length} hits`);
    const nocu = await req('/api/live/catchup?id=' + encodeURIComponent(favBefore[0]) + '&start=' + (Date.now() - 3600e3) + '&end=' + (Date.now() - 1800e3));
    ok('catch-up responds (a URL or "no catch-up")', nocu.status === 200 ? /\/timeshift\//.test(nocu.data.url) : nocu.status === 400);
  }

  // --- Language
  {
    const st = (await req('/api/admin/settings')).data.settings;
    ok('language: a new hub is English, the TMDB language follows the hub', st.language === 'en' && st.tmdbLanguage === '', JSON.stringify({ language: st.language, tmdbLanguage: st.tmdbLanguage }));
    const en = await req('/api/vod/info?id=finns-inte', { headers: { 'Accept-Language': 'en' } });
    const sv = await req('/api/vod/info?id=finns-inte', { headers: { 'Accept-Language': 'sv' } });
    ok('language: Accept-Language en → English error, sv → Swedish', en.status === 404 && en.data.error === 'The movie doesn\'t exist' && sv.status === 404 && sv.data.error === 'Filmen finns inte', `${en.data.error} / ${sv.data.error}`);
    const prio = await req('/api/nope', { headers: { 'Accept-Language': 'de-DE,de;q=0.9,sv;q=0.8,en;q=0.7' } });
    ok('language: the first language the hub knows is chosen (de → sv)', prio.status === 404 && prio.data.error === 'Okänd väg: /api/nope', prio.data.error);
    await req('/api/admin/settings', { method: 'PUT', body: { language: 'sv' } });
    const fb = await req('/api/vod/info?id=finns-inte', { headers: { 'Accept-Language': 'de' } });
    const boot = await req('/api/tv/bootstrap', { headers: { 'Accept-Language': 'fr' } });
    ok('language: an unknown language → the hub language', fb.data.error === 'Filmen finns inte' && boot.status === 200, fb.data.error);
    const bad = await req('/api/admin/settings', { method: 'PUT', body: { language: 'de' } });
    ok('language: only en and sv are saved', bad.data.settings.language === 'sv');
    await req('/api/admin/settings', { method: 'PUT', body: { language: 'en' } });
    const back = await req('/api/vod/info?id=finns-inte');
    ok('language: back to English', back.data.error === 'The movie doesn\'t exist', back.data.error);
  }

  // --- Language: hubs from before the language setting stay Swedish; the TMDB language follows the hub
  {
    const dirs = [];
    const dirWith = (config) => {
      const d = mkdtempSync(join(tmpdir(), 'g3hub-lang-'));
      dirs.push(d);
      if (config) writeFileSync(join(d, 'config.json'), JSON.stringify(config));
      return d;
    };
    const tmdbLang = async (store, dir) => {
      const t = new Tmdb(store, dir);
      let lang = null;
      t.get = async (path, params) => { lang = lang || params.language; return { id: 1, overview: 'x' }; };
      await t.fetch('vod', 'Film', 2020, '1', 1000);
      return lang;
    };
    try {
      const oldDir = dirWith({ version: 1, rev: 5, settings: { name: 'Gammal', tmdbLanguage: 'sv-SE' }, playlists: [] });
      const old = new Store(oldDir);
      await old.flush();
      const saved = JSON.parse(readFileSync(join(oldDir, 'config.json'), 'utf8'));
      ok('language: an existing config without a language becomes Swedish, and that is saved', old.settings.language === 'sv' && saved.settings.language === 'sv' && saved.settings.name === 'Gammal' && saved.rev === 5, JSON.stringify(saved.settings));
      const olderDir = dirWith({ settings: { name: 'Äldst' }, playlists: [] });
      const older = new Store(olderDir);
      await older.flush();
      const freshDir = dirWith(null);
      const fresh = new Store(freshDir);
      ok('language: a new data directory becomes English', fresh.settings.language === 'en' && fresh.settings.tmdbLanguage === '');
      const explicit = new Store(dirWith({ settings: { language: 'en', tmdbLanguage: 'de-DE' }, playlists: [] }));
      const langs = [await tmdbLang(old, oldDir), await tmdbLang(older, olderDir), await tmdbLang(fresh, freshDir), await tmdbLang(explicit, freshDir)];
      ok('language: TMDB sv-SE for a Swedish hub, en-US for an English one, a saved language wins', langs.join() === 'sv-SE,sv-SE,en-US,de-DE', langs.join());
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  }

  // Tokens
  await req('/api/admin/settings', { method: 'PUT', body: { tvToken: 'hemlig' } });
  const noTok = await req('/api/tv/bootstrap');
  const withTok = await req('/api/tv/bootstrap', { headers: { 'X-Hub-Token': 'hemlig' } });
  const qTok = await req('/api/tv/bootstrap?token=hemlig');
  ok('TV token required when set', noTok.status === 401 && withTok.status === 200 && qTok.status === 200);
  await req('/api/admin/settings', { method: 'PUT', body: { tvToken: '', adminToken: 'admin1' } });
  const adm = await req('/api/admin/status');
  const adm2 = await req('/api/admin/status', { headers: { 'X-Hub-Token': 'admin1' } });
  ok('admin token required when set', adm.status === 401 && adm2.status === 200);
  const admSv = await req('/api/admin/status', { headers: { 'Accept-Language': 'sv' } });
  ok('admin token: the error in Swedish', admSv.data.error === 'Fel eller saknad admin-token' && adm.data.error === 'Wrong or missing admin token', `${adm.data.error} / ${admSv.data.error}`);
  await req('/api/admin/settings', { method: 'PUT', body: { adminToken: '' }, headers: { 'X-Hub-Token': 'admin1' } });

  // --- M3U playlist
  // A saved error is shown in the reader's language (REST: Accept-Language, SSE: ?lang=).
  const adminEv = openEvents('/api/events?admin=1&lang=sv');
  await waitFor(() => adminEv.events.length > 0, 3000);
  {
    const broken = await req('/api/admin/playlists', { method: 'POST', body: { name: 'Trasig', type: 'm3u', m3uUrl: `${XT}/finns-inte.m3u` } });
    const bid = broken.data.item.id;
    const en = await waitFor(async () => (await req('/api/admin/playlists')).data.items.find((p) => p.id === bid && p.status.error), 15000);
    const sv = (await req('/api/admin/playlists', { headers: { 'Accept-Language': 'sv' } })).data.items.find((p) => p.id === bid);
    ok('a playlist error is saved and shown in the language of the reader', en && /^HTTP 404 from /.test(en.status.error) && /^HTTP 404 från /.test(sv.status.error), `${en && en.status.error} / ${sv && sv.status.error}`);
    const ssePl = await waitFor(() => adminEv.events.filter((e) => e.event === 'status').flatMap((e) => e.data.playlists).find((p) => p.id === bid && p.error), 3000);
    ok('SSE status (admin, lang=sv): the error in Swedish', ssePl && /^HTTP 404 från /.test(ssePl.error), ssePl && ssePl.error);
    await req('/api/admin/playlists/' + bid, { method: 'DELETE' });
  }
  adminEv.close();
  const add = await req('/api/admin/playlists', { method: 'POST', body: { name: 'M3U-test', type: 'm3u', m3uUrl: `${XT}/get.php?username=demo&password=demo&output=m3u8` } });
  const pid = add.data.item.id;
  const m3u = await waitFor(async () => {
    const st = (await req('/api/admin/playlists')).data.items.find((p) => p.id === pid);
    return st && st.status.ok && st;
  }, 30000);
  ok('M3U playlist loads', m3u && m3u.status.counts.live > 20000 && m3u.status.counts.vod > 1000, m3u ? `${m3u.status.counts.live} channels, ${m3u.status.counts.vod} movies` : '');
  const m3uCats = (await req('/api/admin/categories?kind=live')).data.items.filter((c) => c.playlistId === pid);
  ok('M3U: categories from group-title', m3uCats.length > 300);
  const del = await req('/api/admin/playlists/' + pid, { method: 'DELETE' });
  ok('delete playlist', del.status === 200 && !(await req('/api/admin/playlists')).data.items.some((p) => p.id === pid));

  // --- Web admin
  const web = await fetch(H + '/');
  const html = await web.text();
  ok('the web admin is served', web.status === 200 && html.includes('G3 Hub') && html.includes('app.js'));
  const deep = await fetch(H + '/kanaler');
  ok('unknown page paths return index.html', deep.status === 200);

  // --- Performance
  console.log('\n  Performance (median of 7):');
  const perf = {
    bootstrap: await median('/api/tv/bootstrap'),
    channels: await median(`/api/live/channels?category=${encodeURIComponent(biggest.id)}`),
    search: await median('/api/search?q=sport&all=1'),
    searchShort: await median('/api/search?q=a&all=1'),
    vodRecent: await median('/api/vod/list?category=recent&limit=60')
  };
  for (const [k, v] of Object.entries(perf)) console.log(`    ${k.padEnd(12)} ${v.toFixed(1)} ms`);
  ok('bootstrap < 50 ms', perf.bootstrap < 50);
  ok('channels per category < 30 ms', perf.channels < 30);
  ok('search < 80 ms', perf.search < 80 && perf.searchShort < 80);
} catch (e) {
  console.error(e);
  failed++;
}

console.log(`\n${failed ? '✗' : '✓'} ${results.length - failed}/${results.length} checks passed\n`);
if (failed) console.log('Hub log (tail):\n' + hubLog.slice(-1500));
cleanup();
process.exit(failed ? 1 : 0);
