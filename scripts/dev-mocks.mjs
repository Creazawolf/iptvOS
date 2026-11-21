// Mock IPTV for previewing in the browser (used by scripts/dev.mjs).
//
// Two providers with the same Xtream API:
//
//   Small   http://demo.g3custom.test/…   via /__proxy (direct mode in the launcher).
//           7 categories, ~1,250 channels, plus movies and series.
//   Large   http://localhost:<port>/__xtream/…   real paths (the hub talks to this one).
//           ~22,000 channels in ~400 categories, ~3,000 movies, ~400 series – like a real list.
//
//   handleProxy(url, res)       /__proxy calls to demo.g3custom.test
//   handleXtream(req, res, url) /__xtream/player_api.php, /__xtream/get.php, /__xtream/{live,movie,series}/…
//   handle(req, res, url)       /__mock/logo/<id>.svg, /__mock/poster/<id>.svg, /__mock/backdrop/<id>.svg,
//                               /__mock/still/<id>.svg, /__mock/stream/<id>.mp4, /__mock/vod/<id>.mp4
//
// Everything is deterministic (seeded randomness) and only generated when needed.
// The demo video is created once with ffmpeg in build/dev-media/.
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD } from './lib.mjs';

const DEMO_HOST = 'demo.g3custom.test';
const USER = 'demo';
const PASS = 'demo';

// --- Helpers -----------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
const fmt = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
};

// --- The small catalogue (unchanged since v2) ---------------------------------------

const SMALL_CATEGORIES = [
  { id: '1', name: 'Sverige' },
  { id: '2', name: 'Sport' },
  { id: '3', name: 'Nyheter' },
  { id: '4', name: 'Film & serier' },
  { id: '5', name: 'Barn' },
  { id: '6', name: 'Dokumentär' },
  { id: '7', name: 'Internationellt' }
];

// [name, category, colour]
const NAMED = [
  ['SVT1 HD', '1', '#1f6fd1'], ['SVT2 HD', '1', '#2a2a2a'], ['TV4 HD', '1', '#e4002b'], ['Kanal 5 HD', '1', '#111111'],
  ['TV3 HD', '1', '#0a0a0a'], ['Sjuan', '1', '#e30613'], ['TV6', '1', '#1a1a1a'], ['TV8', '1', '#4b2a8a'],
  ['Kanal 9', '1', '#0d0d0d'], ['TV10', '1', '#283593'], ['SVT24', '1', '#3a3a3a'], ['Kunskapskanalen', '1', '#006e5a'],
  ['V Sport Fotboll', '2', '#d7182a'], ['V Sport Hockey', '2', '#d7182a'], ['TV4 Sport', '2', '#e4002b'],
  ['Eurosport 1', '2', '#0a1f8f'], ['Eurosport 2', '2', '#0a1f8f'], ['C More Golf', '2', '#1b5e20'],
  ['SVT Sport', '2', '#1f6fd1'], ['Viaplay Sport 1', '2', '#2a1b55'],
  ['SVT Nyheter', '3', '#1f6fd1'], ['TV4 Nyheterna', '3', '#e4002b'], ['CNN International', '3', '#cc0000'],
  ['BBC World News', '3', '#b80000'], ['Sky News', '3', '#0055a5'], ['Al Jazeera', '3', '#c48a00'],
  ['TV4 Film', '4', '#7a0019'], ['C More First', '4', '#1d1d1d'], ['C More Hits', '4', '#3a0d4a'],
  ['Viaplay Film', '4', '#2a1b55'], ['HBO Classics', '4', '#111111'], ['TCM', '4', '#0b3d91'],
  ['Barnkanalen', '5', '#ff7a00'], ['Disney Junior', '5', '#2155c4'], ['Cartoon Network', '5', '#111111'],
  ['Nickelodeon', '5', '#ff6600'], ['Boomerang', '5', '#5b2d8e'],
  ['Discovery Channel', '6', '#0a5bd3'], ['National Geographic', '6', '#d4a800'], ['History', '6', '#8a1c1c'],
  ['Animal Planet', '6', '#2e7d32'], ['Viasat Nature', '6', '#3d6b2f'], ['Viasat Explore', '6', '#2a1b55']
];

const SMALL_CHANNELS = [];
NAMED.forEach(([name, cat, color], i) => {
  // SVT1 and SVT2 have catch-up (7 days) in the demo, so that "Watch on catch-up" can be tried.
  SMALL_CHANNELS.push({ id: 1001 + i, num: i + 1, name, cat, color, logo: true, show: cat, archive: i < 2 ? 1 : 0 });
});
// A large category for testing long lists.
const WORLD = ['World', 'Global', 'Prime', 'Star', 'Nova', 'Max', 'One', 'Plus', 'Live', 'Vision'];
for (let i = 0; i < 1200; i++) {
  const n = WORLD[i % WORLD.length] + ' TV ' + String(i + 1).padStart(4, '0');
  SMALL_CHANNELS.push({ id: 5000 + i, num: 100 + i, name: 'INT | ' + n, cat: '7', color: '#333', logo: i % 3 !== 0, show: '7' });
}

// All channels (both catalogues) by id – for logos, EPG and streams.
const channelById = new Map(SMALL_CHANNELS.map((c) => [String(c.id), c]));

// --- The large catalogue: ~22,000 channels in ~400 categories -----------------------

const COUNTRIES = [
  ['SE', 'sv'], ['NO', 'no'], ['DK', 'da'], ['FI', 'fi'], ['UK', 'en'], ['IE', 'en'], ['DE', 'de'], ['AT', 'de'],
  ['CH', 'de'], ['NL', 'nl'], ['BE', 'nl'], ['FR', 'fr'], ['IT', 'it'], ['ES', 'es'], ['PT', 'pt'], ['PL', 'pl'],
  ['CZ', 'cs'], ['HU', 'hu'], ['RO', 'ro'], ['BG', 'bg'], ['GR', 'el'], ['TR', 'tr'], ['AR', 'ar'], ['IR', 'fa'],
  ['AF', 'fa'], ['IN', 'hi'], ['PK', 'ur'], ['BD', 'bn'], ['RU', 'ru'], ['UA', 'uk'], ['EX-YU', 'sr'], ['AL', 'sq'],
  ['KU', 'ku'], ['US', 'en'], ['CA', 'en'], ['MX', 'es'], ['LATAM', 'es'], ['BR', 'pt'], ['AU', 'en'], ['NZ', 'en'],
  ['ZA', 'en'], ['AFRICA', 'en'], ['PH', 'en'], ['TH', 'th'], ['VN', 'vi'], ['CN', 'zh'], ['JP', 'ja'], ['KR', 'ko'],
  ['CARIBBEAN', 'en'], ['IS', 'is'], ['LT', 'lt'], ['LV', 'lv'], ['EE', 'et']
];

// [category name, genre]
const SUBCATS = [
  ['GENERAL', 'general'], ['HD', 'general'], ['FHD', 'general'], ['HEVC', 'general'], ['SPORT', 'sport'],
  ['SPORTS EVENTS', 'sport'], ['NEWS', 'news'], ['MOVIES', 'movies'], ['SERIES 24/7', 'movies'], ['KIDS', 'kids'],
  ['DOCUMENTARY', 'docs'], ['MUSIC', 'music'], ['LOCAL', 'general'], ['VIP', 'general'], ['RELIGIOUS', 'general'],
  ['RADIO', 'music'], ['ENTERTAINMENT', 'general'], ['SD/BACKUP', 'general']
];

const SPECIAL_CATS = [
  ['SPORT | PREMIER LEAGUE', 'sport'], ['SPORT | CHAMPIONS LEAGUE', 'sport'], ['SPORT | NHL', 'sport'],
  ['SPORT | NBA', 'sport'], ['SPORT | NFL', 'sport'], ['SPORT | MLB', 'sport'], ['SPORT | F1 & MOTOR', 'sport'],
  ['SPORT | UFC & BOXING', 'sport'], ['SPORT | GOLF', 'sport'], ['SPORT | TENNIS', 'sport'], ['SPORT | CRICKET', 'sport'],
  ['SPORT | ALLSVENSKAN', 'sport'], ['SPORT | SHL', 'sport'], ['SPORT | BUNDESLIGA', 'sport'], ['SPORT | LA LIGA', 'sport'],
  ['4K | UHD SPORT', 'sport'], ['4K | UHD FILM', 'movies'], ['4K | UHD NATURE', 'docs'], ['4K | UHD EVENTS', 'sport'],
  ['PPV | EVENTS', 'sport'], ['PPV | BOXING', 'sport'], ['24/7 | FILM', 'movies'], ['24/7 | SERIER', 'movies'],
  ['24/7 | KIDS', 'kids'], ['24/7 | COMEDY', 'movies'], ['NETFLIX | 24/7', 'movies'], ['DISNEY+ | 24/7', 'kids'],
  ['MAX | 24/7', 'movies'], ['VIAPLAY | EVENTS', 'sport'], ['RADIO | SVERIGE', 'music'], ['MUSIC | VEVO', 'music']
];

const NAME_WORDS = {
  general: ['TV', 'ONE', 'TWO', 'PLUS', 'MAX', 'LIVE', 'STAR', 'PRIME', 'NOVA', 'VISION', 'CHANNEL', 'FIRST', 'ZONE'],
  sport: ['SPORT', 'SPORTS', 'ARENA', 'FOOTBALL', 'GOLF', 'TENNIS', 'FIGHT', 'RACING', 'HOCKEY', 'ACTION', 'EXTRA', 'EVENT'],
  news: ['NEWS', 'NEWS 24', 'INFO', 'BUSINESS', 'WORLD', 'POLITICS', 'WEATHER', 'TODAY'],
  movies: ['CINEMA', 'MOVIES', 'FILM', 'ACTION', 'PREMIERE', 'CLASSICS', 'HITS', 'DRAMA', 'COMEDY', 'THRILLER'],
  kids: ['KIDS', 'JUNIOR', 'CARTOON', 'TOONS', 'FAMILY', 'TEEN'],
  docs: ['DISCOVERY', 'NATURE', 'HISTORY', 'SCIENCE', 'EXPLORE', 'WILD', 'PLANET', 'TRAVEL'],
  music: ['MUSIC', 'HITS', 'ROCK', 'CLUB', 'RADIO', 'POP', 'CLASSIC', 'DANCE']
};
const QUALITY = ['', ' HD', ' HD', ' FHD', ' FHD', ' HEVC', ' SD', ' 4K', ' HD+', ' (BACKUP)'];
const GENRE_SHOW = { general: '7', sport: '2', news: '3', movies: '4', kids: '5', docs: '6', music: '7' };
const GENRE_HUE = { general: 215, sport: 0, news: 200, movies: 280, kids: 30, docs: 120, music: 320 };

let large = null;

function buildLarge() {
  if (large) return large;
  const rand = rng(424242);
  const categories = [];
  const channels = [];

  // The named Swedish channels first, in their own categories with the same ids as in the small catalogue.
  const SE_NAMES = { '1': 'SE | SVERIGE HD', '2': 'SE | SPORT', '3': 'SE | NYHETER', '4': 'SE | FILM & SERIER', '5': 'SE | BARN', '6': 'SE | DOKUMENTÄR' };
  for (const id of Object.keys(SE_NAMES)) categories.push({ id, name: SE_NAMES[id], genre: 'general' });
  for (const ch of SMALL_CHANNELS) if (ch.cat !== '7') channels.push(ch);

  let catId = 100;
  const addCat = (name, genre, size) => {
    const id = String(catId++);
    categories.push({ id, name, genre, size });
  };

  for (const [cc] of COUNTRIES) {
    // 5–9 subcategories per country, Sweden gets more.
    const n = cc === 'SE' ? 12 : 5 + Math.floor(rand() * 5);
    const subs = SUBCATS.slice().sort(() => rand() - 0.5).slice(0, n);
    for (const [sub, genre] of subs) addCat(`${cc} | ${sub}`, genre, 0);
  }
  for (const [name, genre] of SPECIAL_CATS) addCat(name, genre, 0);
  categories.push({ id: '7', name: 'INT | WORLD', genre: 'general' });

  // Spread ~22,000 channels over the generated categories (unevenly, as in real life).
  const gen = categories.filter((c) => c.size === 0);
  const weights = gen.map(() => 0.25 + Math.pow(rand(), 2) * 3);
  const sum = weights.reduce((a, b) => a + b, 0);
  const TARGET = 22000 - channels.length - 1200;
  let nextId = 100000;
  let num = 2000;
  gen.forEach((cat, i) => {
    const count = Math.max(4, Math.round((weights[i] / sum) * TARGET));
    const prefix = cat.name.split(' | ')[0];
    const words = NAME_WORDS[cat.genre] || NAME_WORDS.general;
    const hue = (GENRE_HUE[cat.genre] + Math.floor(rand() * 60) - 30 + 360) % 360;
    for (let k = 0; k < count; k++) {
      const word = pick(rand, words);
      const base = rand() < 0.5 ? `${prefix} ${word}` : `${word} ${1 + Math.floor(rand() * 30)}`;
      const name = `${prefix} | ${base}${pick(rand, QUALITY)}`;
      const ch = {
        id: nextId++,
        num: num++,
        name,
        cat: cat.id,
        color: `hsl(${hue}, ${45 + Math.floor(rand() * 30)}%, ${18 + Math.floor(rand() * 18)}%)`,
        logo: rand() > 0.12,
        show: GENRE_SHOW[cat.genre] || '7',
        archive: cat.genre === 'sport' && rand() < 0.3 ? 1 : 0
      };
      channels.push(ch);
      channelById.set(String(ch.id), ch);
    }
  });
  // The old large international category remains as "INT | WORLD".
  for (const ch of SMALL_CHANNELS) if (ch.cat === '7') channels.push(ch);

  const byCat = new Map();
  for (const ch of channels) {
    if (!byCat.has(ch.cat)) byCat.set(ch.cat, []);
    byCat.get(ch.cat).push(ch);
  }
  large = { categories, channels, byCat };
  return large;
}

// --- Movies and series -------------------------------------------------------------

const VOD_CATEGORIES = [
  'SE | Svenska filmer', 'SE | Barnfilmer (svenskt tal)', 'EN | Nya filmer 2026', 'EN | Action', 'EN | Komedi',
  'EN | Drama', 'EN | Thriller', 'EN | Skräck', 'EN | Sci-Fi & Fantasy', 'EN | Animerat', 'EN | Dokumentär',
  'EN | Romantik', 'EN | Krig & historia', 'EN | Kriminal', 'EN | Familj', 'EN | Klassiker', '4K | UHD-filmer',
  'NETFLIX | Filmer', 'DISNEY+ | Filmer', 'MAX | Filmer', 'APPLE TV+ | Filmer', 'PRIME | Filmer', 'DE | Filme',
  'FR | Films', 'TR | Filmler', 'AR | Aflam', 'IN | Bollywood', 'NORDIC | Filmer', 'EN | Stand-up', 'EN | Konserter'
];

const SERIES_CATEGORIES = [
  'SE | Svenska serier', 'EN | Drama', 'EN | Komedi', 'EN | Kriminal', 'EN | Sci-Fi', 'EN | Reality',
  'EN | Dokumentärserier', 'EN | Animerat', 'NETFLIX | Serier', 'MAX | Serier', 'APPLE TV+ | Serier',
  'DISNEY+ | Serier', 'NORDIC | Noir', 'TR | Diziler', 'KIDS | Serier'
];

const EN_ADJ = ['Silent', 'Last', 'Hidden', 'Broken', 'Golden', 'Dark', 'Endless', 'Crimson', 'Frozen', 'Lost', 'Midnight',
  'Wild', 'Final', 'Electric', 'Distant', 'Burning', 'Quiet', 'Hollow', 'Northern', 'Blue', 'Iron', 'Glass', 'Secret', 'Paper'];
const EN_NOUN = ['Harbor', 'Protocol', 'Kingdom', 'Signal', 'Horizon', 'River', 'Empire', 'Garden', 'Machine', 'Witness',
  'Frontier', 'Orchard', 'Station', 'Promise', 'Light', 'Storm', 'Mirror', 'Engine', 'Island', 'Echo', 'Heist', 'Code',
  'Tide', 'Summit', 'Lantern', 'Parade', 'Circuit', 'Atlas'];
const EN_PLACE = ['Avalon', 'the North', 'Brooklyn', 'Mars', 'the Deep', 'Kyoto', 'Lisbon', 'Nowhere', 'the Valley', 'Oslo'];
const SV_TITLES = ['Det tysta huset', 'Midnattssol', 'Kalla spår', 'Sommaren vi försvann', 'Under isen', 'Fyrvaktarens dotter',
  'Skärgårdsnatt', 'Den sista färjan', 'Vargtimmen', 'Allt vi lämnade', 'Bröderna från Norrland', 'Stormvarning',
  'Hemma hos Svea', 'Ljuset i Kiruna', 'Tågresan', 'Glasberget', 'Sista dansen', 'Mörkrets hamn', 'Fjällräddningen',
  'Det röda torpet', 'Nattskift', 'Höstlöv', 'Stjärnfall', 'Snöblind', 'Kustvägen'];
const GENRES_EN = ['Action', 'Drama', 'Thriller', 'Komedi', 'Sci-Fi', 'Skräck', 'Romantik', 'Kriminal', 'Äventyr', 'Familj', 'Dokumentär', 'Animerat'];
const PEOPLE = ['Alicia Vikander', 'Mikael Persbrandt', 'Noomi Rapace', 'Stellan Skarsgård', 'Rebecca Ferguson', 'Bill Skarsgård',
  'Emma Stone', 'Oscar Isaac', 'Florence Pugh', 'Dev Patel', 'Zendaya', 'Pedro Pascal', 'Cate Blanchett', 'Idris Elba',
  'Saoirse Ronan', 'Mahershala Ali', 'Tilda Swinton', 'Riz Ahmed', 'Anya Taylor-Joy', 'Paul Mescal'];
const DIRECTORS = ['Ruben Östlund', 'Lisa Langseth', 'Tomas Alfredson', 'Denis Villeneuve', 'Greta Gerwig', 'Bong Joon-ho', 'Chloé Zhao', 'Jordan Peele'];
const PLOTS = [
  'När en gammal vän dyker upp efter tjugo år tvingas {who} att välja mellan lojalitet och sanning.',
  'En stilla småstad skakas om när {who} hittar ett brev som aldrig borde ha skickats.',
  'I en nära framtid försöker {who} stoppa en konspiration som når ända upp i regeringen.',
  'En sista resa genom ett vintrigt landskap blir början på något helt nytt för {who}.',
  'Med allt på spel ger sig {who} in i en kapplöpning mot klockan.',
  'En varm och rolig berättelse om {who}, en familj i kris och sommaren som förändrade allt.',
  'Ett rån som skulle vara enkelt går fel på alla tänkbara sätt, och {who} står mitt i stormen.',
  'Djupt under havsytan upptäcker {who} att de inte är ensamma.'
];
const WHO = ['en ung polis', 'två syskon', 'en pensionerad pilot', 'en ensamstående mamma', 'en tonåring', 'en uttröttad journalist', 'ett gäng vänner', 'en forskare'];

const PALETTES = [
  ['#0f2027', '#2c5364', '#7fd1ff'], ['#42275a', '#734b6d', '#ffb0d0'], ['#141e30', '#243b55', '#9ec5ff'],
  ['#3a1c71', '#d76d77', '#ffaf7b'], ['#000428', '#004e92', '#6dd5ff'], ['#232526', '#414345', '#e0e0e0'],
  ['#1d4350', '#a43931', '#ffcf9f'], ['#16222a', '#3a6073', '#bfe9ff'], ['#2b0a3d', '#dd2476', '#ff9a6c'],
  ['#0f0c29', '#302b63', '#a99bff'], ['#240b36', '#c31432', '#ffb199'], ['#0b2a2b', '#134e5e', '#71b280'],
  ['#1f1300', '#a05a00', '#ffd27a'], ['#001510', '#00b09b', '#c8ffef'], ['#1a002b', '#4e0f7a', '#ff6ec4'],
  ['#08121c', '#1d3a5f', '#ffd166']
];

let media = null;

function makeTitle(rand, lang, used) {
  let t;
  for (let tries = 0; tries < 6; tries++) {
    if (lang === 'sv') t = pick(rand, SV_TITLES);
    else {
      const r = rand();
      if (r < 0.35) t = `The ${pick(rand, EN_ADJ)} ${pick(rand, EN_NOUN)}`;
      else if (r < 0.6) t = `${pick(rand, EN_ADJ)} ${pick(rand, EN_NOUN)}`;
      else if (r < 0.8) t = `The ${pick(rand, EN_NOUN)} of ${pick(rand, EN_PLACE)}`;
      else t = `${pick(rand, EN_NOUN)}: ${pick(rand, EN_ADJ)} ${pick(rand, EN_NOUN)}`;
    }
    if (!used.has(t)) break;
  }
  let n = 2;
  const base = t;
  while (used.has(t)) t = `${base} ${n++}`;
  used.add(t);
  return t;
}

function buildMedia() {
  if (media) return media;
  const rand = rng(99173);
  const used = new Set();
  const now = Math.floor(Date.now() / 1000 / 86400) * 86400; // stable for a day
  const movies = [];
  const series = [];
  const episodes = new Map();

  let id = 300000;
  VOD_CATEGORIES.forEach((name, ci) => {
    const count = 60 + Math.floor(rand() * 80);
    const lang = name.startsWith('SE') || name.startsWith('NORDIC') ? 'sv' : 'en';
    for (let k = 0; k < count; k++) {
      const year = name.includes('2026') ? 2026 : name.includes('Klassiker') ? 1950 + Math.floor(rand() * 40) : 1985 + Math.floor(rand() * 41);
      const m = {
        id: id++,
        title: makeTitle(rand, lang, used),
        year,
        cat: String(ci + 1),
        rating: Math.round((4 + rand() * 5) * 10) / 10,
        added: now - Math.floor(rand() * 720) * 86400 - Math.floor(rand() * 86400),
        duration: 80 + Math.floor(rand() * 80),
        genre: [pick(rand, GENRES_EN), pick(rand, GENRES_EN)].filter((g, i, a) => a.indexOf(g) === i).join(', '),
        plot: pick(rand, PLOTS).replace('{who}', pick(rand, WHO)),
        cast: [pick(rand, PEOPLE), pick(rand, PEOPLE), pick(rand, PEOPLE)].filter((g, i, a) => a.indexOf(g) === i).join(', '),
        director: pick(rand, DIRECTORS),
        tmdb: rand() < 0.4 ? String(10000 + Math.floor(rand() * 900000)) : '',
        palette: Math.floor(rand() * PALETTES.length),
        noPoster: rand() < 0.04
      };
      movies.push(m);
    }
  });

  let sid = 7000;
  let eid = 2000000;
  SERIES_CATEGORIES.forEach((name, ci) => {
    const count = 20 + Math.floor(rand() * 18);
    const lang = name.startsWith('SE') || name.startsWith('NORDIC') ? 'sv' : 'en';
    for (let k = 0; k < count; k++) {
      const seasons = 1 + Math.floor(Math.pow(rand(), 1.5) * 6);
      const s = {
        id: sid++,
        title: makeTitle(rand, lang, used),
        year: 2000 + Math.floor(rand() * 27),
        cat: String(ci + 1),
        rating: Math.round((5 + rand() * 4.5) * 10) / 10,
        added: now - Math.floor(rand() * 500) * 86400,
        genre: [pick(rand, GENRES_EN), pick(rand, GENRES_EN)].filter((g, i, a) => a.indexOf(g) === i).join(', '),
        plot: pick(rand, PLOTS).replace('{who}', pick(rand, WHO)),
        cast: [pick(rand, PEOPLE), pick(rand, PEOPLE)].filter((g, i, a) => a.indexOf(g) === i).join(', '),
        director: pick(rand, DIRECTORS),
        tmdb: rand() < 0.5 ? String(10000 + Math.floor(rand() * 200000)) : '',
        palette: Math.floor(rand() * PALETTES.length),
        seasons: []
      };
      for (let n = 1; n <= seasons; n++) {
        const eps = 6 + Math.floor(rand() * 5);
        const list = [];
        for (let e = 1; e <= eps; e++) {
          const ep = {
            id: eid++,
            season: n,
            episode: e,
            title: `${pick(rand, EN_ADJ)} ${pick(rand, EN_NOUN)}`,
            plot: pick(rand, PLOTS).replace('{who}', pick(rand, WHO)),
            duration: 38 + Math.floor(rand() * 25),
            series: s.id,
            palette: s.palette
          };
          list.push(ep);
          episodes.set(String(ep.id), ep);
        }
        s.seasons.push(list);
      }
      series.push(s);
    }
  });

  media = {
    movies,
    series,
    episodes,
    movieById: new Map(movies.map((m) => [String(m.id), m])),
    seriesById: new Map(series.map((s) => [String(s.id), s]))
  };
  return media;
}

// --- EPG -------------------------------------------------------------------------

const SHOWS = {
  '1': ['Rapport', "Go'kväll", 'På spåret', 'Antikrundan', 'Uppdrag granskning', 'Skavlan', 'Bonde söker fru', "Let's Dance", 'Nyhetsmorgon', 'Fångarna på fortet', 'Husdrömmar', 'Mästarnas mästare', 'Allsång på Skansen', 'Sverige!'],
  '2': ['Allsvenskan: Hammarby – AIK', 'SHL: Frölunda – Färjestad', 'Premier League: Arsenal – Liverpool', 'Formel 1: Kvalificering', 'Studio Sport', 'Champions League-magasinet', 'Tennis: Stockholm Open', 'Golf: The Open', 'Skidskytte: Världscupen', 'NHL: Rangers – Bruins'],
  '3': ['Nyheterna', 'World News', 'Ekonominyheterna', 'Väder', 'Agenda', 'Morgonstudion', 'Business Today', 'Inside Story', 'Kvällsnytt', 'Lokala nyheter'],
  '4': ['Kvällens film: Midsommar', 'Mission: Impossible', 'Bron', 'Wallander', 'Beck', 'The Last of Us', 'Succession', 'Inception', 'Män som hatar kvinnor', 'Jurassic Park'],
  '5': ['Bolibompa', 'Pippi Långstrump', 'Babblarna', 'Emil i Lönneberga', 'Bluey', 'Paw Patrol', 'Musse Pigg', 'Pettson och Findus', 'Labyrint', 'Greta Gris'],
  '6': ['Planet Earth', 'Vikingarna', 'Sveriges natur', 'Hajveckan', 'Andra världskriget i färg', 'Rymdens mysterier', 'Djurens hemliga liv', 'Mega-byggen', 'Antikens världar', 'Vildmarkens överlevare'],
  '7': ['Evening News', 'Talk of the Town', 'Movie Night', 'Live Concert', 'Travel Diaries', 'Cooking Show', 'Late Night', 'Morning Show']
};
const LENGTHS = [30, 45, 60, 60, 90, 120];

// Deterministic schedule per channel and day.
function schedule(ch, from, count) {
  // One timeline per channel, starting two days back: the short EPG (from = now) and XMLTV
  // (from = a day back) must describe the same programmes whatever the time of day.
  const anchor = new Date(Date.now() - 2 * 86400e3);
  anchor.setHours(0, 0, 0, 0);
  const rand = rng(ch.id * 7919 + anchor.getDate());
  const shows = SHOWS[ch.show || ch.cat] || SHOWS['7'];
  let t = anchor.getTime();
  const out = [];
  while (out.length < count) {
    const len = LENGTHS[Math.floor(rand() * LENGTHS.length)] * 60e3;
    const title = shows[Math.floor(rand() * shows.length)];
    const end = t + len;
    if (end > from) {
      out.push({
        id: String(ch.id) + String(t / 60e3),
        epg_id: '1',
        title: b64(title),
        lang: 'sv',
        start: fmt(t),
        end: fmt(end),
        description: b64(`${title} – ${ch.name}. Ett avsnitt fullt av överraskningar, med både skratt och allvar.`),
        channel_id: slug(ch.name) + '.se',
        start_timestamp: String(Math.floor(t / 1000)),
        stop_timestamp: String(Math.floor(end / 1000))
      });
    }
    t = end;
  }
  return out;
}

const hasEpg = (ch) => !(ch.cat === '7' && ch.id % 5 === 0) && !(ch.id >= 100000 && ch.id % 7 === 0);

// --- player_api.php --------------------------------------------------------------

// base = '' (relative images, small catalogue) or 'http://host' (large catalogue).
function liveStream(ch, base) {
  return {
    num: ch.num,
    name: ch.name,
    stream_type: 'live',
    stream_id: ch.id,
    stream_icon: ch.logo ? `${base}/__mock/logo/${ch.id}.svg` : '',
    epg_channel_id: hasEpg(ch) ? slug(ch.name) + '.se' : '',
    added: '1700000000',
    is_adult: '0',
    category_id: ch.cat,
    category_ids: [Number(ch.cat)],
    custom_sid: '',
    tv_archive: ch.archive || 0,
    direct_source: '',
    tv_archive_duration: ch.archive ? 7 : 0
  };
}

const vodCatId = (m) => String(100 + Number(m.cat));
const seriesCatId = (s) => String(200 + Number(s.cat));

function vodStream(m, base) {
  return {
    num: m.id - 299999,
    name: `${m.title} (${m.year})`,
    title: m.title,
    year: String(m.year),
    stream_type: 'movie',
    stream_id: m.id,
    stream_icon: m.noPoster ? '' : `${base}/__mock/poster/m${m.id}.svg`,
    rating: String(m.rating),
    rating_5based: Math.round(m.rating / 2 * 10) / 10,
    added: String(m.added),
    is_adult: 0,
    category_id: vodCatId(m),
    category_ids: [Number(vodCatId(m))],
    container_extension: 'mp4',
    custom_sid: '',
    direct_source: '',
    tmdb: m.tmdb
  };
}

function seriesItem(s, base) {
  return {
    num: s.id - 6999,
    name: `${s.title} (${s.year})`,
    title: s.title,
    year: String(s.year),
    stream_type: 'series',
    series_id: s.id,
    cover: `${base}/__mock/poster/s${s.id}.svg`,
    plot: s.plot,
    cast: s.cast,
    director: s.director,
    genre: s.genre,
    releaseDate: `${s.year}-03-14`,
    release_date: `${s.year}-03-14`,
    last_modified: String(s.added),
    rating: String(s.rating),
    rating_5based: Math.round(s.rating / 2 * 10) / 10,
    backdrop_path: [`${base}/__mock/backdrop/s${s.id}.svg`],
    youtube_trailer: '',
    tmdb: s.tmdb,
    episode_run_time: '45',
    category_id: seriesCatId(s),
    category_ids: [Number(seriesCatId(s))]
  };
}

function userInfo(now, host) {
  return {
    user_info: {
      username: USER,
      password: PASS,
      message: 'Välkommen till demo-IPTV',
      auth: 1,
      status: 'Active',
      exp_date: String(Math.floor(now / 1000) + 365 * 86400),
      is_trial: '0',
      active_cons: '0',
      created_at: '1700000000',
      max_connections: '2',
      allowed_output_formats: ['m3u8', 'ts']
    },
    server_info: {
      url: host,
      port: '80',
      https_port: '443',
      server_protocol: 'http',
      rtmp_port: '1935',
      timezone: 'Europe/Stockholm',
      timestamp_now: Math.floor(now / 1000),
      time_now: fmt(now)
    }
  };
}

// Large responses are built once per catalogue and cached as a string.
const bigCache = new Map();
function cachedJson(key, build) {
  if (!bigCache.has(key)) bigCache.set(key, JSON.stringify(build()));
  return bigCache.get(key);
}

// Returns an object or a ready-made JSON string.
function playerApi(params, catalog, base, host) {
  if (params.get('username') !== USER || params.get('password') !== PASS) {
    return { user_info: { auth: 0 } };
  }
  const now = Date.now();
  const isLarge = catalog === 'large';
  const action = params.get('action');
  const cat = params.get('category_id');
  const mediaData = () => buildMedia();
  switch (action) {
    case 'get_live_categories':
      if (isLarge) return buildLarge().categories.map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 }));
      return SMALL_CATEGORIES.map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 }));
    case 'get_live_streams': {
      if (isLarge) {
        const L = buildLarge();
        if (cat) return (L.byCat.get(cat) || []).map((c) => liveStream(c, base));
        return cachedJson('live:' + base, () => L.channels.map((c) => liveStream(c, base)));
      }
      return SMALL_CHANNELS.filter((c) => !cat || c.cat === cat).map((c) => liveStream(c, base));
    }
    case 'get_short_epg': {
      const sid = String(params.get('stream_id'));
      if (!channelById.has(sid) && Number(sid) >= 100000) buildLarge();
      const ch = channelById.get(sid);
      if (!ch || !hasEpg(ch)) return { epg_listings: [] };
      return { epg_listings: schedule(ch, now, Math.min(40, Number(params.get('limit')) || 4)) };
    }
    case 'get_vod_categories':
      return VOD_CATEGORIES.map((name, i) => ({ category_id: String(101 + i), category_name: name, parent_id: 0 }));
    case 'get_vod_streams': {
      const M = mediaData();
      if (cat) return M.movies.filter((m) => vodCatId(m) === cat).map((m) => vodStream(m, base));
      return cachedJson('vod:' + base, () => M.movies.map((m) => vodStream(m, base)));
    }
    case 'get_vod_info': {
      const m = mediaData().movieById.get(String(params.get('vod_id')));
      if (!m) return { info: [], movie_data: [] };
      return {
        info: {
          kinopoisk_url: '',
          tmdb_id: m.tmdb,
          name: m.title,
          o_name: m.title,
          cover_big: m.noPoster ? '' : `${base}/__mock/poster/m${m.id}.svg`,
          movie_image: m.noPoster ? '' : `${base}/__mock/poster/m${m.id}.svg`,
          releasedate: `${m.year}-09-01`,
          episode_run_time: '',
          youtube_trailer: '',
          director: m.director,
          actors: m.cast,
          cast: m.cast,
          description: m.plot,
          plot: m.plot,
          age: '',
          country: 'Sverige',
          genre: m.genre,
          backdrop_path: [`${base}/__mock/backdrop/m${m.id}.svg`],
          duration_secs: m.duration * 60,
          duration: `${String(Math.floor(m.duration / 60)).padStart(2, '0')}:${String(m.duration % 60).padStart(2, '0')}:00`,
          bitrate: 4200,
          rating: String(m.rating)
        },
        movie_data: {
          stream_id: m.id,
          name: `${m.title} (${m.year})`,
          added: String(m.added),
          category_id: vodCatId(m),
          container_extension: 'mp4',
          custom_sid: '',
          direct_source: ''
        }
      };
    }
    case 'get_series_categories':
      return SERIES_CATEGORIES.map((name, i) => ({ category_id: String(201 + i), category_name: name, parent_id: 0 }));
    case 'get_series': {
      const M = mediaData();
      if (cat) return M.series.filter((s) => seriesCatId(s) === cat).map((s) => seriesItem(s, base));
      return cachedJson('series:' + base, () => M.series.map((s) => seriesItem(s, base)));
    }
    case 'get_series_info': {
      const s = mediaData().seriesById.get(String(params.get('series_id')));
      if (!s) return { seasons: [], info: {}, episodes: {} };
      const episodes = {};
      s.seasons.forEach((list, i) => {
        episodes[String(i + 1)] = list.map((ep) => ({
          id: String(ep.id),
          episode_num: ep.episode,
          title: `${s.title} – S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')} – ${ep.title}`,
          container_extension: 'mp4',
          info: {
            movie_image: `${base}/__mock/still/${ep.id}.svg`,
            plot: ep.plot,
            duration_secs: ep.duration * 60,
            duration: `00:${String(ep.duration).padStart(2, '0')}:00`,
            releasedate: `${s.year + i}-0${1 + (ep.episode % 9)}-1${ep.episode % 9}`,
            rating: String(s.rating)
          },
          custom_sid: '',
          added: String(s.added),
          season: ep.season,
          direct_source: ''
        }));
      });
      return {
        seasons: s.seasons.map((list, i) => ({
          air_date: `${s.year + i}-01-10`,
          episode_count: list.length,
          id: s.id * 10 + i,
          name: `Säsong ${i + 1}`,
          overview: '',
          season_number: i + 1,
          cover: `${base}/__mock/poster/s${s.id}.svg`,
          cover_big: `${base}/__mock/poster/s${s.id}.svg`
        })),
        info: Object.assign(seriesItem(s, base), { name: s.title }),
        episodes
      };
    }
    case null:
    case undefined:
    case '':
      return userInfo(now, host);
    default:
      return [];
  }
}

const sendJson = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
};

export async function handleProxy(target, res) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  if (u.hostname !== DEMO_HOST) return false;
  // A short delay so that the loading states are visible.
  await new Promise((r) => setTimeout(r, 180 + Math.random() * 220));
  if (u.pathname === '/player_api.php') sendJson(res, 200, playerApi(u.searchParams, 'small', '', DEMO_HOST));
  else sendJson(res, 404, { error: 'not found' });
  return true;
}

// --- /__xtream: the large catalogue with real Xtream paths --------------------------

function m3u(base, output) {
  const L = buildLarge();
  const M = buildMedia();
  const ext = output === 'm3u8' || output === 'hls' ? 'm3u8' : 'ts';
  const catName = new Map(L.categories.map((c) => [c.id, c.name]));
  const vodCatName = (m) => VOD_CATEGORIES[Number(m.cat) - 1];
  const lines = ['#EXTM3U'];
  for (const ch of L.channels) {
    const logo = ch.logo ? `${base}/__mock/logo/${ch.id}.svg` : '';
    lines.push(`#EXTINF:-1 tvg-id="${hasEpg(ch) ? slug(ch.name) + '.se' : ''}" tvg-name="${ch.name}" tvg-logo="${logo}" tvg-chno="${ch.num}" group-title="${catName.get(ch.cat)}",${ch.name}`);
    lines.push(`${base}/__xtream/live/${USER}/${PASS}/${ch.id}.${ext}`);
  }
  for (const m of M.movies) {
    lines.push(`#EXTINF:-1 tvg-id="" tvg-name="${m.title} (${m.year})" tvg-logo="${m.noPoster ? '' : `${base}/__mock/poster/m${m.id}.svg`}" group-title="${vodCatName(m)}",${m.title} (${m.year})`);
    lines.push(`${base}/__xtream/movie/${USER}/${PASS}/${m.id}.mp4`);
  }
  return lines.join('\n') + '\n';
}

export async function handleXtream(req, res, url) {
  const host = req.headers.host || 'localhost';
  const base = `http://${host}`;
  const path = url.pathname.replace(/^\/__xtream/, '');

  if (path === '/player_api.php' || path === '/player_api.php/') {
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 80));
    sendJson(res, 200, playerApi(url.searchParams, 'large', base, host));
    return true;
  }
  if (path === '/get.php') {
    if (url.searchParams.get('username') !== USER || url.searchParams.get('password') !== PASS) {
      res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Wrong username or password');
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(m3u(base, url.searchParams.get('output')));
    return true;
  }
  if (path === '/xmltv.php') {
    // Minimal XMLTV for the channels in the Swedish categories.
    const L = buildLarge();
    const now = Date.now();
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="g3custom-demo">'];
    const list = L.channels.filter((c) => Number(c.cat) <= 6);
    const stamp = (ms) => {
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
    };
    for (const ch of list) out.push(`<channel id="${slug(ch.name)}.se"><display-name>${escXml(ch.name)}</display-name></channel>`);
    for (const ch of list) {
      // Channels with catch-up: a guide going a day back (so that past programmes can be played).
      for (const p of schedule(ch, now - (ch.archive ? 26 : 2) * 3600e3, ch.archive ? 40 : 14)) {
        const title = Buffer.from(p.title, 'base64').toString('utf8');
        const desc = Buffer.from(p.description, 'base64').toString('utf8');
        out.push(`<programme start="${stamp(p.start_timestamp * 1000)}" stop="${stamp(p.stop_timestamp * 1000)}" channel="${slug(ch.name)}.se"><title>${escXml(title)}</title><desc>${escXml(desc)}</desc></programme>`);
      }
    }
    out.push('</tv>');
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    res.end(out.join('\n'));
    return true;
  }
  let m = /^\/live\/[^/]+\/[^/]+\/(\d+)\.(m3u8|ts)$/.exec(path);
  if (m) {
    res.writeHead(302, { Location: `/__mock/stream/${m[1]}.mp4` }).end();
    return true;
  }
  // Catch-up: /timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<id>.ts → a "recorded" clip
  m = /^\/timeshift\/[^/]+\/[^/]+\/\d+\/[\d:-]+\/(\d+)\.(ts|m3u8)$/.exec(path);
  if (m) {
    res.writeHead(302, { Location: `/__mock/vod/${m[1]}.mp4` }).end();
    return true;
  }
  m = /^\/(movie|series)\/[^/]+\/[^/]+\/(\d+)\.(\w+)$/.exec(path);
  if (m) {
    // .mkv gives the same clip in Matroska with two subtitle tracks (for the subtitles via the hub).
    res.writeHead(302, { Location: `/__mock/vod/${m[2]}.${m[3] === 'mkv' ? 'mkv' : 'mp4'}` }).end();
    return true;
  }
  sendJson(res, 404, { error: 'not found' });
  return true;
}

// --- Graphics ----------------------------------------------------------------------

function logoSvg(ch) {
  const words = ch.name.replace(/^[A-Z0-9/+\-]+ \| /, '').replace(/ (HD|FHD|SD|HEVC|4K|HD\+|\(BACKUP\))$/, '').split(/\s+/);
  const text = words.length > 1 && words[0].length <= 4 ? words.slice(0, 2).join(' ') : words[0];
  const size = text.length > 9 ? 30 : text.length > 6 ? 38 : 48;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 135">
  <rect width="240" height="135" rx="18" fill="${ch.color}"/>
  <text x="120" y="68" dy=".35em" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="800" font-size="${size}" fill="#fff" letter-spacing="-1">${escXml(text)}</text>
</svg>`;
}

function wrapTitle(title, max) {
  const words = title.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

function art(seed, w, h, palette) {
  const rand = rng(seed);
  const [a, b, c] = PALETTES[palette % PALETTES.length];
  const cx = Math.round(w * (0.2 + rand() * 0.6));
  const cy = Math.round(h * (0.15 + rand() * 0.45));
  const r = Math.round(Math.min(w, h) * (0.35 + rand() * 0.3));
  const angle = Math.round(rand() * 360);
  const band = Math.round(rand() * 40) - 20;
  return `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(${band})"><stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></linearGradient>
    <radialGradient id="glow" cx="${cx / w}" cy="${cy / h}" r="0.7"><stop offset="0" stop-color="${c}" stop-opacity="0.75"/><stop offset="0.45" stop-color="${c}" stop-opacity="0.12"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.75"/></linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-opacity="0.22" stroke-width="${Math.round(w / 90)}"/>
  <circle cx="${cx}" cy="${cy}" r="${Math.round(r * 0.62)}" fill="${c}" fill-opacity="0.1"/>
  <rect x="${-w}" y="${Math.round(h * 0.55)}" width="${w * 3}" height="${Math.round(h / 9)}" fill="#fff" fill-opacity="0.05" transform="rotate(${angle % 30 - 15} ${w / 2} ${h / 2})"/>
  <rect width="${w}" height="${h}" fill="url(#fade)"/>`;
}

function posterSvg(item, kind) {
  const w = 500;
  const h = 750;
  const lines = wrapTitle(item.title.toUpperCase(), 13);
  const size = lines.some((l) => l.length > 10) ? 46 : 58;
  const startY = h - 110 - (lines.length - 1) * (size + 6);
  const text = lines.map((l, i) => `<text x="40" y="${startY + i * (size + 6)}" font-family="Helvetica Neue, Arial, sans-serif" font-weight="800" font-size="${size}" fill="#fff" letter-spacing="-1.5">${escXml(l)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  ${art(hash(kind + item.id), w, h, item.palette)}
  <text x="40" y="70" font-family="Helvetica Neue, Arial, sans-serif" font-weight="600" font-size="24" fill="#fff" fill-opacity="0.7" letter-spacing="4">${kind === 's' ? 'SERIE' : 'FILM'} · ${item.year}</text>
  ${text}
  <rect x="40" y="${h - 70}" width="70" height="5" rx="2" fill="#fff" fill-opacity="0.8"/>
</svg>`;
}

function backdropSvg(item, kind) {
  const w = 1280;
  const h = 720;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  ${art(hash('bd' + kind + item.id), w, h, item.palette + 3)}
</svg>`;
}

function stillSvg(ep) {
  const w = 640;
  const h = 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  ${art(hash('ep' + ep.id), w, h, ep.palette + ep.episode)}
  <text x="28" y="${h - 30}" font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="30" fill="#fff" fill-opacity="0.85">S${ep.season} · E${ep.episode}</text>
</svg>`;
}

// --- Demo video -----------------------------------------------------------------------

const MEDIA = join(BUILD, 'dev-media');
const CLIPS = [
  'gradients=s=640x360:r=25:c0=0x0a84ff:c1=0x5e5ce6:c2=0x101030:speed=0.03:d=12',
  'testsrc2=s=640x360:r=25:d=12',
  'gradients=s=640x360:r=25:c0=0xff7a38:c1=0xe4002b:c2=0x200810:type=radial:speed=0.025:d=12',
  'mandelbrot=s=640x360:r=25',
  'gradients=s=640x360:r=25:c0=0x30d158:c1=0x0b3d2e:c2=0x0a84ff:type=spiral:speed=0.02:d=12',
  'life=s=640x360:r=25:mold=10:life_color=0xffd60a:death_color=0x1c1c1e:mold_color=0x5e5ce6'
];
let mediaState = null; // null = not tried, true = done, false = failed
let vodState = null;

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { stdio: 'pipe', timeout: 120000 });
  if (r.status !== 0) throw new Error((r.stderr || '').toString() || 'ffmpeg failed');
}

function ensureMedia() {
  if (mediaState !== null) return mediaState;
  try {
    mkdirSync(MEDIA, { recursive: true });
    for (let i = 0; i < CLIPS.length; i++) {
      const out = join(MEDIA, `clip${i}.mp4`);
      if (existsSync(out) && statSync(out).size > 1000) continue;
      ffmpeg(['-f', 'lavfi', '-i', CLIPS[i], '-t', '12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-movflags', '+faststart', out]);
    }
    mediaState = true;
  } catch (e) {
    console.warn('[dev-mocks] could not create the demo video:', e.message);
    mediaState = false;
  }
  return mediaState;
}

// Movies/episodes: three minutes with a timecode, so that seeking and "continue watching" can be tested.
function ensureVod() {
  if (vodState !== null) return vodState;
  const out = join(MEDIA, 'vod.mp4');
  try {
    mkdirSync(MEDIA, { recursive: true });
    if (!(existsSync(out) && statSync(out).size > 1000)) {
      ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=180', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:d=180',
        '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-c:a', 'aac', '-b:a', '64k',
        '-movflags', '+faststart', out]);
    }
    vodState = true;
  } catch (e) {
    console.warn('[dev-mocks] could not create the movie clip:', e.message);
    vodState = false;
  }
  return vodState;
}

// The same clip as .mkv with two subtitle tracks: Swedish SRT, and English ASS in exactly the format
// that LG's subtitle engine cannot handle (text before the first comma disappears). One cue every four seconds.
export const SUB_CUES = Array.from({ length: 40 }, (_, i) => ({
  start: 2 + i * 4, end: 5 + i * 4,
  sv: i % 2 ? `Replik ${i + 1} på svenska,\nmed en andra rad.` : `Replik ${i + 1} utan kommatecken`,
  en: i % 2 ? `Line ${i + 1} in English,\nwith a second row.` : `Line ${i + 1} without a comma`
}));
let mkvState = null;
function ensureVodMkv() {
  if (mkvState !== null) return mkvState;
  const out = join(MEDIA, 'vod.mkv');
  try {
    if (!ensureVod()) throw new Error('no movie clip');
    if (!(existsSync(out) && statSync(out).size > 1000)) {
      const pad = (n, w = 2) => String(n).padStart(w, '0');
      const srtT = (t) => `00:${pad(Math.floor(t / 60))}:${pad(t % 60)},000`;
      const assT = (t) => `0:${pad(Math.floor(t / 60))}:${pad(t % 60)}.00`;
      writeFileSync(join(MEDIA, 'sv.srt'), SUB_CUES.map((c, i) => `${i + 1}\n${srtT(c.start)} --> ${srtT(c.end)}\n${c.sv}\n`).join('\n'));
      writeFileSync(join(MEDIA, 'en.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 3840\nPlayResY: 1920\n\n[V4+ Styles]\n' +
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
        'Style: Default,Arial,80,&H00ffffff,&H00000000,&H00808080,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0\n\n[Events]\n' +
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
        SUB_CUES.map((c) => `Dialogue: 0,${assT(c.start)},${assT(c.end)},Default,,0,0,0,,${c.en.replace(/\n/g, '\\N')}\\n`).join('\n') + '\n');
      ffmpeg(['-i', join(MEDIA, 'vod.mp4'), '-i', join(MEDIA, 'sv.srt'), '-i', join(MEDIA, 'en.ass'), '-map', '0', '-map', '1', '-map', '2',
        '-c', 'copy', '-c:s:0', 'srt', '-c:s:1', 'ass', '-metadata:s:s:0', 'language=swe', '-metadata:s:s:1', 'language=eng', out]);
    }
    mkvState = true;
  } catch (e) {
    console.warn('[dev-mocks] could not create the .mkv with subtitles:', e.message);
    mkvState = false;
  }
  return mkvState;
}

function serveFile(req, res, file, type) {
  const size = statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes'
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    createReadStream(file).pipe(res);
  }
}

const svg = (res, body) => {
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
};

export async function handle(req, res, url) {
  let m = /^\/__mock\/logo\/(\d+)\.svg$/.exec(url.pathname);
  if (m) {
    if (!channelById.has(m[1]) && Number(m[1]) >= 100000) buildLarge();
    const ch = channelById.get(m[1]);
    if (!ch) return false;
    svg(res, logoSvg(ch));
    return true;
  }
  m = /^\/__mock\/(poster|backdrop)\/([ms])(\d+)\.svg$/.exec(url.pathname);
  if (m) {
    const M = buildMedia();
    const item = m[2] === 'm' ? M.movieById.get(m[3]) : M.seriesById.get(m[3]);
    if (!item) return false;
    svg(res, m[1] === 'poster' ? posterSvg(item, m[2]) : backdropSvg(item, m[2]));
    return true;
  }
  m = /^\/__mock\/still\/(\d+)\.svg$/.exec(url.pathname);
  if (m) {
    const ep = buildMedia().episodes.get(m[1]);
    if (!ep) return false;
    svg(res, stillSvg(ep));
    return true;
  }
  m = /^\/__mock\/stream\/(\d+)\.mp4$/.exec(url.pathname);
  if (m) {
    const id = Number(m[1]);
    if (!channelById.has(m[1]) && id >= 100000) buildLarge();
    const ch = channelById.get(m[1]);
    // Channel IDs ending in 13 are "off air" – to show the error state.
    if (!ch || ch.id % 100 === 13 || !ensureMedia()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No signal');
      return true;
    }
    const clip = (Number(ch.show || ch.cat) + ch.id) % CLIPS.length;
    serveFile(req, res, join(MEDIA, `clip${clip}.mp4`), 'video/mp4');
    return true;
  }
  m = /^\/__mock\/vod\/(\d+)\.mp4$/.exec(url.pathname);
  if (m) {
    if (!ensureVod()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No video');
      return true;
    }
    serveFile(req, res, join(MEDIA, 'vod.mp4'), 'video/mp4');
    return true;
  }
  m = /^\/__mock\/vod\/(\d+)\.mkv$/.exec(url.pathname);
  if (m) {
    if (!ensureVodMkv()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('No video');
      return true;
    }
    serveFile(req, res, join(MEDIA, 'vod.mkv'), 'application/octet-stream');
    return true;
  }
  return false;
}
