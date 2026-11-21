/*
 * Art — how an app/input looks as a tile.
 *
 *   - Apps: the TV's own icon (best resolution) via the service, saved as a data URI.
 *     If the icon has its own opaque background (YouTube, Prime Video, SVT …) it fills the tile and
 *     the tile gets the corner colour – then it looks like a real tvOS icon. Otherwise it is drawn on a
 *     gradient in the app's colour.
 *   - Inputs: vector logo if the device is recognised (PlayStation, SHIELD …), otherwise a glyph.
 *   - Built-in: their own glyphs.
 *
 *   Art.get(app)    -> art | null   (synchronous, from cache)
 *   Art.load(app)   -> Promise<art>
 *   Art.face(app, art) -> { style, html }
 *   Art.palette(hex)   -> { rgb, bg, fg }
 */
(function (global) {
  'use strict';

  const STORE_KEY = 'g3:art:v1';
  const MAX_CHARS = 3500000; // roughly half of localStorage
  const esc = (s) => UI.esc(s);

  // --- Colours -------------------------------------------------------------------------

  function hexToRgb(hex) {
    const h = String(hex || '').trim().replace('#', '');
    if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(h)) return null;
    const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  const toHex = (rgb) => '#' + rgb.map((v) => ('0' + Math.round(v).toString(16)).slice(-2)).join('');

  function rgbToHsl(rgb) {
    const r = rgb[0] / 255;
    const g = rgb[1] / 255;
    const b = rgb[2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function hslToRgb(hsl) {
    const h = hsl[0];
    const s = hsl[1];
    const l = hsl[2];
    if (!s) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }

  function luminance(rgb) {
    const c = rgb.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // Rich, dark gradient in the app's colour – for glyph icons (white symbols).
  function palette(color) {
    const rgb = hexToRgb(color) || [58, 58, 64];
    const hsl = rgbToHsl(rgb);
    const s = Math.min(hsl[1], 0.72);
    const top = hslToRgb([hsl[0], s, Math.min(Math.max(hsl[2], 0.42), 0.52)]);
    const bottom = hslToRgb([hsl[0], Math.min(s * 1.05, 0.8), Math.min(Math.max(hsl[2] - 0.16, 0.2), 0.3)]);
    return {
      rgb,
      bg: 'linear-gradient(155deg,' + toHex(top) + ' 0%,' + toHex(bottom) + ' 100%)',
      fg: '#fff'
    };
  }

  // --- Cache ---------------------------------------------------------------------------

  let disk = {};
  try { disk = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { disk = {}; }
  const mem = {};
  let saveTimer = null;

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // Drop the oldest until it fits.
      let keys = Object.keys(disk).sort((a, b) => (disk[b].t || 0) - (disk[a].t || 0));
      let total = 0;
      const keep = {};
      keys.forEach((k) => {
        const len = (disk[k].src || '').length + 80;
        if (total + len <= MAX_CHARS) { keep[k] = disk[k]; total += len; }
      });
      disk = keep;
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(disk));
      } catch (e) {
        // Still full: keep half.
        keys = Object.keys(disk).slice(0, Math.floor(Object.keys(disk).length / 2));
        const half = {};
        keys.forEach((k) => { half[k] = disk[k]; });
        disk = half;
        try { localStorage.setItem(STORE_KEY, JSON.stringify(disk)); } catch (e2) { /* give up */ }
      }
    }, 800);
  }

  const keyFor = (app) => (app.icon || '') + '|' + (app.installTime || 0);

  // --- Analysis: does the icon cover the whole area? -----------------------------------

  // Heavy work (decoding, canvas) when the browser is idle – never in the middle of a focus move.
  const idle = () => new Promise((resolve) => {
    if (global.requestIdleCallback) global.requestIdleCallback(() => resolve(), { timeout: 1500 });
    else setTimeout(resolve, 30);
  });

  function analyze(src) {
    return idle().then(() => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const n = 48;
          const c = document.createElement('canvas');
          c.width = n;
          c.height = n;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, n, n);
          const data = ctx.getImageData(0, 0, n, n).data; // a single read
          const px = (x, y) => { const o = (y * n + x) * 4; return [data[o], data[o + 1], data[o + 2], data[o + 3]]; };
          const pts = [[2, 2], [n - 3, 2], [2, n - 3], [n - 3, n - 3], [n >> 1, 1], [n >> 1, n - 2], [1, n >> 1], [n - 2, n >> 1]];
          const samples = pts.map((p) => px(p[0], p[1]));
          const opaque = samples.every((d) => d[3] >= 245);
          const avg = [0, 1, 2].map((i) => samples.reduce((a, d) => a + d[i], 0) / samples.length);
          const spread = Math.max.apply(null, samples.map((d) => Math.abs(d[0] - avg[0]) + Math.abs(d[1] - avg[1]) + Math.abs(d[2] - avg[2])));
          resolve({ full: opaque && spread < 48, bg: toHex(avg), w: img.naturalWidth, h: img.naturalHeight });
        } catch (e) {
          resolve({ full: false, bg: null });
        }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    }));
  }

  // At most two icons at a time from the service.
  const queue = [];
  let active = 0;
  function enqueue(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  }
  function pump() {
    while (active < 2 && queue.length) {
      const job = queue.shift();
      active++;
      job.fn().then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  }

  // --- Built-in and inputs ---------------------------------------------------------------

  const INTERNAL_ART = {
    'internal:tv': { kind: 'glyph', glyph: 'tv', bg: 'linear-gradient(155deg,#3b8cff 0%,#1f3fd6 55%,#1a1f8f 100%)' },
    'internal:settings': { kind: 'glyph', glyph: 'gear', bg: 'linear-gradient(155deg,#8e8e96 0%,#4a4a52 100%)' },
    'internal:screenoff': { kind: 'glyph', glyph: 'moon', bg: 'linear-gradient(155deg,#3a3f5c 0%,#16182a 60%,#0a0b14 100%)' },
    'internal:lghome': { kind: 'glyph', glyph: 'grid', bg: 'linear-gradient(155deg,#d6336c 0%,#a50034 60%,#6d0022 100%)' }
  };

  function inputArt(app) {
    const inp = app.input || {};
    const brand = global.Brands && Brands.match([inp.brand, inp.deviceName, inp.label, app.title].join(' '));
    if (brand) return { kind: 'brand', brand: brand.key, bg: brand.bg, fg: brand.fg, dim: !inp.connected };
    return {
      kind: 'glyph',
      glyph: inp.type === 'game' ? 'gamepad' : 'hdmi',
      bg: 'linear-gradient(155deg,#55555c 0%,#2a2a2f 100%)',
      dim: !inp.connected
    };
  }

  // --- Public -----------------------------------------------------------------------------

  function get(app) {
    if (!app) return null;
    if (INTERNAL_ART[app.id]) return INTERNAL_ART[app.id];
    if (app.kind === 'input') return inputArt(app);
    if (!app.icon) return { kind: 'name', bg: palette(app.iconColor || app.bgColor).bg };
    const k = keyFor(app);
    if (mem[k]) return mem[k];
    const d = disk[k];
    if (d && d.src) {
      d.t = Date.now();
      mem[k] = { kind: 'image', src: d.src, full: d.full, bg: d.full ? d.bg : palette(app.iconColor || d.bg).bg };
      return mem[k];
    }
    return null;
  }

  const pending = {};
  function load(app) {
    const cached = get(app);
    if (cached) return Promise.resolve(cached);
    const k = keyFor(app);
    if (pending[k]) return pending[k];
    pending[k] = enqueue(() => Root.image(app.icon))
      .then((r) => analyze(r.src).then((a) => {
        if (!a) throw new Error('could not read the icon');
        disk[k] = { src: r.src, full: a.full, bg: a.bg, t: Date.now() };
        persist();
        mem[k] = { kind: 'image', src: r.src, full: a.full, bg: a.full ? a.bg : palette(app.iconColor || a.bg).bg };
        return mem[k];
      }))
      .catch(() => {
        mem[k] = { kind: 'name', bg: palette(app.iconColor || app.bgColor).bg };
        return mem[k];
      })
      .finally(() => { delete pending[k]; });
    return pending[k];
  }

  // Content and style for the tile's face.
  function face(app, art) {
    art = art || { kind: 'name', bg: palette(app.iconColor).bg };
    let html;
    if (art.kind === 'image') {
      html = '<img class="tile-icon' + (art.full ? ' is-full' : '') + '" src="' + art.src + '" alt="" decoding="async">';
    } else if (art.kind === 'brand') {
      const b = Brands.get(art.brand);
      html = '<span class="tile-brand" style="color:' + art.fg + '">' + Brands.svg(b) + '</span>';
    } else if (art.kind === 'glyph') {
      html = '<span class="tile-glyph">' + Icons.svg(art.glyph) + '</span>';
    } else {
      html = '<span class="tile-name">' + esc(app.title) + '</span>';
    }
    return { style: '--tile-bg:' + art.bg, html, dim: !!art.dim };
  }

  global.Art = { get, load, face, palette, hexToRgb, luminance };
})(window);
