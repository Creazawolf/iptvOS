/*
 * Wallpaper — the background behind the home screen and ambient mode.
 *
 * Collections (Settings › Background, several can be selected at once – Store 'layout.wallpaperSets'):
 *   glass    our own abstract images in assets/wallpapers (bundled with the app, always work)
 *   space    Space · earth  Earth from above · nature  Nature and landscapes · featured  Featured images ·
 *   bing     Image of the day · photos  Photographs – come from the hub (/api/wallpapers), which holds
 *            the sources' lists. The hub decides which exist; the launcher shows the ones it gets.
 * Without a hub there is Glass and a small built-in space collection.
 *
 * Performance: the TV fetches one image at a time, scaled down to 1,920 px by the hub's image proxy (from
 * the home network), decodes it before the crossfade and keeps only two image layers. The selection (30 entries
 * at a time) is fetched only a while after startup. The blurred variant is a pre-blurred 128×72 image that is
 * scaled up – blur without a filter. If an image does not load within a few seconds the next one is used, finally a built-in one.
 *
 *   Wallpaper.init()
 *   Wallpaper.mode('shelf' | 'grid' | 'dim' | 'ambient')
 *   Wallpaper.next()                    change image now
 *   Wallpaper.show(src) / restore()     show another image temporarily (e.g. the app's own image)
 *   Wallpaper.current()                 { id, title, credit }
 *   Wallpaper.sets() / setSets([...])   selected collections
 *   Wallpaper.available()               Promise<[{ id, title, detail, count }]>  (for settings)
 */
(function (global) {
  'use strict';

  const LOCAL = ['indigo', 'aurora', 'ember', 'lagoon', 'rose', 'graphite'].map((id) => ({
    id: 'glass:' + id,
    title: tr('wallpaper.glassItem', { name: id.charAt(0).toUpperCase() + id.slice(1) }),
    credit: '',
    src: 'assets/wallpapers/' + id + '.jpg',
    blur: 'assets/wallpapers/' + id + '-blur.jpg'
  }));

  // Small built-in space collection for the mode without a hub (with a hub ~300 images come from there).
  const WEBB = 'https://cdn.esawebb.org/archives/images/wallpaper4/';
  const HUBBLE = 'https://cdn.esahubble.org/archives/images/wallpaper4/';
  const SPACE = [
    ['weic2616a', tr('wallpaper.images.lionNebula'), WEBB],
    ['potm2503a', tr('wallpaper.images.lensedSpiral'), WEBB],
    ['weic2612a', tr('wallpaper.images.cigarGalaxy'), WEBB],
    ['weic2615a', 'Centaurus A', WEBB],
    ['weic2602a', 'Uranus', WEBB],
    ['weic2519a', tr('wallpaper.images.stellarJet'), WEBB],
    ['weic2218a', tr('wallpaper.images.pillars'), WEBB],
    ['heic2017a', tr('wallpaper.images.jupiterEuropa'), HUBBLE],
    ['heic1917a', tr('wallpaper.images.saturn'), HUBBLE],
    ['opo0328a', tr('wallpaper.images.sombrero'), HUBBLE],
    ['heic0506a', tr('wallpaper.images.whirlpool'), HUBBLE],
    ['heic0910h', tr('wallpaper.images.butterfly'), HUBBLE],
    ['heic1608a', tr('wallpaper.images.bubble'), HUBBLE],
    ['heic2018b', tr('wallpaper.images.ngc2525'), HUBBLE]
  ].map(([id, title, base]) => ({
    id: 'space:' + id,
    title,
    credit: base === WEBB ? 'ESA/Webb, NASA & CSA · CC BY 4.0' : 'ESA/Hubble & NASA · CC BY 4.0',
    src: base + id + '.jpg',
    remote: true
  }));

  const BUILTIN = [
    { id: 'glass', title: tr('wallpaper.glass'), detail: tr('wallpaper.glassDetail'), count: LOCAL.length },
    { id: 'space', title: tr('wallpaper.space'), detail: tr('wallpaper.spaceDetail'), count: SPACE.length }
  ];

  const BLUR_KEY = 'g3:wpblur:v2';
  const CUR_KEY = 'g3:wp:cur';
  const BLUR_MAX = 30;       // blurred thumbnails that are saved (~2 kB each)
  const LOAD_TIMEOUT = 7000; // an image that has not arrived within this time is skipped
  let blurCache = {};
  try { blurCache = JSON.parse(localStorage.getItem(BLUR_KEY)) || {}; } catch (e) { blurCache = {}; }

  let root = null;
  let layers = [];
  let blurEl = null;
  let front = 0;
  let cur = null;
  let override = null;
  let timer = null;
  let currentMode = 'shelf';
  let started = false;
  let seq = 0;
  let localAt = 0;
  let spaceAt = 0;
  let queue = [];        // entries from the hub waiting for their turn
  let filling = null;
  let hubSets = null;    // the hub's collections once they are known

  // --- Which collections -------------------------------------------------------------------

  const hub = () => (global.IPTV && IPTV.source && IPTV.mode && IPTV.mode() === 'hub' ? IPTV.source.hub : null);
  const hubReady = () => {
    const b = global.IPTV && IPTV.boot && IPTV.boot();
    return !!(hub() && hub().wallpaperItems && b && b.caps && b.caps.wallpapers);
  };

  // Older setting (one collection: 'glass' | 'space' | 'mixed') applies until the user has chosen.
  function sets() {
    const s = Store.get('layout.wallpaperSets');
    if (Array.isArray(s) && s.length) return s;
    const old = Store.get('layout.wallpapers') || 'mixed';
    return old === 'glass' ? ['glass'] : old === 'space' ? ['space'] : ['glass', 'space'];
  }

  function setSets(list) {
    Store.set('layout.wallpaperSets', list && list.length ? list : ['glass']);
  }

  const remoteSets = () => (hubReady() ? sets().filter((id) => id !== 'glass') : []);

  function available() {
    if (!hubReady()) return Promise.resolve(BUILTIN);
    return hub().wallpapers().then((list) => {
      hubSets = list;
      return [BUILTIN[0]].concat(list);
    }, () => BUILTIN);
  }

  // --- Next image ----------------------------------------------------------------------------

  function fill() {
    if (filling || !remoteSets().length) return filling || Promise.resolve();
    const key = remoteSets().join(',');
    filling = hub().wallpaperItems(remoteSets(), 30).then((items) => {
      if (key !== remoteSets().join(',')) return; // the selection changed in the meantime
      queue = queue.concat(items.map((it) => ({
        id: it.id,
        title: it.title || '',
        credit: it.credit || '',
        src: hub().img(it.src, 1920),
        remote: true
      })));
    }, () => {}).then(() => { filling = null; });
    return filling;
  }

  // Every selected collection is equally likely. Glass and the built-in space collection go in order,
  // the hub's collections arrive already shuffled.
  function pickNext() {
    const chosen = sets();
    const remote = remoteSets();
    const pools = [];
    if (chosen.indexOf('glass') >= 0 || !chosen.length) pools.push('glass');
    if (!hubReady() && chosen.indexOf('space') >= 0) pools.push('space');
    remote.forEach(() => pools.push('hub'));
    if (!pools.length) pools.push('glass');
    const pool = pools[Math.floor(Math.random() * pools.length)];
    if (pool === 'hub') {
      if (queue.length < 4) fill();
      if (queue.length) return queue.shift();
      return LOCAL[localAt++ % LOCAL.length]; // the selection has not arrived yet
    }
    if (pool === 'space') return SPACE[spaceAt++ % SPACE.length];
    return LOCAL[localAt++ % LOCAL.length];
  }

  // --- The image -----------------------------------------------------------------------------

  // Small blurred version of a remote image (the image proxy and ESA's CDN allow CORS).
  function makeBlur(item, img) {
    if (!item.remote) return item.blur;
    if (blurCache[item.id]) return blurCache[item.id];
    try {
      const w = 128;
      const h = 72;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const ratio = img.naturalWidth / img.naturalHeight;
      const sw = ratio > 16 / 9 ? img.naturalHeight * 16 / 9 : img.naturalWidth;
      const sh = ratio > 16 / 9 ? img.naturalHeight : img.naturalWidth * 9 / 16;
      // Pre-blur at a small scale (and draw slightly larger so the edges do not darken).
      ctx.filter = 'blur(3px) saturate(1.2)';
      ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, -8, -5, w + 16, h + 10);
      const uri = c.toDataURL('image/jpeg', 0.8);
      blurCache[item.id] = uri;
      // With thousands of images the collection of thumbnails must not grow: keep the most recent.
      const keys = Object.keys(blurCache);
      for (let i = 0; i < keys.length - BLUR_MAX; i++) delete blurCache[keys[i]];
      try { localStorage.setItem(BLUR_KEY, JSON.stringify(blurCache)); } catch (e) { /* full */ }
      return uri;
    } catch (e) {
      return '';
    }
  }

  function preload(src, cors) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let done = false;
      const fail = (why) => { if (!done) { done = true; img.src = ''; reject(new Error(why)); } };
      const t = setTimeout(() => fail('image timed out'), LOAD_TIMEOUT);
      if (cors) img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        // Decode before the crossfade so that it does not stutter.
        if (img.decode) img.decode().then(() => resolve(img), () => resolve(img));
        else resolve(img);
      };
      img.onerror = () => { clearTimeout(t); fail('image failed to load'); };
      img.src = src;
    });
  }

  function paint(src, blur) {
    const next = layers[1 - front];
    next.style.backgroundImage = 'url("' + src + '")';
    // Two frames later: fade in (the image is already decoded).
    requestAnimationFrame(() => requestAnimationFrame(() => {
      next.classList.add('is-on');
      layers[front].classList.remove('is-on');
      front = 1 - front;
    }));
    blurEl.style.backgroundImage = blur ? 'url("' + blur + '")' : 'none';
  }

  // tries: how many more remote images may be tried before a built-in one is used.
  function load(item, tries) {
    const my = ++seq;
    return preload(item.src, !!item.remote).then((img) => {
      if (my !== seq) return;
      cur = item;
      try { localStorage.setItem(CUR_KEY, JSON.stringify({ id: item.id, title: item.title, credit: item.credit, src: item.src, remote: !!item.remote, blur: item.blur || '' })); } catch (e) { /* */ }
      if (!override) paint(item.src, makeBlur(item, img));
    }, () => {
      if (my !== seq || !item.remote) return;
      // Broken link or no connection: next image, finally a built-in one.
      const left = tries == null ? 2 : tries;
      const nextItem = left > 0 ? pickNext() : LOCAL[localAt++ % LOCAL.length];
      return load(nextItem, left - 1);
    });
  }

  function schedule() {
    clearInterval(timer);
    const min = +Store.get('layout.wallpaperMinutes') || 0;
    if (min > 0) timer = setInterval(() => { if (!document.hidden) next(); }, min * 60000);
  }

  function next() {
    return load(pickNext());
  }

  // At startup: the same image as last time (it is in the hub's cache), otherwise a built-in one immediately.
  function first() {
    let last = null;
    try { last = JSON.parse(localStorage.getItem(CUR_KEY)); } catch (e) { last = null; }
    const set = last && last.id ? String(last.id).split(':')[0] : '';
    const ok = last && last.src && (set === 'glass' ? sets().indexOf('glass') >= 0 : sets().indexOf(set) >= 0);
    return ok ? last : LOCAL[localAt++ % LOCAL.length];
  }

  function mode(m) {
    currentMode = m;
    if (!root) return;
    root.setAttribute('data-mode', m);
    blurEl.classList.toggle('is-on', m === 'grid' || m === 'dim');
  }

  function show(src) {
    override = src;
    return preload(src, false).then(() => {
      if (override === src) paint(src, '');
    }, () => {});
  }

  function restore() {
    if (!override) return;
    override = null;
    if (cur) paint(cur.src, cur.remote ? blurCache[cur.id] || '' : cur.blur);
  }

  function init() {
    if (started) return;
    started = true;
    root = document.querySelector('.wallpaper');
    root.innerHTML = '<div class="wp-layer"></div><div class="wp-layer"></div><div class="wp-blur"></div><div class="wp-shade"></div>';
    layers = Array.prototype.slice.call(root.querySelectorAll('.wp-layer'));
    blurEl = root.querySelector('.wp-blur');
    mode(currentMode);
    load(first(), 0);
    schedule();
    // The selection from the hub is fetched when the TV is idle a while after startup – not in the way of the home screen.
    setTimeout(() => {
      const go = () => fill();
      if (global.requestIdleCallback) global.requestIdleCallback(go, { timeout: 5000 });
      else go();
    }, 4000);
    Store.on((path) => {
      if (path === '*' || path === 'layout.wallpapers' || path === 'layout.wallpaperSets') {
        queue = [];
        fill().then(() => next());
      }
      if (path === '*' || path === 'layout.wallpaperMinutes') schedule();
    });
  }

  global.Wallpaper = {
    init,
    mode,
    next,
    show,
    restore,
    current: () => cur,
    sets,
    setSets,
    available,
    hubReady,
    known: () => [BUILTIN[0]].concat(hubSets || (hubReady() ? [] : [BUILTIN[1]])),
    getMode: () => currentMode
  };
})(window);
