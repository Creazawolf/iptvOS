/*
 * IPTV — shared helpers: icons, formatting, logos and a small event bus.
 * Loaded first of the IPTV files (see index.html).
 *
 *   IPTV.u.icon('pause')            -> '<svg …>'
 *   IPTV.u.clock(3725)              -> '1:02:05'
 *   IPTV.u.duration(5400)           -> '1 h 30 min'
 *   IPTV.u.logo(channel, 'cls')     -> <img> or initials
 *   IPTV.on('change', fn) / IPTV.emit('change', reason)
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV || (global.IPTV = {});
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');

  // Custom icons (Lucide-based, ISC) that are not in Icons.
  const PATHS = {
    back10: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M10.5 9.5v6M13.5 9.5h1.5a1.5 1.5 0 0 1 0 6h-1.5z"/>',
    fwd10: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M9.5 9.5v6M12.5 9.5h1.5a1.5 1.5 0 0 1 0 6h-1.5z"/>',
    captions: '<rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>',
    next: '<polygon points="5 4 15 12 5 20 5 4"/><path d="M19 5v14"/>',
    speed: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1.2"/><rect x="14" y="4" width="4" height="16" rx="1.2"/>',
    back10: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    fwd10: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    restart: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    'star-fill': '<path d="M11.52 2.3a.53.53 0 0 1 .95 0l2.31 4.68a2.12 2.12 0 0 0 1.6 1.16l5.16.76a.53.53 0 0 1 .3.9l-3.74 3.63a2.12 2.12 0 0 0-.61 1.88l.88 5.14a.53.53 0 0 1-.77.56l-4.62-2.43a2.12 2.12 0 0 0-1.97 0L6.4 21a.53.53 0 0 1-.77-.56l.88-5.14a2.12 2.12 0 0 0-.61-1.88L2.16 9.8a.53.53 0 0 1 .3-.9l5.16-.76a2.12 2.12 0 0 0 1.6-1.16z"/>',
    series: '<rect width="20" height="14" x="2" y="7" rx="2"/><path d="M6 3h12M8 21h8"/>',
    backspace: '<path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z"/><path d="m18 9-6 6M12 9l6 6"/>',
    space: '<path d="M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    tv: '<rect width="20" height="15" x="2" y="7" rx="2"/><path d="m17 2-5 5-5-5"/>',
    film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18M3 7.5h4M3 12h18M3 16.5h4M17 3v18M17 7.5h4M17 16.5h4"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    signal: '<path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4v16"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
    grid: '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    'arrow-up': '<path d="m5 12 7-7 7 7M12 19V5"/>',
    'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    'eye-off': '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    star: '<path d="M11.52 2.3a.53.53 0 0 1 .95 0l2.31 4.68a2.12 2.12 0 0 0 1.6 1.16l5.16.76a.53.53 0 0 1 .3.9l-3.74 3.63a2.12 2.12 0 0 0-.61 1.88l.88 5.14a.53.53 0 0 1-.77.56l-4.62-2.43a2.12 2.12 0 0 0-1.97 0L6.4 21a.53.53 0 0 1-.77-.56l.88-5.14a2.12 2.12 0 0 0-.61-1.88L2.16 9.8a.53.53 0 0 1 .3-.9l5.16-.76a2.12 2.12 0 0 0 1.6-1.16z"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'
  };
  const FILLED = { play: 1, pause: 1, 'star-fill': 1, next: 1 };

  function icon(name, cls) {
    const body = PATHS[name];
    if (!body) return global.Icons ? Icons.svg(name, cls) : '';
    return '<svg class="icon ' + (FILLED[name] ? 'is-fill ' : '') + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true">' + body + '</svg>';
  }

  const pad = (n) => (n < 10 ? '0' : '') + n;

  // Time of day from ms.
  function time(ms) {
    const d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // Playing time 12:34 or 1:02:03 (seconds).
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
  }

  // Duration in words: "1 h 52 min" (seconds).
  function duration(sec) {
    const m = Math.round((sec || 0) / 60);
    if (!m) return '';
    if (m < 60) return tr('common.minutesShort', { n: m });
    return m % 60 ? tr('iptvUtil.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 }) : tr('iptvUtil.hours', { h: Math.floor(m / 60) });
  }

  function minutesLeft(p) {
    const m = Math.max(0, Math.round((p.end - Date.now()) / 60000));
    if (m >= 60) return tr('iptvUtil.hoursMinutesLeft', { h: Math.floor(m / 60), m: m % 60 });
    return tr('iptvUtil.minutesLeft', { n: m });
  }

  function monogram(name) {
    const clean = String(name || '?')
      .replace(/^[A-Z]{2,4}\s*[|:]\s*/, '')
      .replace(/\b(HD|FHD|UHD|4K|SD)\b/g, '')
      .trim();
    const words = clean.split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (/^\w{1,4}\d*$/.test(words[0]) && words[0].length <= 4) return words[0].toUpperCase();
    return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }

  // Channel logo (via the hub's image cache if there is one), with initials as a fallback.
  function logo(ch, cls, w) {
    const mono = '<span class="tv-mono">' + esc(monogram(ch && ch.name)) + '</span>';
    if (!ch || !ch.logo) return mono;
    return '<img class="' + (cls || '') + '" src="' + esc(img(ch.logo, w || 160)) + '" alt="" decoding="async" data-mono="' +
      esc(monogram(ch.name)) + '" data-orig="' + esc(ch.logo) + '">';
  }

  function img(url, w) {
    return IPTV.source && IPTV.source.img ? IPTV.source.img(url, w) : url;
  }

  // Broken images: try the original address (in case the image cache is misbehaving), otherwise initials/hide.
  document.addEventListener('error', (e) => {
    const im = e.target;
    if (!im || im.tagName !== 'IMG') return;
    const orig = im.getAttribute('data-orig');
    if (orig && im.getAttribute('src') !== orig && !im.hasAttribute('data-tried')) {
      im.setAttribute('data-tried', '');
      im.src = orig;
      return;
    }
    if (im.hasAttribute('data-mono')) {
      const span = document.createElement('span');
      span.className = 'tv-mono';
      span.textContent = im.getAttribute('data-mono');
      im.replaceWith(span);
    } else if (im.hasAttribute('data-hide-broken')) {
      im.style.visibility = 'hidden';
    }
  }, true);

  const sameId = (a, b) => !!(a && b && String(a.id) === String(b.id));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function debounce(fn, ms) {
    let t = null;
    const d = function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
    d.cancel = () => clearTimeout(t);
    return d;
  }

  // --- Events ------------------------------------------------------------------------

  const listeners = {};
  IPTV.on = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  IPTV.emit = (type, detail) => {
    (listeners[type] || []).slice().forEach((fn) => {
      try { fn(detail); } catch (e) { console.error('[iptv]', e); }
    });
  };
  // Stable API for the home screen: fn(reason) on a new bootstrap or changed favourites.
  IPTV.onChange = (fn) => IPTV.on('change', fn);

  IPTV.u = { esc, icon, time, clock, duration, minutesLeft, monogram, logo, img, sameId, clamp, debounce, pad };
})(window);
