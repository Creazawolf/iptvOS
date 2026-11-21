/*
 * Tiles — tiles for the home screen: apps/inputs, channels, "Continue watching" cards and widgets.
 *
 *   Tiles.app(app)        Tiles.channel(ch)      Tiles.card(progressItem)
 *   Tiles.action(id, title, glyph, opts)          Tiles.widget(def)
 *   Tiles.hydrate(root)   fetches icons missing from the cache and fills in the tiles
 *
 * Structure (see base.css):  .tile > .lift-shadow + .tile-face(… + .shine) + .tile-label
 */
(function (global) {
  'use strict';

  const esc = (s) => UI.esc(s);
  // Images via the hub's image cache at the right size (otherwise the original comes, often much larger).
  const sized = (url, w) => (url && global.IPTV && IPTV.u && IPTV.u.img ? IPTV.u.img(url, w) : url);

  function shell(cls, attrs, style, faceHtml, label) {
    return (
      '<button class="' + cls + '" data-focusable ' + attrs + (style ? ' style="' + style + '"' : '') + '>' +
      '<span class="lift-shadow"></span>' +
      '<span class="tile-face">' + faceHtml + '<i class="shine"></i></span>' +
      (label != null ? '<span class="tile-label">' + label + '</span>' : '') +
      '</button>'
    );
  }

  function app(a) {
    const art = Art.get(a);
    const f = Art.face(a, art);
    return shell(
      'tile tile-app' + (f.dim ? ' is-dim' : '') + (art ? '' : ' needs-art'),
      'data-kind="app" data-id="' + esc(a.id) + '"',
      f.style,
      f.html,
      esc(a.title)
    );
  }

  function channel(ch) {
    const logo = ch.logo
      ? '<img class="ch-logo" src="' + esc(sized(ch.logo, 320)) + '" alt="" decoding="async" data-fallback="' + esc(ch.name) + '">'
      : '<span class="ch-name">' + esc(ch.name) + '</span>';
    return shell(
      'tile tile-channel',
      'data-kind="channel" data-id="' + esc(ch.id) + '"',
      '',
      logo + (ch.num ? '<span class="ch-num tabular">' + esc(ch.num) + '</span>' : '') +
        '<span class="ch-progress"><i></i></span>',
      '<b>' + esc(ch.name) + '</b><span class="ch-now"></span>'
    );
  }

  // "Continue watching": background image, title and how far the user has got.
  function card(p) {
    const pct = p.duration ? Math.max(2, Math.min(100, (p.position / p.duration) * 100)) : 0;
    const img = sized(p.backdrop || p.still || p.poster || '', 480);
    const left = p.duration ? Math.max(1, Math.round((p.duration - p.position) / 60)) : 0;
    return (
      '<button class="card card-continue" data-focusable data-kind="continue" data-id="' + esc(p.id) + '">' +
      '<span class="lift-shadow"></span>' +
      '<span class="tile-face">' +
      (img ? '<img class="tile-art" src="' + esc(img) + '" alt="" decoding="async">' : '<span class="tile-name">' + esc(p.title) + '</span>') +
      '<span class="card-scrim"></span>' +
      '<span class="card-text"><b>' + esc(p.title) + '</b>' + (p.subtitle ? '<span>' + esc(p.subtitle) + '</span>' : '') + '</span>' +
      '<span class="card-progress"><i style="width:' + pct.toFixed(1) + '%"></i></span>' +
      '<i class="shine"></i></span>' +
      '<span class="tile-label">' + (left ? tr('tiles.minutesLeft', { n: left }) : tr('tiles.continueWatching')) + '</span>' +
      '</button>'
    );
  }

  function action(id, title, glyph, opts) {
    opts = opts || {};
    return shell(
      'tile tile-action' + (opts.showLabel ? ' show-label' : ''),
      'data-kind="action" data-id="' + esc(id) + '"',
      '',
      '<span class="tile-glyph">' + Icons.svg(glyph) + '</span>' + (opts.text ? '<span class="tile-action-text">' + esc(opts.text) + '</span>' : ''),
      esc(title)
    );
  }

  function widget(def) {
    return (
      '<button class="tile tile-widget size-' + (def.size || 1) + '" data-focusable data-kind="widget" data-id="' + esc(def.id) + '">' +
      '<span class="lift-shadow"></span>' +
      '<span class="tile-face" data-widget-face="' + esc(def.id) + '"></span>' +
      '<span class="tile-label">' + esc(def.title) + '</span>' +
      '</button>'
    );
  }

  // Fill in icons that were not in the cache (fetched via the service, at most four at a time).
  function hydrate(root) {
    const tiles = root.querySelectorAll('.tile-app.needs-art');
    const seen = {};
    Array.prototype.forEach.call(tiles, (t) => {
      const id = t.getAttribute('data-id');
      if (seen[id]) return;
      seen[id] = true;
      const a = Apps.get(id);
      if (!a) return;
      Art.load(a).then((art) => {
        const f = Art.face(a, art);
        root.querySelectorAll('.tile-app.needs-art[data-id="' + CSS.escape(id) + '"]').forEach((el) => {
          el.classList.remove('needs-art');
          el.setAttribute('style', f.style);
          el.classList.toggle('is-dim', f.dim);
          el.querySelector('.tile-face').innerHTML = f.html + '<i class="shine"></i>';
        });
      });
    });
  }

  // Broken channel logos → the name instead.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    if (img.classList.contains('ch-logo')) {
      img.outerHTML = '<span class="ch-name">' + esc(img.getAttribute('data-fallback') || '') + '</span>';
    } else if (img.classList.contains('tile-art')) {
      img.remove();
    }
  }, true);

  global.Tiles = { app, channel, card, action, widget, hydrate, palette: (c) => Art.palette(c) };
})(window);
