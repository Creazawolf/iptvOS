// Search in channels, films and series. Insensitive to diacritics (ö = o), matches
// word starts. Ranking: exact > start > all words match a word start > substring.
// A linear pass over ~50,000 prepared strings takes a few milliseconds.
import { norm } from './util.mjs';

function score(e, q, words) {
  const n = e.n;
  const n2 = e.n2;
  if (n === q || n2 === q) return 100;
  if (n.startsWith(q) || (n2 && n2.startsWith(q))) return 80;
  const hay = ' ' + n + ' ';
  let all = true;
  for (const w of words) {
    if (hay.indexOf(' ' + w) < 0) {
      all = false;
      break;
    }
  }
  if (all) return 60;
  if (n.indexOf(q) >= 0) return 40;
  return 0;
}

function rank(list, q, words, limit, bonus) {
  const hits = [];
  for (const e of list) {
    let s = score(e, q, words);
    if (!s) continue;
    if (bonus) s += bonus(e);
    // Shorter names first on equal scores ("SVT1" before "SVT1 HD BACKUP").
    s -= Math.min(9, e.n.length / 12);
    hits.push({ e, s });
  }
  hits.sort((a, b) => b.s - a.s);
  return hits.slice(0, limit).map((h) => h.e.o);
}

export function search(catalog, query, { limit = 30, all = false, kinds = ['live', 'vod', 'series'] } = {}) {
  const q = norm(query);
  const out = { live: [], vod: [], series: [] };
  if (!q) return out;
  const words = q.split(' ').filter(Boolean);
  const favorites = catalog.idx.favorites;

  if (kinds.includes('live')) {
    let pool;
    if (all) pool = catalog.idx.live.items.values();
    else {
      // Visible categories + favourites (even if their category is hidden).
      const seen = new Set();
      pool = [];
      for (const e of catalog.visibleEntries('live')) { seen.add(e.o.id); pool.push(e); }
      for (const id of favorites) {
        const e = catalog.idx.live.items.get(id);
        if (e && !seen.has(id)) pool.push(e);
      }
    }
    const vis = catalog.idx.live.visible;
    out.live = rank(pool, q, words, limit, (e) => (favorites.has(e.o.id) ? 25 : 0) + (all && vis.has(e.o.categoryId) ? 10 : 0));
  }
  for (const kind of ['vod', 'series']) {
    if (!kinds.includes(kind)) continue;
    const pool = all ? catalog.idx[kind].items.values() : catalog.visibleEntries(kind);
    const vis = catalog.idx[kind].visible;
    out[kind] = rank(pool, q, words, limit, all ? (e) => (vis.has(e.o.categoryId) ? 10 : 0) : null);
  }
  return out;
}
