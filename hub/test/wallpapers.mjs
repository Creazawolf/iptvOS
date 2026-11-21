#!/usr/bin/env node
// Test of the wallpaper collections and the aerial film list (hub/lib/wallpapers.mjs) – without the internet:
// the sources' responses are small samples in the same format as the real ones.
//   node hub/test/wallpapers.mjs
// (hub/test/wallpapers-live.mjs runs the same parsers against the real sources, by hand.)
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AERIAL_PROXY_HOSTS, AerialProxy } from '../lib/aerialproxy.mjs';
import { setHubLanguage } from '../lib/i18n.mjs';
import { parseAerial, parseBing, parseChromecast, parseCommons, parseEarthView, parseTop100, Wallpapers, WALLPAPER_SETS } from '../lib/wallpapers.mjs';

let failed = 0;
let passed = 0;
function ok(name, cond, detail) {
  if (cond) passed++; else failed++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

console.log('\n  Wallpapers and aerial videos\n');

// --- The parsers ---------------------------------------------------------------------------------

const top = parseTop100(`
  <a href="/images/heic2017a/"><img class="x" src="https://cdn.esahubble.org/archives/images/wallpaper2/heic2017a.jpg" width="100" alt="Jupiter &amp; Europa"></a>
  <img data-lazy="https://cdn.esawebb.org/archives/images/wallpaper1/weic2218a-miri.jpg" alt="Pillars of Creation (MIRI)">
  <img src="https://cdn.esahubble.org/archives/images/wallpaper2/heic2017a.jpg" alt="Samma igen">
  <img src="https://cdn.esahubble.org/archives/images/screen/annat.jpg" alt="Inte en bakgrund">`, 'https://cdn.x/wallpaper4/', 'ESA');
ok('Top 100: src and data-lazy, ids with hyphens, duplicates removed', top.length === 2 && top[0].id === 'space:heic2017a' && top[1].id === 'space:weic2218a-miri', JSON.stringify(top.map((t) => t.id)));
ok('Top 100: title decoded, image from the large variant', top[0].title === 'Jupiter & Europa' && top[0].src === 'https://cdn.x/wallpaper4/heic2017a.jpg' && top[0].credit === 'ESA');

const earth = parseEarthView(JSON.stringify([
  { image: 'https://www.gstatic.com/prettyearth/assets/full/1003.jpg', country: 'Sverige', region: 'Norrbotten' },
  { image: 'https://www.gstatic.com/prettyearth/assets/full/1004.jpg', country: 'Chile' },
  { image: 'http://annan.example/1.jpg', country: 'X' }, null]));
ok('Earth View: only Google images, the location as title', earth.length === 2 && earth[0].id === 'earth:1003' && earth[0].title === 'Norrbotten, Sverige' && earth[1].title === 'Chile');

const commonsPage = (pages, cont) => JSON.stringify({ continue: cont, query: { pages } });
const cm = (id, w, h, mime, extra) => ({ pageid: id, title: 'File:Berg_i_dimma.jpg', imageinfo: [{ width: w, height: h, mime: mime || 'image/jpeg', thumburl: 'https://upload.wikimedia.org/thumb/' + id + '/1920px.jpg',
  extmetadata: Object.assign({ Artist: { value: '<a href="//x">Anna Fotograf</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } }, extra || {}) }] });
const commons = parseCommons(commonsPage({
  1: cm(1, 6000, 3375), 2: cm(2, 2000, 1125), 7: Object.assign(cm(7, 6000, 3375), { title: 'File:033_Stork_i_Serengeti.jpg' }), 3: cm(3, 4000, 4000), 4: cm(4, 6000, 3375, 'image/png'), 5: { pageid: 5, title: 'File:Utan_info.jpg' },
  6: cm(6, 5000, 2500, null, { ObjectName: { value: 'Sarek i gryningen' } })
}, { gcmcontinue: 'file|ABC', iicontinue: 'x', continue: 'gcmcontinue||' }));
ok('Commons: only wide, large JPEG images', commons.items.length === 3 && commons.items[0].id === 'nature:1' && commons.items[1].id === 'nature:6' && commons.items[2].id === 'nature:7', JSON.stringify(commons.items.map((i) => i.id)));
ok('Commons: name (without the serial number of the photographer), photographer and licence', commons.items[0].title === 'Berg i dimma' && commons.items[1].title === 'Sarek i gryningen' && commons.items[2].title === 'Stork i Serengeti' && commons.items[0].credit === 'Anna Fotograf · CC BY-SA 4.0 · Wikimedia Commons', commons.items[2].title);
ok('Commons: the whole continuation is carried over', commons.next && commons.next.gcmcontinue === 'file|ABC' && commons.next.iicontinue === 'x' && parseCommons(commonsPage({})).next === null);

const bing = parseBing(JSON.stringify({ images: [
  { startdate: '20261120', urlbase: '/th?id=OHR.Val_ROW1', copyright: 'Knölval, Kvaløya, Norge (© Espen B/Minden)', wp: true },
  { startdate: '20261119', urlbase: '/th?id=OHR.Annan_ROW2', copyright: 'Utan upphovsrad', wp: true },
  { startdate: '20261118', urlbase: '/th?id=OHR.Last_ROW3', copyright: 'Får inte användas (© X)', wp: false }] }));
ok('Bing: only images allowed as wallpaper, at 1920×1080', bing.length === 2 && bing[0].id === 'bing:20261120' && bing[0].src === 'https://www.bing.com/th?id=OHR.Val_ROW1_1920x1080.jpg', bing[0] && bing[0].src);
ok('Bing: title and credit are split', bing[0].title === 'Knölval, Kvaløya, Norge' && bing[0].credit === '© Espen B/Minden · Bing' && bing[1].title === 'Utan upphovsrad' && bing[1].credit === 'Bing');

const cc = parseChromecast(JSON.stringify([{ url: 'https://lh6.googleusercontent.com/-a/s1920-w1920-h1080-c/a.jpg', author: 'Ziv H' }, { url: 'https://annan.example/b.jpg', author: 'X' }, { url: 'https://lh3.googleusercontent.com/-c/c.jpg' }]));
ok('Chromecast: only Google image servers, the photographer is credited', cc.length === 2 && cc[0].credit === 'Photo: Ziv H' && cc[1].credit === '' && /^photos:\d+$/.test(cc[0].id));
setHubLanguage(() => 'sv');
ok('Chromecast: "Foto:" when the hub is Swedish', parseChromecast(JSON.stringify([{ url: 'https://lh6.googleusercontent.com/-a/a.jpg', author: 'Ziv H' }]))[0].credit === 'Foto: Ziv H');
setHubLanguage(() => 'en');

const AERIAL = JSON.stringify({ assets: [
  { id: 'A1', accessibilityLabel: 'Iceland', localizedNameKey: 'A1_NAME', scene: 'landscape', timeOfDay: 'day', 'url-1080-SDR': 'https://v.example/a1-1080.mov', 'url-4K-SDR': 'https://v.example/a1-4k.mov', 'url-4K-HDR': 'https://v.example/a1-hdr.mov',
    pointsOfInterest: { 120: 'A1_120', 0: 'A1_0', 60: 'A1_SAKNAS' } },
  { id: 'A2', accessibilityLabel: 'Hong Kong', 'url-1080-H264': 'https://v.example/a2.mov', pointsOfInterest: {} },
  { id: 'A3', accessibilityLabel: 'Gömd', includeInShuffle: false, 'url-4K-SDR': 'https://v.example/a3.mov' },
  { id: 'A4', accessibilityLabel: 'Utan film' }] });
const STR = { A1_NAME: 'Iceland', A1_0: 'Flying over Jökulsárlón', A1_120: 'Towards the glacier' };
const SV = { A1_NAME: 'Island', A1_0: 'Över Jökulsárlón' };
const air = parseAerial(AERIAL, STR, SV, 'apple');
ok('Aerials: only videos that can be shown', air.length === 2 && air[0].id === 'A1' && air[1].id === 'A2' && air[0].source === 'apple', JSON.stringify(air.map((a) => a.id)));
ok('Aerials: three qualities, 1080p H.264 as fallback', air[0].urls.hd.endsWith('a1-1080.mov') && air[0].urls.uhd.endsWith('a1-4k.mov') && air[0].urls.hdr.endsWith('a1-hdr.mov') && air[1].urls.hd.endsWith('a2.mov') && air[1].urls.uhd === '');
ok('Aerials: Swedish names and captions, English where Swedish is missing, in time order', air[0].name === 'Island' && air[0].place === 'Iceland' && JSON.stringify(air[0].poi) === JSON.stringify([[0, 'Över Jökulsárlón'], [120, 'Towards the glacier']]), JSON.stringify(air[0].poi));
ok('Aerials: a list without an "assets" wrapper (Amazon)', parseAerial(JSON.stringify([{ id: 'F1', title: 'Fjord', 'url-1080-SDR': 'https://v.example/f1.mp4' }]), null, null, 'amazon')[0].name === 'Fjord');

// --- The service: fetching, disk cache, selection -------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'g3wp-'));
try {
  const calls = [];
  let offline = false;
  let bingDay = 20;
  let limited = 1; // Wikimedia answers 429 once
  const pauses = [];
  const pause = async (ms) => { pauses.push(ms); };
  const heads = [];
  const alive = async (url) => { heads.push(url); return /dod/.test(url) ? false : /okand/.test(url) ? null : true; };
  const get = async (url) => {
    calls.push(url);
    if (offline) throw new Error('ingen kontakt');
    if (/commons\.wikimedia\.org/.test(url) && /landscapes/.test(url) && limited-- > 0) throw Object.assign(new Error('HTTP 429'), { status: 429 });
    if (/esawebb\.org/.test(url)) return '<img src="https://cdn.esawebb.org/archives/images/wallpaper2/weic1.jpg" alt="Webb 1"><img src="https://cdn.esawebb.org/archives/images/wallpaper2/weic2.jpg" alt="Webb 2">';
    if (/esahubble\.org/.test(url)) return '<img src="https://cdn.esahubble.org/archives/images/wallpaper2/heic1.jpg" alt="Hubble 1">';
    if (/eso\.org/.test(url)) throw new Error('HTTP 503');
    if (/earthview\.json/.test(url)) return JSON.stringify([1, 2, 3, 4, 5, 6].map((n) => ({ image: `https://www.gstatic.com/prettyearth/assets/full/${1000 + n}.jpg`, country: 'Land ' + n })));
    if (/commons\.wikimedia\.org/.test(url)) {
      const second = /gcmcontinue=/.test(url);
      const cat = /widescreen/.test(url) ? 900 : /landscapes/.test(url) ? 100 : /mountains/.test(url) ? 200 : 300;
      if (cat === 900) return commonsPage({ a: cm(901, 6000, 3375), b: cm(101, 6000, 3375) });
      if (cat === 100 && !second) return commonsPage({ a: cm(cat + 1, 6000, 3375), b: cm(cat + 2, 6000, 3375) }, { gcmcontinue: 'nästa', continue: 'gcmcontinue||' });
      if (cat === 100) return commonsPage({ c: cm(cat + 3, 6000, 3375) });
      if (cat === 200) return commonsPage({ a: cm(101, 6000, 3375), d: cm(cat + 1, 6000, 3375) }); // 101 is already there
      return commonsPage({});
    }
    if (/HPImageArchive/.test(url)) {
      if (/idx=7/.test(url)) return JSON.stringify({ images: [] });
      return JSON.stringify({ images: [{ startdate: '202611' + bingDay, urlbase: '/th?id=OHR.Dag' + bingDay, copyright: 'Dag ' + bingDay + ' (© X)', wp: true }] });
    }
    if (/chromecast-backgrounds/.test(url)) return JSON.stringify(['a', 'dod1', 'b', 'okand', 'dod2', 'c'].map((n) => ({ url: `https://lh3.googleusercontent.com/-x/${n}.jpg`, author: 'A' })));
    if (/api\.github\.com\/repos\/theothernt\/AerialViews\/contents/.test(url)) return JSON.stringify([{ name: 'tvos15.json' }, { name: 'tvos27.json' }, { name: 'tvos27_strings.json' }, { name: 'comm1.json' }]);
    if (/\/raw\/tvos27\.json$/.test(url)) return AERIAL;
    if (/\/raw\/tvos27_strings\.json$/.test(url)) return JSON.stringify(STR);
    if (/\/raw-sv\/tvos27_strings\.json$/.test(url)) return JSON.stringify(SV);
    if (/\/raw\/comm1\.json$/.test(url)) return JSON.stringify({ assets: [{ id: 'C1', accessibilityLabel: 'Alperna', 'url-4K-SDR': 'https://v.example/c1.mp4' }] });
    if (/\/raw\/fireos8\.json$/.test(url)) return JSON.stringify([{ id: 'F1', title: 'Fjord', 'url-1080-SDR': 'https://v.example/f1.mp4' }]);
    throw new Error('HTTP 404');
  };

  const wp = new Wallpapers(dir, { get, alive, pause });
  const list = await wp.list();
  const by = (id) => list.find((s) => s.id === id) || {};
  ok('Collections: all six, with counts after the first fetch', list.length === 6 && WALLPAPER_SETS.length === 6 && by('space').count === 3 && by('earth').count === 6 && by('bing').count === 1,
    list.map((s) => s.id + '=' + s.count).join(' '));
  ok('Collections: a source that does not respond does not stop the others (ESO down)', by('space').count === 3 && !by('space').error);
  ok('Commons: follows the continuation and removes duplicates across categories', by('nature').count === 4, 'nature=' + by('nature').count);
  ok('Commons: one request at a time with a pause, and a retry after 429', pauses.filter((p) => p === 700).length >= 14 && pauses.filter((p) => p === 8000).length === 1 && calls.filter((u) => /landscapes/.test(u)).length === 3, pauses.join(','));
  const feat = await wp.items(['featured'], 10);
  ok('Featured pictures: a collection of its own with its own ids (the same image may be in both)', by('featured').count === 2 && feat.every((i) => /^featured:\d+$/.test(i.id) && i.set === 'featured') && (await wp.items(['nature'], 10)).every((i) => /^nature:/.test(i.id)), feat.map((i) => i.id).join());
  const ph = (await wp.items(['photos'], 50)).map((i) => i.src.split('/').pop()).sort();
  ok('Photos: dead links are removed, uncertain ones are kept', by('photos').count === 4 && ph.join() === 'a.jpg,b.jpg,c.jpg,okand.jpg' && heads.length === 6, ph.join());
  ok('Collections: title and description in English by default', by('earth').title === 'Earth from above' && /Wikimedia/.test(by('nature').detail) && by('nature').detail.length < 60 && by('featured').detail.length < 60, by('earth').title);
  const svList = await wp.list('sv');
  const svBy = (id) => svList.find((s) => s.id === id) || {};
  ok('Collections: title and description in Swedish (lang=sv)', svBy('earth').title === 'Jorden från ovan' && /Wikimedia/.test(svBy('nature').detail) && svBy('nature').detail.length < 60 && svBy('featured').detail.length < 60, svBy('earth').title);
  ok('Image of the day: the market follows the hub language (en-US)', calls.some((u) => /HPImageArchive.*mkt=en-US/.test(u)) && !calls.some((u) => /mkt=sv-SE/.test(u)));

  const before = calls.length;
  const again = await wp.list();
  ok('Lists are not fetched again while they are fresh', calls.length === before && again.every((s) => !s.loading));
  const disk = JSON.parse(readFileSync(join(dir, 'cache', 'wallpapers', 'earth.json'), 'utf8'));
  ok('Lists are saved to disk', disk.items.length === 6 && disk.at > 0);

  const items = await wp.items(['space', 'earth', 'finns-inte'], 6);
  const count = (set) => items.filter((i) => i.set === set).length;
  ok('Selection: evenly spread across the chosen collections', items.length === 6 && count('space') === 3 && count('earth') === 3, items.map((i) => i.set).join(','));
  ok('Selection: every entry has an id, an image and a collection', items.every((i) => i.id && /^https:\/\//.test(i.src) && i.set));
  const many = await wp.items(['earth'], 100);
  ok('Selection: never more than the collection has, no duplicates', many.length === 6 && new Set(many.map((i) => i.id)).size === 6);
  ok('Selection: nothing chosen gives an empty list', (await wp.items([], 30)).length === 0);

  const a = await wp.aerial();
  ok('Aerials: the newest Apple list is chosen, community and Amazon videos are added', a.videos.length === 4 && a.videos.filter((v) => v.source === 'apple').length === 2 && a.videos.some((v) => v.source === 'community') && a.videos.some((v) => v.source === 'amazon'),
    a.videos.map((v) => v.source + ':' + v.id).join(' '));
  ok('Aerials: a missing list (comm2) does not stop the rest', calls.some((u) => /comm2\.json$/.test(u)) && a.videos.length === 4);
  ok('Aerials: an English hub fetches no Swedish captions', !calls.some((u) => /raw-sv\//.test(u)) && a.videos.find((v) => v.id === 'A1').name === 'Iceland');

  // A fresh start: the lists are read from disk, without new fetches.
  const calls2 = [];
  const wp2 = new Wallpapers(dir, { get: async (u) => { calls2.push(u); throw new Error('should not be fetched'); }, alive, pause });
  const l2 = await wp2.list();
  ok('After a restart: the lists come from disk without new fetches', calls2.length === 0 && l2.find((s) => s.id === 'earth').count === 6 && (await wp2.aerial()).videos.length === 4);

  // A list saved by an older version (different content) is not used.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'cache', 'wallpapers', 'nature.json'), JSON.stringify({ at: Date.now(), items: [{ id: 'nature:1', title: 'Operaaffisch', credit: '', src: 'https://x/1.jpg' }] }));
  const wp3 = new Wallpapers(dir, { get: async () => { throw new Error('ingen kontakt'); }, alive, pause });
  ok('A list saved by an older version counts as not fetched', (await wp3.read('nature')).items.length === 0 && (await wp3.read('earth')).items.length === 6);

  // Bing's collection grows: old days are kept when new ones arrive.
  wp.mem.get('bing').at = 0;
  bingDay = 21;
  await wp.list();
  await wp.loading.get('bing');
  const b = (await wp.items(['bing'], 10)).map((i) => i.id).sort();
  ok('Image of the day: new days are added to the old ones', b.join(',') === 'bing:20261120,bing:20261121', b.join(','));

  // Source down when the list has gone stale: the old list applies, and a new attempt is delayed.
  offline = true;
  wp.mem.get('earth').at = 0;
  const l3 = await wp.list();
  await wp.loading.get('earth');
  const e3 = (await wp.list()).find((s) => s.id === 'earth');
  ok('Source down: the old list is kept', l3.find((s) => s.id === 'earth').count === 6 && e3.count === 6 && /ingen kontakt/.test(e3.error), e3.error);
  const n = calls.length;
  await wp.list();
  await wp.items(['earth'], 5);
  ok('Source down: no new attempt right afterwards', calls.length === n);

  // Demo mode (development and tests): nothing is fetched.
  const callsD = [];
  const demo = new Wallpapers(dir, { get: async (u) => { callsD.push(u); return ''; }, alive, pause, demo: 'http://localhost:5173/' });
  const dl = await demo.list();
  const di = await demo.items(['space', 'earth'], 4);
  const da = await demo.aerial();
  ok('Demo mode: collections, images and videos without a single fetch', callsD.length === 0 && dl.length === 6 && di.length === 4 && di.every((i) => i.src.startsWith('http://localhost:5173/__mock/backdrop/')) && da.videos.length === 3 && da.videos[1].urls.hd === 'http://localhost:5173/__mock/vod/2.mp4');
  ok('Aerials: the response names the servers that must go via the hub', a.proxyHosts.join() === 'sylvan.apple.com' && AERIAL_PROXY_HOSTS.join() === 'sylvan.apple.com');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// --- The video proxy: Apple's films via the hub ---------------------------------------------------
{
  // A mock film server (plain http) behind a swapped-out "https.request", which notes what the proxy asked for.
  const FILM = Buffer.alloc(300000, 7);
  const seen = [];
  let aborted = 0;
  let slow = false;
  const origin = http.createServer((req, res) => {
    if (req.url === '/omdirigera/x.mov') { res.writeHead(302, { Location: 'https://annan.example/x.mov' }).end(); return; }
    if (req.url === '/saknas/x.mov') { res.writeHead(404, { 'Content-Type': 'text/html' }).end('<h1>404</h1>'); return; }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const from = m ? Number(m[1]) : 0;
    const to = m && m[2] ? Number(m[2]) : FILM.length - 1;
    res.writeHead(m ? 206 : 200, Object.assign({ 'Content-Type': 'video/quicktime', 'Content-Length': to - from + 1, 'Last-Modified': 'Mon, 02 Nov 2026 10:00:00 GMT' }, m ? { 'Content-Range': `bytes ${from}-${to}/${FILM.length}` } : {}));
    if (req.method === 'HEAD') { res.end(); return; }
    req.on('close', () => { if (!res.writableEnded) aborted++; });
    if (slow) { res.write(FILM.subarray(from, from + 1000)); return; } // the rest never comes: the TV disconnects
    res.end(FILM.subarray(from, to + 1));
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const proxy = new AerialProxy((opts, cb) => {
    seen.push(opts);
    return http.request({ host: '127.0.0.1', port: origin.address().port, path: opts.path, method: opts.method, headers: opts.headers, agent: false }, cb);
  });
  const { HttpError } = await import('../lib/http.mjs');
  const front = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x').searchParams.get('u') || '';
    Promise.resolve().then(() => proxy.handle(req, res, u)).catch((e) => { if (!res.headersSent) res.writeHead(e instanceof HttpError ? e.status : 500).end(e.message); });
  });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const via = (u, init) => fetch(`http://127.0.0.1:${front.address().port}/?u=${encodeURIComponent(u)}`, init);
  try {
    const r1 = await via('https://sylvan.apple.com/itunes-assets/Aerials/x/film_4K_SDR.mov', { headers: { Range: 'bytes=100-299' } });
    const b1 = Buffer.from(await r1.arrayBuffer());
    ok('Video proxy: the same Range passed on, the response untouched', r1.status === 206 && b1.length === 200 && r1.headers.get('content-range') === `bytes 100-299/${FILM.length}` && seen[0].headers.Range === 'bytes=100-299' && seen[0].path === '/itunes-assets/Aerials/x/film_4K_SDR.mov');
    ok('Video proxy: the certificate is checked against the Apple root (and only that)', seen[0].servername === 'sylvan.apple.com' && seen[0].host === 'sylvan.apple.com' && seen[0].port === 443 && Array.isArray(seen[0].ca) && seen[0].ca.length === 1 && /BEGIN CERTIFICATE/.test(seen[0].ca[0]) && seen[0].rejectUnauthorized !== false);
    ok('Video proxy: .mov is served as video/mp4 and is seekable', r1.headers.get('content-type') === 'video/mp4' && r1.headers.get('accept-ranges') === 'bytes' && r1.headers.get('last-modified') === 'Mon, 02 Nov 2026 10:00:00 GMT');
    const r2 = await via('https://sylvan.apple.com/a/hel.mov');
    ok('Video proxy: the whole file without Range', r2.status === 200 && Buffer.from(await r2.arrayBuffer()).equals(FILM));
    const r3 = await via('https://sylvan.apple.com/a/hel.mov', { method: 'HEAD' });
    ok('Video proxy: HEAD gives the length without fetching the video', r3.status === 200 && r3.headers.get('content-length') === String(FILM.length) && seen[seen.length - 1].method === 'HEAD');
    const n = seen.length;
    const bad = [];
    for (const u of ['https://annan.example/film.mov', 'http://sylvan.apple.com/a/film.mov', 'https://sylvan.apple.com:8443/a/film.mov', 'https://sylvan.apple.com.annan.example/a/film.mov', 'https://x@sylvan.apple.com/a/film.mov',
      'https://sylvan.apple.com/a/resources.tar', 'file:///etc/passwd', 'http://127.0.0.1:8787/api/admin/status', '']) bad.push((await via(u)).status);
    ok('Video proxy: only the Apple video server, only https, only video files', bad.every((s) => s === 403 || s === 400) && seen.length === n, bad.join(','));
    ok('Video proxy: redirects are not followed, server errors are passed on', (await via('https://sylvan.apple.com/omdirigera/x.mov')).status === 502 && (await via('https://sylvan.apple.com/saknas/x.mov')).status === 404);
    // The TV disconnects mid-film (the screensaver ends): the fetch from the film server is aborted too.
    slow = true;
    const ac = new AbortController();
    const r4 = await via('https://sylvan.apple.com/a/lang.mov', { signal: ac.signal });
    const reader = r4.body.getReader();
    await reader.read();
    const during = proxy.status().active;
    ac.abort();
    const end = Date.now() + 3000;
    while ((aborted < 1 || proxy.status().active > 0) && Date.now() < end) await new Promise((r) => setTimeout(r, 30));
    ok('Video proxy: when the TV disconnects, the fetch is aborted at once', during === 1 && aborted === 1 && proxy.status().active === 0, `during: ${during}, aborted: ${aborted}, left: ${proxy.status().active}`);
  } finally {
    front.close();
    origin.close();
    if (front.closeAllConnections) { front.closeAllConnections(); origin.closeAllConnections(); }
  }
}

console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`);
process.exit(failed ? 1 : 0);
