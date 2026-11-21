/*
 * The home screen — tvOS 26 style.
 *
 *   The dock (favourite apps and inputs) sits at the bottom while you are in it, with the "top shelf" above:
 *   the background image, or for the TV tile a silent preview of the last channel.
 *   Moving down, the page slides up to the rows Channels, Continue watching and All apps, and
 *   the background becomes blurred and dimmed.
 *
 *   Hold OK: menu (dock, move, hide). Back: up to the dock.
 */
(function () {
  'use strict';

  const el = document.querySelector('[data-view="home"]');
  const esc = UI.esc;

  const DOCK_Y = 760;   // the dock's top edge in top shelf mode
  const GRID_Y = 236;   // the focused row's top edge in grid mode
  const COLS = 5;

  el.innerHTML =
    '<div class="home-scrim"></div>' +
    '<header class="home-status"><span class="hs-weather"></span><span class="hs-time tabular"></span></header>' +
    '<div class="home-shelf" id="home-shelf"></div>' +
    '<div class="home-page" id="home-page"></div>';

  const page = el.querySelector('#home-page');
  const shelf = el.querySelector('#home-shelf');
  const statusEl = el.querySelector('.home-status');

  let visible = false;
  let dirty = true;
  let lineTops = [];
  let pageBottom = 0;
  let titles = [];        // headings and notices with their position (to fade them out at the top)
  let currentLine = -1;
  let mode = '';
  let moving = null;          // { kind: 'app'|'channel', id }
  let lastRef = null;
  let focusTimer = null;
  let previewTimer = null;
  let artTimer = null;
  let previewing = null;
  let shelfKey = '';
  let clockTimer = null;
  let epgTimer = null;

  const iptv = () => window.IPTV || null;
  const iptvList = (fn) => {
    try { const v = iptv() && iptv()[fn] ? iptv()[fn]() : []; return Array.isArray(v) ? v : []; } catch (e) { return []; }
  };

  // --- Sections ------------------------------------------------------------------------

  const SECTIONS = {
    channels: { title: tr('home.sections.channels'), render: renderChannels },
    continue: { title: tr('home.continueWatching'), render: renderContinue },
    apps: { title: tr('home.sections.apps'), render: renderApps },
    widgets: { title: tr('home.sections.widgets'), render: renderWidgets }
  };

  function track(inner, edge) {
    return '<div class="shelf-viewport"><div class="shelf-track" data-scroll-track data-scroll-edge="' + (edge || 80) + '" data-remember-focus>' + inner + '</div></div>';
  }

  function renderDock() {
    const dock = Apps.dock();
    const inner = dock.length
      ? dock.map((a) => Tiles.app(a)).join('')
      : Tiles.action('edit-dock', tr('home.chooseApps'), 'plus', { showLabel: true });
    return '<div class="home-dock" data-line>' + track(inner) + '</div>';
  }

  function renderChannels() {
    const I = iptv();
    if (!I) return null;
    const configured = I.configured ? I.configured() : false;
    const favs = iptvList('favorites');
    let inner;
    if (!configured) inner = Tiles.action('setup-iptv', tr('home.setupIptv'), 'tv', { showLabel: true });
    else if (!favs.length) inner = Tiles.action('open-tv', tr('home.chooseFavourites'), 'star', { showLabel: true });
    else inner = favs.map((c) => Tiles.channel(c)).join('');
    return '<div data-line>' + track(inner) + '</div>';
  }

  function renderContinue() {
    const items = iptvList('continueWatching').slice(0, 12);
    if (!items.length) return null;
    return '<div data-line>' + track(items.map((p) => Tiles.card(p)).join('')) + '</div>';
  }

  function renderApps() {
    const st = Apps.state();
    const list = Apps.all();
    let notice = '';
    if (st === 'noroot' || st === 'error') {
      notice = '<p class="home-notice">' + Icons.svg('lock') +
        '<span>' + tr('home.rootNotice') + '</span></p>';
    }
    const tiles = list.map((a) => Tiles.app(a));
    if (st === 'noroot' || st === 'error') tiles.push(Tiles.action('fix-root', tr('home.howToRoot'), 'terminal', { showLabel: true }));
    let rows = '';
    for (let i = 0; i < tiles.length; i += COLS) {
      rows += '<div class="grid-row" data-line data-remember-focus>' + tiles.slice(i, i + COLS).join('') + '</div>';
    }
    return notice + '<div class="home-grid">' + rows + '</div>';
  }

  function renderWidgets() {
    const list = (Store.get('widgets') || []).map((id) => Widgets.get(id)).filter(Boolean);
    if (!list.length) return null;
    return '<div data-line>' + track(list.map((w) => Tiles.widget(w)).join('')) + '</div>';
  }

  function sections() {
    return (Store.get('layout.sections') || []).filter((s) => s.visible && SECTIONS[s.id]);
  }

  // --- Build ------------------------------------------------------------------------------

  function refOf(node) {
    if (!node || !el.contains(node)) return null;
    const sec = node.closest('[data-section]');
    return { kind: node.getAttribute('data-kind'), id: node.getAttribute('data-id'), section: sec ? sec.getAttribute('data-section') : '' };
  }

  function find(ref) {
    if (!ref || ref.id == null) return null;
    const sel = '[data-kind="' + ref.kind + '"][data-id="' + CSS.escape(String(ref.id)) + '"]';
    return page.querySelector('[data-section="' + ref.section + '"] ' + sel) || page.querySelector(sel);
  }

  // The sections as HTML (without touching the DOM). Compared with the previous build so that only what
  // has actually changed is redrawn – an unchanged source (apps, IPTV, settings) does nothing.
  function sectionList() {
    const out = [{ id: 'dock', html: renderDock() }];
    sections().forEach((s) => {
      const body = SECTIONS[s.id].render();
      if (body == null) return;
      out.push({ id: s.id, html: '<h2 class="shelf-title">' + esc(SECTIONS[s.id].title) + '</h2>' + body });
    });
    return out;
  }

  const wrapSection = (x) => x.id === 'dock'
    ? '<div class="home-section is-dock" data-section="dock">' + x.html + '</div>'
    : '<section class="home-section" data-section="' + x.id + '">' + x.html + '</section>';

  let built = []; // [{ id, html }] from the latest build

  // The rows' positions are measured once per (real) change – never when focus moves.
  function measure() {
    const lines = page.querySelectorAll('[data-line]');
    lineTops = [];
    Array.prototype.forEach.call(lines, (l, i) => {
      l.setAttribute('data-line', i);
      let y = 0;
      for (let n = l; n && n !== page; n = n.offsetParent) y += n.offsetTop;
      lineTops.push(y);
    });
    pageBottom = page.lastElementChild ? lineTops[lineTops.length - 1] + (lines[lines.length - 1] || {}).offsetHeight : 0;
    titles = Array.prototype.map.call(page.querySelectorAll('.shelf-title, .home-notice'), (t) => {
      let y = 0;
      for (let n = t; n && n !== page; n = n.offsetParent) y += n.offsetTop;
      return { el: t, top: y };
    });
  }

  function build() {
    const cur = Nav.current();
    const ref = refOf(cur) || lastRef;
    const next = sectionList();
    const sameShape = built.length === next.length && page.children.length === next.length &&
      next.every((x, i) => x.id === built[i].id);
    let changedEls;
    if (sameShape) {
      changedEls = [];
      next.forEach((x, i) => {
        if (x.html === built[i].html) return;
        page.children[i].innerHTML = x.html;
        changedEls.push(page.children[i]);
      });
      built = next;
      dirty = false;
      if (!changedEls.length) return;
    } else {
      page.innerHTML = next.map(wrapSection).join('');
      changedEls = [page];
      built = next;
      dirty = false;
    }

    measure();
    changedEls.forEach((root) => {
      root.querySelectorAll('[data-widget-face]').forEach((f) => Widgets.mount(f, f.getAttribute('data-widget-face')));
    });
    currentLine = -1;

    clearTimeout(artTimer);
    artTimer = setTimeout(() => Tiles.hydrate(page), 60);

    if (visible) {
      // Focus stays if the element is still there; otherwise the same tile in the new version.
      if (!(cur && page.contains(cur))) {
        const target = find(ref) || page.querySelector('[data-focusable]');
        if (target) Nav.focus(target, { force: true });
      }
      if (moving) {
        const m = find(Object.assign({}, ref, moving));
        if (m) m.classList.add('is-moving');
      }
      layout(true);
    }
  }

  // --- Positioning --------------------------------------------------------------------------

  function layout(force) {
    const cur = Nav.current();
    const line = cur && el.contains(cur) ? cur.closest('[data-line]') : page.querySelector('[data-line]');
    if (!line) return;
    const idx = +line.getAttribute('data-line') || 0;
    if (idx === currentLine && !force) return;
    currentLine = idx;
    const m = idx === 0 ? 'shelf' : 'grid';
    let y = m === 'shelf' ? DOCK_Y - (lineTops[0] || 0) : GRID_Y - (lineTops[idx] || 0);
    // Last rows: do not scroll past the end (leave room for the label below).
    if (m === 'grid' && pageBottom) y = Math.max(y, 1080 - 150 - pageBottom);
    page.style.transform = 'translate3d(0,' + Math.round(y) + 'px,0)';
    if (m !== mode) {
      mode = m;
      el.setAttribute('data-mode', m);
      if (window.Wallpaper) Wallpaper.mode(m);
      if (m === 'grid') {
        stopPreview();
        setShelf('', '');
        if (window.Wallpaper) Wallpaper.restore();
      }
    }
    // Rows above the focused one fade out (calmer, and nothing collides with the clock).
    page.querySelectorAll('[data-line]').forEach((l) => {
      const i = +l.getAttribute('data-line');
      l.classList.toggle('is-above', i < idx && lineTops[i] + y < 150);
    });
    titles.forEach((t) => t.el.classList.toggle('is-above', m === 'grid' && t.top + y < 130));
  }

  // --- Top shelf ---------------------------------------------------------------------------

  function setShelf(key, html) {
    if (key === shelfKey) return;
    shelfKey = key;
    shelf.classList.remove('is-in');
    if (!html) { shelf.innerHTML = ''; return; }
    shelf.innerHTML = html;
    requestAnimationFrame(() => shelf.classList.add('is-in'));
  }

  const pct = (p) => (p && p.start && p.end ? Math.max(0, Math.min(100, ((Date.now() - p.start) / (p.end - p.start)) * 100)) : 0);

  function nowNext(ch, cb, tries) {
    const I = iptv();
    if (!I || !I.epg || !I.epg.nowNext || !ch) return;
    let r;
    try { r = I.epg.nowNext(ch); } catch (e) { return; }
    const apply = (v) => {
      if (v && v.pending) {
        if ((tries || 0) < 3) setTimeout(() => nowNext(ch, cb, (tries || 0) + 1), 1500);
        return;
      }
      cb(v || {});
    };
    if (r && typeof r.then === 'function') r.then(apply, () => {});
    else apply(r);
  }

  function shelfForTv() {
    const I = iptv();
    const last = I && I.lastChannel ? I.lastChannel() : null;
    if (!last) {
      setShelf('tv', '');
      return null;
    }
    const key = 'tv:' + last.id;
    setShelf(key,
      '<p class="shelf-kicker">' + tr('home.continueWatching') + '</p>' +
      '<h1 class="shelf-title-big" data-epg-title>' + esc(last.name) + '</h1>' +
      '<p class="shelf-meta" data-epg-meta>' + esc(last.name) + '</p>' +
      '<div class="shelf-progress progress" hidden><i></i></div>');
    nowNext(last, (r) => {
      if (shelfKey !== key || !r.now) return;
      shelf.querySelector('[data-epg-title]').textContent = r.now.title;
      shelf.querySelector('[data-epg-meta]').innerHTML = '<b>' + esc(last.name) + '</b> · ' +
        Clock.hhmm(r.now.start) + '–' + Clock.hhmm(r.now.end) + (r.next ? ' · ' + tr('home.next', { title: esc(r.next.title) }) : '');
      const p = shelf.querySelector('.shelf-progress');
      p.hidden = false;
      p.querySelector('i').style.setProperty('--p', pct(r.now).toFixed(1) + '%');
    });
    return last;
  }

  // Apps with a real 16:9 image (e.g. SVT Play) show it in the top shelf.
  const bgArt = {};
  function appBackdrop(a) {
    if (!a || !a.bgImage || !window.Wallpaper) return;
    const k = a.bgImage;
    if (bgArt[k] === false) return;
    const use = (src) => { if (mode === 'shelf' && shelfKey === 'app:' + a.id) Wallpaper.show(src); };
    if (bgArt[k]) { use(bgArt[k]); return; }
    Root.image(k).then((r) => {
      bgArt[k] = r.size > 150000 ? r.src : false;
      if (bgArt[k]) use(bgArt[k]);
    }, () => { bgArt[k] = false; });
  }

  function updateShelf() {
    if (!visible || mode !== 'shelf') return;
    const cur = Nav.current();
    if (!cur || !el.contains(cur)) return;
    const id = cur.getAttribute('data-id');
    clearTimeout(previewTimer);
    if (id === 'internal:tv') {
      if (window.Wallpaper) Wallpaper.restore();
      const ch = shelfForTv();
      if (ch && Store.get('iptv.homePreview') !== false) previewTimer = setTimeout(() => startPreview(ch), 900);
      return;
    }
    stopPreview();
    setShelf('app:' + id, '');
    const a = Apps.get(id);
    if (a && a.bgImage) previewTimer = setTimeout(() => appBackdrop(a), 700);
    else if (window.Wallpaper) Wallpaper.restore();
  }

  function startPreview(ch) {
    const I = iptv();
    if (!visible || mode !== 'shelf' || !I || !I.preview) return;
    if (previewing && String(previewing.id) === String(ch.id)) return;
    previewing = ch;
    el.classList.add('has-preview');
    try { I.preview.start(ch); } catch (e) { console.warn(e); }
  }

  function stopPreview() {
    clearTimeout(previewTimer);
    if (!previewing) return;
    previewing = null;
    el.classList.remove('has-preview');
    try { const I = iptv(); if (I && I.preview) I.preview.stop(); } catch (e) { console.warn(e); }
  }

  // --- Channel info below the focused channel -------------------------------------------------

  function channelById(id) {
    return iptvList('favorites').filter((c) => String(c.id) === String(id))[0] || null;
  }

  function fillChannel(tile) {
    const ch = channelById(tile.getAttribute('data-id'));
    if (!ch) return;
    nowNext(ch, (r) => {
      const now = r.now;
      tile.querySelector('.ch-now').textContent = now ? now.title : '';
      const bar = tile.querySelector('.ch-progress');
      bar.classList.toggle('is-on', !!now);
      if (now) bar.querySelector('i').style.width = pct(now).toFixed(1) + '%';
    });
  }

  // --- Status (clock + weather) -----------------------------------------------------------------

  function updateStatus() {
    statusEl.querySelector('.hs-time').textContent = Clock.time();
    const w = Store.get('layout.statusWeather') !== false && window.Weather && Weather.current();
    statusEl.querySelector('.hs-weather').innerHTML = w ? Icons.svg(w.icon) + '<span>' + w.temp + '°</span>' : '';
  }

  function startClock() {
    updateStatus();
    clearTimeout(clockTimer);
    // Update exactly on the minute.
    const tick = () => {
      updateStatus();
      clockTimer = setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
    };
    clockTimer = setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  }

  // --- Focus and keys --------------------------------------------------------------------------

  // The same lift as .tile.is-focused, with a short twist in the direction of movement.
  const LIFT = 'translate3d(0, -4px, 0) scale(1.1) perspective(900px) ';
  const swayFrames = (deg) => [{ transform: LIFT + 'rotateY(' + deg + 'deg)' }, { transform: LIFT + 'rotateY(0deg)' }];

  el.addEventListener('nav:focus', (e) => {
    if (!visible) return;
    const t = e.target;
    layout();
    // Sway in the direction of movement (horizontal only, tiles only).
    const dir = e.detail && e.detail.dir;
    if ((dir === 'left' || dir === 'right') && t.classList.contains('tile') && !moving && t.animate) {
      // Web Animations: no class to restart (= no forced layout per key press).
      if (t._sway) t._sway.cancel();
      t._sway = t.animate(swayFrames(dir === 'left' ? -5 : 5), { duration: 420, easing: Nav.ease });
    }
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      updateShelf();
      if (t.classList.contains('tile-channel')) fillChannel(t);
    }, 140);
  });

  function activate(t) {
    const kind = t.getAttribute('data-kind');
    const id = t.getAttribute('data-id');
    const I = iptv();
    if (kind === 'app') {
      if (id === 'internal:tv' && I && I.open) {
        // The top shelf says "Continue watching": open the last channel (the preview is handed over without
        // being stopped if it has had time to start). Back then leads to the TV app's tabs.
        const ch = previewing || (mode === 'shelf' && I.lastChannel ? I.lastChannel() : null);
        previewing = null;
        el.classList.remove('has-preview');
        I.open(ch ? { tab: 'live', channel: ch } : { tab: 'live' });
        return;
      }
      Apps.launch(id).catch((err) => UI.toast(tr('home.launchFailed', {
        name: (Apps.get(id) || {}).title || id,
        error: err.code === 'NOT_ROOT' ? tr('home.notRoot') : err.message
      }), 5000));
    } else if (kind === 'channel') {
      const ch = channelById(id);
      if (ch && I && I.open) I.open({ tab: 'live', channel: ch, fullscreen: true });
    } else if (kind === 'continue') {
      const p = iptvList('continueWatching').filter((x) => String(x.id) === String(id))[0];
      if (p && I && I.openItem) I.openItem(p);
    } else if (kind === 'widget') {
      const w = Widgets.get(id);
      if (w && w.activate) w.activate();
    } else if (kind === 'action') {
      if (id === 'edit-dock') Router.go('settings', { section: 'dock' });
      else if (id === 'setup-iptv') Router.go('settings', { section: 'iptv-source' });
      else if (id === 'fix-root') Router.go('settings', { section: 'root' });
      else if (id === 'open-tv' && I && I.open) I.open({ tab: 'live' });
    }
  }

  el.addEventListener('nav:activate', (e) => {
    if (moving) return;
    activate(e.target);
  });

  el.addEventListener('nav:longpress', (e) => {
    const t = e.target;
    const kind = t.getAttribute('data-kind');
    const id = t.getAttribute('data-id');
    const secEl = t.closest('[data-section]');
    const sec = secEl ? secEl.getAttribute('data-section') : '';
    if (kind === 'app') {
      const a = Apps.get(id) || { title: id };
      const inDock = (Store.get('favorites.apps') || []).indexOf(id) >= 0;
      UI.menu({
        title: a.title,
        subtitle: a.subtitle || '',
        items: [
          { label: tr('home.open'), action: () => activate(t) },
          sec === 'dock' && { label: tr('home.move'), action: () => startMove('app', id) },
          inDock
            ? { label: tr('home.removeFromDock'), action: () => { toggleDock(id); UI.toast(tr('home.removedFromDock', { name: a.title })); } }
            : { label: tr('home.addToDock'), action: () => { toggleDock(id); UI.toast(tr('home.addedToDock', { name: a.title })); } },
          a.kind !== 'internal' && { label: tr('home.hide'), danger: true, action: () => hideApp(id) },
          { label: tr('home.editDock'), action: () => Router.go('settings', { section: 'dock' }) }
        ]
      });
    } else if (kind === 'channel') {
      const ch = channelById(id);
      const I = iptv();
      if (!ch || !I) return;
      UI.menu({
        title: ch.name,
        items: [
          { label: tr('home.watch'), action: () => activate(t) },
          I.moveFavorite && { label: tr('home.move'), action: () => startMove('channel', id) },
          I.toggleFavorite && { label: tr('home.removeFavourite'), danger: true, action: () => Promise.resolve(I.toggleFavorite(ch)).catch((err) => UI.toast(err.message)) }
        ]
      });
    } else if (kind === 'continue') {
      UI.menu({ title: tr('home.continueWatching'), items: [{ label: tr('home.play'), action: () => activate(t) }] });
    }
  });

  function toggleDock(id) {
    const list = (Store.get('favorites.apps') || []).slice();
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.push(id);
    Store.set('favorites.apps', list);
  }

  function hideApp(id) {
    const a = Apps.get(id) || { title: id };
    Store.set('hiddenApps', (Store.get('hiddenApps') || []).filter((x) => x !== id).concat([id]));
    Store.set('favorites.apps', (Store.get('favorites.apps') || []).filter((x) => x !== id));
    UI.toast(tr('home.hidden', { name: a.title }));
  }

  function startMove(kind, id) {
    moving = { kind, id };
    const t = find(Object.assign(refOf(Nav.current()) || {}, { kind, id }));
    if (t) t.classList.add('is-moving');
    UI.toast(tr('home.moveHint'), 4000);
  }

  function stopMove() {
    page.querySelectorAll('.is-moving').forEach((t) => t.classList.remove('is-moving'));
    moving = null;
  }

  function moveBy(delta) {
    const { kind, id } = moving;
    let ok = false;
    if (kind === 'app') {
      const list = (Store.get('favorites.apps') || []).slice();
      // Skip favourites that do not exist on the TV.
      const present = list.filter((x) => Apps.get(x));
      const pi = present.indexOf(id);
      const pj = pi + delta;
      if (pi >= 0 && pj >= 0 && pj < present.length) {
        const other = present[pj];
        const i = list.indexOf(id);
        const j = list.indexOf(other);
        list[i] = other;
        list[j] = id;
        Store.set('favorites.apps', list);
        ok = true;
      }
    } else if (kind === 'channel') {
      const I = iptv();
      if (I && I.moveFavorite) {
        const favs = iptvList('favorites');
        const i = favs.findIndex((c) => String(c.id) === String(id));
        if (i + delta >= 0 && i + delta < favs.length) {
          Promise.resolve(I.moveFavorite(id, delta)).catch(() => {});
          ok = true;
        }
      }
    }
    if (!ok) Nav.bump(Nav.current(), delta < 0 ? 'left' : 'right');
  }

  // --- Changes from outside --------------------------------------------------------------------

  let rebuildTimer = null;
  function scheduleBuild() {
    dirty = true;
    if (!visible) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(build, 40);
  }

  Store.on((path) => {
    if (path === '*' || /^(favorites|layout\.sections|hiddenApps|widgets)/.test(path)) scheduleBuild();
    if (path === 'layout.statusWeather') updateStatus();
  });
  Apps.onChange(scheduleBuild);
  if (window.Weather) Weather.on(updateStatus);

  // IPTV loads in parallel – hook in once the module exists.
  function hookIptv() {
    const I = iptv();
    if (!I) return;
    if (I.onChange) I.onChange(() => scheduleBuild());
    if (I.ready && I.ready.then) I.ready.then(scheduleBuild, scheduleBuild);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hookIptv);
  else setTimeout(hookIptv, 0);

  // --- The view -----------------------------------------------------------------------------------

  function onShow() {
    visible = true;
    if (window.Wallpaper) Wallpaper.mode(mode || 'shelf');
    if (dirty) build();
    else if (lastRef && !refOf(Nav.current())) {
      const t = find(lastRef);
      if (t) Nav.focus(t, { force: true });
    }
    startClock();
    clearInterval(epgTimer);
    epgTimer = setInterval(() => {
      const cur = Nav.current();
      if (cur && cur.classList.contains('tile-channel')) fillChannel(cur);
    }, 60000);
    requestAnimationFrame(() => {
      layout(true);
      shelfKey = '';
      updateShelf();
    });
  }

  Router.register('home', {
    el,
    show: onShow,
    resume: onShow,
    hide() {
      lastRef = refOf(Nav.current());
      visible = false;
      stopMove();
      stopPreview();
      clearTimeout(clockTimer);
      clearInterval(epgTimer);
      if (window.Wallpaper) Wallpaper.restore();
    },
    onKey(name, e) {
      if (moving) {
        if (name === 'enter' && e && e.repeat) return true; // OK is still held down after the long press
        if (name === 'left' || name === 'right') moveBy(name === 'left' ? -1 : 1);
        else if (name === 'enter' || name === 'back') stopMove();
        return true;
      }
      if (name === 'back') {
        // Back: up to the dock (the home screen is the TV's home – nothing to go back to).
        if (mode === 'grid') {
          const first = page.querySelector('.home-dock [data-last-focus]') || page.querySelector('.home-dock [data-focusable]');
          if (first) Nav.focus(first);
        }
        return true;
      }
      // Blue button: jump to All apps.
      if (name === 'blue') {
        const grid = page.querySelector('[data-section="apps"] [data-focusable]');
        if (grid) Nav.focus(grid);
        return true;
      }
      return false;
    }
  });

  // Jump to All apps from other parts (e.g. an old "internal:apps").
  window.Home = {
    showAllApps() {
      Router.home();
      setTimeout(() => {
        const grid = page.querySelector('[data-section="apps"] [data-focusable]');
        if (grid) Nav.focus(grid);
      }, 60);
    }
  };
})();
