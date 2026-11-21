// Wallpapers and aerial films for the TV: the hub fetches the sources' lists, saves them on disk and
// hands out a random selection. The TV fetches the images themselves via the image proxy (/api/img?w=1920), so that
// it only loads a scaled-down image from the home network – no heavy work on the TV.
//
//   GET /api/wallpapers                         → { sets:[{ id, title, detail, count, updatedAt, error }] }
//   GET /api/wallpapers/items?sets=a,b&limit=30 → { items:[{ id, set, title, credit, src }] }
//   GET /api/wallpapers/aerial                  → { videos:[{ id, source, name, place, scene, time, urls:{ hd, uhd, hdr }, poi:[[sec, text]] }], updatedAt,
//                                                   proxyHosts:[hosts whose films the TV should fetch via /api/wallpapers/video – see aerialproxy.mjs] }
//
// Sources (all checked 2026-11-21):
//   space   ESA/Webb, ESA/Hubble and ESO: the "Top 100" pages (CC BY 4.0)
//   earth   Google Earth View: satellite images, 1,800×1,200 (the list from limhenry/earthview on GitHub)
//   nature  Wikimedia Commons: featured pictures of landscapes, mountains, lakes, coasts, forest, clouds … (free licences, credited)
//   featured  Wikimedia Commons: the featured widescreen pictures – mixed (animals, buildings, art, nature)
//   bing    Bing's daily image (only those Bing has marked as allowed as a wallpaper); collected over time
//   photos  The photographs from Chromecast's ambient mode (the list from dconnolly/chromecast-backgrounds)
//   aerial  Aerial films: Apple TV's screensaver (streamed from Apple's servers), free films from Jetson
//           Creative and Robin Fourcade, and Amazon Fire TV's – the lists from the Aerial Views project
//           (theothernt/AerialViews), with Swedish names and captions where they exist.
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AERIAL_PROXY_HOSTS } from './aerialproxy.mjs';
import { hubLang, LocalError, msg, msgOf, regionOf, text, tr } from './i18n.mjs';
import { fetchWithTimeout, log, warn, writeAtomic } from './util.mjs';

const DAY = 24 * 3600e3;
const UA = 'G3Hub (home media hub; wallpaper list refresh)';

const strip = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/&#39;|&apos;|&rsquo;/g, '’').replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// --- The sources' parsers (pure functions: text in, entries out – tested in hub/test/wallpapers.mjs) ---

// ESA/ESO "Top 100": <img … src|data-lazy=".../wallpaper2/heic2017a.jpg" … alt="Title">
export function parseTop100(html, cdn, credit) {
  const out = [];
  const seen = new Set();
  const re = /<img[^>]+(?:src|data-lazy)="[^"]*\/wallpaper\d\/([a-z0-9][a-z0-9_-]*)\.jpg"[^>]*alt="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id: 'space:' + id, title: strip(m[2]), credit, src: cdn + id + '.jpg' });
  }
  return out;
}

export function parseEarthView(json) {
  return JSON.parse(json).filter((e) => e && /^https:\/\/www\.gstatic\.com\/prettyearth\//.test(e.image || '')).map((e) => ({
    id: 'earth:' + (/(\d+)\.jpg$/.exec(e.image) || [])[1],
    title: [e.region, e.country].filter(Boolean).join(', '),
    credit: 'Google Earth',
    src: e.image
  }));
}

// Wikimedia Commons: one page from a category. Only wide, large JPEG images. set = the collection's id.
export function parseCommons(json, set = 'nature') {
  const d = JSON.parse(json);
  const out = [];
  for (const p of Object.values((d.query && d.query.pages) || {})) {
    const ii = p.imageinfo && p.imageinfo[0];
    if (!ii || ii.mime !== 'image/jpeg' || !ii.thumburl) continue;
    const ratio = ii.width / Math.max(1, ii.height);
    if (ii.width < 2400 || ratio < 1.45 || ratio > 2.4) continue;
    const em = ii.extmetadata || {};
    const val = (k) => strip(em[k] && em[k].value);
    // File names such as "033 Saddle-billed stork …": the leading serial number is the photographer's own, not part of the name.
    const name = (val('ObjectName') || String(p.title || '').replace(/^File:/, '').replace(/\.[a-z]+$/i, '').replace(/_/g, ' ')).replace(/^\d{2,4}\s+(?=\D)/, '');
    const artist = val('Artist').slice(0, 60);
    out.push({
      id: set + ':' + p.pageid,
      title: name.slice(0, 90),
      credit: [artist, val('LicenseShortName'), 'Wikimedia Commons'].filter(Boolean).join(' · '),
      src: ii.thumburl
    });
  }
  // The continuation may apply to both the category and the image info – send back everything the API gave.
  return { items: out, next: d.continue || null };
}

export function parseBing(json) {
  return ((JSON.parse(json) || {}).images || []).filter((i) => i && i.urlbase && i.wp !== false).map((i) => {
    const c = String(i.copyright || '');
    const m = /^(.*?)\s*\((©[^)]*)\)\s*$/.exec(c);
    return {
      id: 'bing:' + i.startdate,
      title: strip(m ? m[1] : c),
      credit: (m ? strip(m[2]) + ' · ' : '') + 'Bing',
      // 1,920×1,080 is enough: the TV's interface is drawn at that resolution, and the image does not need rescaling.
      src: 'https://www.bing.com' + i.urlbase + '_1920x1080.jpg'
    };
  });
}

export function parseChromecast(json) {
  return JSON.parse(json).filter((e) => e && /^https:\/\/[a-z0-9]+\.googleusercontent\.com\//.test(e.url || '')).map((e, i) => ({
    id: 'photos:' + i,
    title: '',
    credit: e.author ? tr('wallpapers.photoBy', { name: strip(e.author) }) : '',
    src: e.url
  }));
}

// Aerial films in Aerial Views' format. strings/sv: key → text.
export function parseAerial(json, strings, sv, source) {
  const d = JSON.parse(json);
  const assets = Array.isArray(d) ? d : d.assets || [];
  const text = (k) => (k && ((sv && sv[k]) || (strings && strings[k]))) || '';
  const out = [];
  for (const a of assets) {
    if (!a || !a.id || a.includeInShuffle === false) continue;
    const urls = {
      hd: a['url-1080-SDR'] || a['url-1080-H264'] || '',
      uhd: a['url-4K-SDR'] || '',
      hdr: a['url-4K-HDR'] || a['url-1080-HDR'] || ''
    };
    if (!urls.hd && !urls.uhd && !urls.hdr) continue;
    const poi = Object.entries(a.pointsOfInterest || {}).map(([sec, key]) => [Number(sec) || 0, strip(text(key))])
      .filter((p) => p[1]).sort((x, y) => x[0] - y[0]);
    const name = strip(text(a.localizedNameKey)) || strip(a.title) || strip(a.accessibilityLabel);
    const place = strip(a.accessibilityLabel);
    out.push({ id: String(a.id), source, name, place: place && place !== name ? place : '', scene: a.scene || '', time: a.timeOfDay || '', urls, poi });
  }
  return out;
}

// --- Sources ------------------------------------------------------------------------------------------

// 50 files per query: you cannot get image info for more than that in one response.
const COMMONS = (category, cont) => 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=categorymembers' +
  '&gcmtitle=' + encodeURIComponent('Category:' + category) + '&gcmtype=file&gcmlimit=50&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata' +
  '&iiurlwidth=1920&iiextmetadatafilter=Artist%7CLicenseShortName%7CObjectName' +
  Object.entries(cont || {}).map(([k, v]) => '&' + encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('');

const AV_RAW = 'https://raw.githubusercontent.com/theothernt/AerialViews/master/app/src/main/res/';

// Every image in a few Commons categories (an image that is in several counts once).
// The collections are fetched one at a time, even when several are due for a refetch at the same time.
let commonsTurn = Promise.resolve();
function commons(set, categories) {
  const load = async ({ get, pause }) => {
    const seen = new Set();
    const out = [];
    // One request at a time with a pause in between: Wikimedia answers 429 if you ask too often.
    const page = async (url) => {
      try { return await get(url); } catch (e) {
        if (e.status !== 429) throw e;
        await pause(8000);
        return get(url);
      }
    };
    for (const cat of categories) {
      let cont = null;
      for (let n = 0; n < 20; n++) {
        let r;
        try { r = parseCommons(await page(COMMONS(cat, cont)), set); } catch (e) { warn('wallpapers: Commons ' + cat + ': ' + e.message); break; }
        for (const it of r.items) if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
        cont = r.next;
        await pause(700);
        if (!cont) break;
      }
    }
    return out;
  };
  return (ctx) => {
    const run = commonsTurn.then(() => load(ctx));
    commonsTurn = run.catch(() => {});
    return run;
  };
}

const SETS = {
  space: {
    title: msg('wallpapers.sets.space.title'),
    detail: msg('wallpapers.sets.space.detail'),
    ttl: 7 * DAY,
    async load({ get }) {
      const pages = [
        ['https://esawebb.org/images/archive/top100/', 'https://cdn.esawebb.org/archives/images/wallpaper4/', 'ESA/Webb, NASA & CSA · CC BY 4.0'],
        ['https://esahubble.org/images/archive/top100/', 'https://cdn.esahubble.org/archives/images/wallpaper4/', 'ESA/Hubble & NASA · CC BY 4.0'],
        ['https://www.eso.org/public/images/archive/top100/', 'https://cdn.eso.org/images/wallpaper4/', 'ESO · CC BY 4.0']
      ];
      let out = [];
      for (const [url, cdn, credit] of pages) {
        try { out = out.concat(parseTop100(await get(url), cdn, credit)); } catch (e) { warn('wallpapers: ' + url + ': ' + e.message); }
      }
      return out;
    }
  },
  earth: {
    title: msg('wallpapers.sets.earth.title'),
    detail: msg('wallpapers.sets.earth.detail'),
    ttl: 30 * DAY,
    load: async ({ get }) => parseEarthView(await get('https://raw.githubusercontent.com/limhenry/earthview/master/earthview.json'))
  },
  nature: {
    title: msg('wallpapers.sets.nature.title'),
    detail: msg('wallpapers.sets.nature.detail'),
    ttl: 14 * DAY,
    load: commons('nature', ['landscapes', 'mountains', 'lakes', 'sunsets', 'sunrises', 'clouds', 'beaches', 'waterfalls', 'forests', 'coasts', 'snow', 'volcanoes', 'the Milky Way']
      .map((c) => 'Featured pictures of ' + c))
  },
  featured: {
    title: msg('wallpapers.sets.featured.title'),
    detail: msg('wallpapers.sets.featured.detail'),
    ttl: 14 * DAY,
    load: commons('featured', ['Commons featured widescreen desktop backgrounds'])
  },
  bing: {
    title: msg('wallpapers.sets.bing.title'),
    detail: msg('wallpapers.sets.bing.detail'),
    ttl: 12 * 3600e3,
    keep: 150, // new ones are added to the old
    async load({ get }) {
      // The market (titles' language) follows the hub: sv-SE / en-US.
      const mkt = regionOf();
      const a = parseBing(await get(`https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=${mkt}`));
      let b = [];
      try { b = parseBing(await get(`https://www.bing.com/HPImageArchive.aspx?format=js&idx=7&n=8&mkt=${mkt}`)); } catch { /* just the latest, then */ }
      return a.concat(b);
    }
  },
  photos: {
    title: msg('wallpapers.sets.photos.title'),
    detail: msg('wallpapers.sets.photos.detail'),
    ttl: 30 * DAY,
    // The list is old and about half of the links are dead (measured 2026-11-21): keep only those that respond.
    async load({ get, alive }) {
      const all = parseChromecast(await get('https://raw.githubusercontent.com/dconnolly/chromecast-backgrounds/master/backgrounds.json'));
      const keep = new Array(all.length).fill(true);
      let at = 0;
      const worker = async () => {
        while (at < all.length) {
          const i = at++;
          keep[i] = (await alive(all[i].src)) !== false; // unknown (network error) = keep
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      return all.filter((x, i) => keep[i]);
    }
  }
};

const AERIAL_TTL = 7 * DAY;

// Raised when a collection's content changes character: a saved list with another version counts as not fetched.
const LIST_VERSION = { nature: 2 };
const versionOf = (id) => LIST_VERSION[id] || 1;

async function loadAerial({ get }) {
  // Apple's list changes name with the tvOS version (tvos26.json): take the highest available.
  let tv = 'tvos26';
  try {
    const names = JSON.parse(await get('https://api.github.com/repos/theothernt/AerialViews/contents/app/src/main/res/raw')).map((f) => f.name)
      .filter((n) => /^tvos\d+\.json$/.test(n)).sort((x, y) => parseInt(y.slice(4), 10) - parseInt(x.slice(4), 10));
    if (names[0]) tv = names[0].replace('.json', '');
  } catch { /* the known name will do */ }
  let out = [];
  for (const [name, source] of [[tv, 'apple'], ['comm1', 'community'], ['comm2', 'community'], ['fireos8', 'amazon']]) {
    try {
      const json = await get(AV_RAW + 'raw/' + name + '.json');
      let strings = {};
      let sv = {};
      try { strings = JSON.parse(await get(AV_RAW + 'raw/' + name + '_strings.json')); } catch { /* without captions */ }
      // Swedish names and captions only for a Swedish hub.
      if (hubLang() === 'sv') try { sv = JSON.parse(await get(AV_RAW + 'raw-sv/' + name + '_strings.json')); } catch { /* English only */ }
      out = out.concat(parseAerial(json, strings, sv, source));
    } catch (e) {
      warn('aerial videos: ' + name + ': ' + e.message);
    }
  }
  return out;
}

// --- The service --------------------------------------------------------------------------------------

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Demo data for development and tests (the hub started with --demo-wallpapers <dev-server-address>):
// no calls to the internet, images and clips come from the dev server's mock data.
function demoData(base) {
  const img = (set, n, title) => ({ id: set + ':demo' + n, title, credit: 'Demo', src: `${base}/__mock/backdrop/m${300000 + n}.svg` });
  return {
    sets: {
      space: [img('space', 1, 'Demonebulosan'), img('space', 2, 'Demogalaxen'), img('space', 3, 'Demoplaneten')],
      earth: [img('earth', 11, 'Demokusten, Sverige'), img('earth', 12, 'Demoöknen, Chile'), img('earth', 13, 'Demodeltat, Kina')],
      nature: [img('nature', 21, 'Demofjället'), img('nature', 22, 'Demoskogen')]
    },
    // Film 1 is "at Apple": it plays through the hub, which in demo mode fetches it from the dev server.
    videos: [1, 2, 3].map((n) => ({
      id: 'demo' + n, source: n === 3 ? 'amazon' : n === 2 ? 'community' : 'apple', name: 'Demoflygning ' + n, place: 'Demoland', scene: 'nature', time: 'day',
      urls: n === 1 ? { hd: 'https://sylvan.apple.com/demo/1.mov', uhd: 'https://sylvan.apple.com/demo/1.mov', hdr: '' } : { hd: `${base}/__mock/vod/${n}.mp4`, uhd: `${base}/__mock/vod/${n}.mp4`, hdr: '' },
      poi: [[0, 'Start över demokusten'], [5, 'Vidare mot demobergen']]
    }))
  };
}

export class Wallpapers {
  // opts (swapped out in tests):
  //   get(url)   → Promise<text>; throws with .status on HTTP errors
  //   alive(url) → Promise<true | false | null>: does the image exist? (null = could not tell)
  //   pause(ms)  → Promise
  //   demo       the dev server's address (see demoData)
  constructor(dataDir, opts = {}) {
    this.demo = opts.demo ? demoData(String(opts.demo).replace(/\/+$/, '')) : null;
    this.dir = join(dataDir, 'cache', 'wallpapers');
    this.ctx = {
      get: opts.get || ((url) => fetchWithTimeout(url, { timeout: 30000, userAgent: UA }).then((r) => r.text())),
      alive: opts.alive || ((url) => fetchWithTimeout(url, { method: 'HEAD', timeout: 8000, userAgent: 'Mozilla/5.0 (G3Hub)' })
        .then((r) => { try { r.body && r.body.cancel(); } catch { /* nothing */ } return true; }, (e) => (e.status === 403 || e.status === 404 || e.status === 410 ? false : null))),
      pause: opts.pause || ((ms) => new Promise((r) => setTimeout(r, ms)))
    };
    this.mem = new Map();      // id -> { at, items, error }
    this.loading = new Map();  // id -> Promise
  }

  async read(id) {
    if (this.mem.has(id)) return this.mem.get(id);
    let c = { at: 0, items: [], error: '' };
    try {
      const j = JSON.parse(await readFile(join(this.dir, id + '.json'), 'utf8'));
      if (j && Array.isArray(j.items) && (j.v || 1) === versionOf(id)) c = { at: Number(j.at) || 0, items: j.items, error: '' };
    } catch { /* not fetched yet */ }
    this.mem.set(id, c);
    return c;
  }

  // Refetch a list (one fetch at a time per list). If it fails, the old one is kept.
  refresh(id, loader, keep) {
    if (this.loading.has(id)) return this.loading.get(id);
    const job = (async () => {
      const cur = await this.read(id);
      try {
        let items = await loader(this.ctx);
        if (!items.length) throw new LocalError('wallpapers.noItems');
        if (keep) {
          const seen = new Set(items.map((x) => x.id));
          items = items.concat(cur.items.filter((x) => !seen.has(x.id))).sort((x, y) => (x.id < y.id ? 1 : -1)).slice(0, keep);
        }
        const next = { at: Date.now(), items, error: '' };
        this.mem.set(id, next);
        await mkdir(this.dir, { recursive: true });
        await writeAtomic(join(this.dir, id + '.json'), JSON.stringify({ at: next.at, v: versionOf(id), items }));
        log(`wallpapers: ${id} updated (${items.length} items)`);
      } catch (e) {
        cur.error = msgOf(e); // text in the reader's language: list() / aerial()
        cur.tried = Date.now();
        warn(`wallpapers: could not fetch ${id}: ${e.message}`);
      }
    })().finally(() => this.loading.delete(id));
    this.loading.set(id, job);
    return job;
  }

  // Current list; refetched in the background when it has gone stale (at most one new attempt per hour after an error).
  async ensure(id, loader, ttl, keep, wait) {
    const c = await this.read(id);
    const stale = Date.now() - c.at > ttl && Date.now() - (c.tried || 0) > 3600e3;
    if (stale) {
      const job = this.refresh(id, loader, keep);
      if (!c.items.length && wait) await Promise.race([job, new Promise((r) => setTimeout(r, wait))]);
    }
    return this.mem.get(id) || c;
  }

  async list(lang) {
    if (this.demo) return Object.entries(SETS).map(([id, s]) => ({ id, title: text(s.title, lang), detail: text(s.detail, lang), count: (this.demo.sets[id] || []).length, updatedAt: Date.now(), error: '' }));
    // The first time there are no lists: fetch them all at once and wait a short while for them.
    const ids = Object.keys(SETS);
    const cs = await Promise.all(ids.map((id) => this.ensure(id, SETS[id].load, SETS[id].ttl, SETS[id].keep, 6000)));
    return ids.map((id, i) => ({
      id, title: text(SETS[id].title, lang), detail: text(SETS[id].detail, lang), count: cs[i].items.length, updatedAt: cs[i].at || null,
      error: text(cs[i].error, lang) || '', loading: this.loading.has(id)
    }));
  }

  // A random selection, evenly spread across the chosen collections.
  async items(ids, limit) {
    const lists = [];
    for (const id of ids) {
      const s = SETS[id];
      if (!s) continue;
      const c = this.demo ? { items: this.demo.sets[id] || [] } : await this.ensure(id, s.load, s.ttl, s.keep, 9000);
      if (c.items.length) lists.push(shuffle(c.items).slice(0, limit).map((x) => ({ ...x, set: id })));
    }
    const out = [];
    for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++) {
      for (const l of lists) if (i < l.length && out.length < limit) out.push(l[i]);
    }
    return out;
  }

  async aerial(lang) {
    if (this.demo) return { videos: this.demo.videos, updatedAt: Date.now(), error: '', proxyHosts: AERIAL_PROXY_HOSTS };
    const c = await this.ensure('aerial', loadAerial, AERIAL_TTL, 0, 15000);
    return { videos: c.items, updatedAt: c.at || null, error: text(c.error, lang) || '', proxyHosts: AERIAL_PROXY_HOSTS };
  }
}

export const WALLPAPER_SETS = Object.keys(SETS);
