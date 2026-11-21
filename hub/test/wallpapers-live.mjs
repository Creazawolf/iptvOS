#!/usr/bin/env node
// Run every wallpaper source for real (against the internet) and show what they give. Not part of npm test.
//   node hub/test/wallpapers-live.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallpapers, WALLPAPER_SETS } from '../lib/wallpapers.mjs';

const dir = mkdtempSync(join(tmpdir(), 'g3wp-'));
const w = new Wallpapers(dir);
try {
  for (const id of WALLPAPER_SETS) {
    const t0 = Date.now();
    await w.items([id], 3);
    while (w.loading.has(id)) await w.loading.get(id); // Commons and the photos take a while
    const items = await w.items([id], 3);
    const all = (await w.list()).find((s) => s.id === id);
    console.log(`\n${id}: ${all.count} images (${((Date.now() - t0) / 1000).toFixed(1)} s)${all.error ? ' ERROR: ' + all.error : ''}`);
    for (const it of items) console.log('   ', JSON.stringify({ title: it.title, credit: it.credit, src: it.src.slice(0, 90) }));
  }
  const t0 = Date.now();
  const a = await w.aerial();
  const by = {};
  for (const v of a.videos) by[v.source] = (by[v.source] || 0) + 1;
  console.log(`\naerial videos: ${a.videos.length} (${((Date.now() - t0) / 1000).toFixed(1)} s)`, JSON.stringify(by), a.error || '');
  for (const src of ['apple', 'community', 'amazon']) {
    const v = a.videos.find((x) => x.source === src);
    if (v) console.log('   ', JSON.stringify({ name: v.name, place: v.place, scene: v.scene, time: v.time, poi: v.poi.slice(0, 2), hd: v.urls.hd.slice(-40), uhd: !!v.urls.uhd, hdr: !!v.urls.hdr }));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
