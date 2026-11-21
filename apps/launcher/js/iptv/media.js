/*
 * Movies and Series — like the TV app on Apple TV: a large background image with the title of what has
 * focus, and shelves (Continue watching, Recently added, one per visible category) that load as
 * they approach the screen. The detail page shows the plot, the cast and – for series –
 * seasons and episodes.
 *
 *   IPTV.media.openDetail(kind, item, opts)   kind: 'vod' | 'series'
 *   IPTV.media.resume(progress, opts)          continue watching (from the home screen or the shelf)
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const u = IPTV.u;
  const esc = u.esc;
  const src = () => IPTV.source;

  const PAGE = 30;
  const SHELF_TOP = 600;     // position of the first shelf while the hero is visible
  const SHELF_FOCUS_Y = 168; // the focused shelf ends up here once you have scrolled down
  const INFO_DWELL = 650;

  // --- Shared: info cache ----------------------------------------------------------------

  const infoCache = {};
  const infoOrder = [];
  function info(kind, id) {
    const key = kind + '|' + id;
    if (infoCache[key]) return infoCache[key];
    const p = (kind === 'vod' ? src().vodInfo(id) : src().seriesInfo(id)).catch((e) => {
      delete infoCache[key];
      throw e;
    });
    infoCache[key] = p;
    infoOrder.push(key);
    if (infoOrder.length > 120) delete infoCache[infoOrder.shift()];
    return p;
  }

  function metaLine(it, extra) {
    const parts = [];
    if (it.year) parts.push(String(it.year));
    if (it.rating) parts.push('<span class="md-star">' + u.icon('star-fill') + '</span>' + (Math.round(it.rating * 10) / 10));
    if (it.duration) parts.push(u.duration(it.duration));
    if (extra) parts.push(extra);
    if (it.genre) parts.push(esc(String(it.genre).split(/\s*[,/]\s*/).slice(0, 2).join(', ')));
    return parts.join('<span class="md-dot">·</span>');
  }

  function posterHtml(it, kind, i) {
    const img = it.poster ? '<img src="' + esc(src().img(it.poster, 320)) + '" data-orig="' + esc(it.poster) + '" alt="" loading="lazy" decoding="async" data-hide-broken>' : '';
    const fav = IPTV.isMediaFavorite && IPTV.isMediaFavorite(kind === 'vod' ? 'vod' : 'series', it.id);
    return '<button class="poster' + (fav ? ' is-fav' : '') + '" data-focusable data-i="' + i + '" data-id="' + esc(it.id) + '">' +
      '<div class="lift-shadow"></div>' +
      '<div class="poster-face">' +
        '<span class="poster-fallback">' + esc(it.title) + '</span>' + img +
        '<i class="poster-star">★</i>' +
        '<i class="shine"></i>' +
      '</div>' +
      '<span class="poster-label">' + esc(it.title) + '</span>' +
    '</button>';
  }

  function progressCard(p, i) {
    const pic = p.backdrop || p.still || p.poster;
    const pct = p.duration ? Math.round((p.position / p.duration) * 100) : 0;
    const left = p.duration ? tr('media.minutesLeft', { n: Math.max(1, Math.round((p.duration - p.position) / 60)) }) : '';
    const title = p.kind === 'episode' && p.seriesTitle ? p.seriesTitle : p.title;
    const sub = p.kind === 'episode' && p.season ? tr('media.seasonEpisodeShort', { season: p.season, episode: p.episode }) + (p.title && p.seriesTitle ? ' · ' + p.title : '') : left;
    return '<button class="card md-card" data-focusable data-i="' + i + '" data-id="' + esc(p.id) + '">' +
      '<div class="lift-shadow"></div>' +
      '<div class="card-face">' +
        '<span class="poster-fallback">' + esc(title) + '</span>' +
        (pic ? '<img src="' + esc(src().img(pic, 480)) + '" data-orig="' + esc(pic) + '" alt="" loading="lazy" decoding="async" data-hide-broken>' : '') +
        '<span class="md-card-shade"></span>' +
        '<span class="md-card-play">' + u.icon('play') + '</span>' +
        '<span class="progress md-card-progress"><i style="--p:' + pct + '%"></i></span>' +
        '<i class="shine"></i>' +
      '</div>' +
      '<span class="card-label"><b>' + esc(title) + '</b><small>' + esc(sub || left) + '</small></span>' +
    '</button>';
  }

  // --- Browsing (one per tab) ---------------------------------------------------------------

  function browser(kind) {
    const tabName = kind === 'vod' ? 'movies' : 'series';
    const root = IPTV.ui.el.querySelector('[data-pane="' + tabName + '"]');
    const L = kind === 'vod'
      ? { none: tr('media.movies.none'), noneHere: tr('media.movies.noneHere'), providerNone: tr('media.movies.providerNone'), loadFailed: tr('media.movies.loadFailed') }
      : { none: tr('media.series.none'), noneHere: tr('media.series.noneHere'), providerNone: tr('media.series.providerNone'), loadFailed: tr('media.series.loadFailed') };
    root.innerHTML =
      '<div class="md-hero">' +
        '<div class="md-bd"></div><div class="md-bd"></div>' +
        '<div class="md-hero-shade"></div>' +
        '<div class="md-hero-info">' +
          '<p class="md-hero-kicker"></p>' +
          '<h1 class="md-hero-title"></h1>' +
          '<p class="md-hero-meta"></p>' +
          '<p class="md-hero-plot"></p>' +
        '</div>' +
      '</div>' +
      '<div class="md-page"><div class="md-track"></div></div>' +
      '<div class="md-topfade"></div>' +
      '<div class="md-message" hidden></div>';

    const q = (sel) => root.querySelector(sel);
    const track = q('.md-track');
    const bds = root.querySelectorAll('.md-bd');

    // shelf: { id, title, kind: 'continue'|'recent'|'cat', items, total, loading, el, loaded }
    let shelves = [];
    let built = false;
    let builtSig = '';
    let shown = false;
    let shelfIndex = 0;
    let heroItem = null;
    let heroTimer = null;
    let infoTimer = null;
    let bdIndex = 0;
    let bdUrl = '';

    function message(kindOf, text) {
      const box = q('.md-message');
      root.classList.add('has-message');
      box.hidden = false;
      if (kindOf === 'loading') box.innerHTML = '<div class="spinner"></div>';
      else if (kindOf === 'setup') box.innerHTML = '<div class="tv-msg-icon">' + u.icon(kind === 'vod' ? 'film' : 'series') + '</div><h2 class="tv-msg-title">' + tr('media.setupTitle') + '</h2><p class="tv-msg-text">' + tr('media.setupText') + '</p><div class="tv-msg-actions"><button class="btn" data-focusable data-act="settings">' + u.icon('gear') + '<span>' + tr('media.openSettings') + '</span></button></div>';
      else if (kindOf === 'empty') box.innerHTML = '<div class="tv-msg-icon">' + u.icon(kind === 'vod' ? 'film' : 'series') + '</div><h2 class="tv-msg-title">' + L.none + '</h2><p class="tv-msg-text">' + (IPTV.mode() === 'hub' ? tr('media.pickCategories', { url: esc(IPTV.hubUrl()) + '/' }) : L.providerNone) + '</p>';
      else box.innerHTML = '<div class="tv-msg-icon is-error">' + u.icon('signal') + '</div><h2 class="tv-msg-title">' + L.loadFailed + '</h2><p class="tv-msg-text">' + esc(text || '') + '</p><div class="tv-msg-actions"><button class="btn" data-focusable data-act="retry">' + u.icon('refresh') + '<span>' + tr('common.retry') + '</span></button></div>';
    }

    function hideMessage() {
      q('.md-message').hidden = true;
      root.classList.remove('has-message');
    }

    function continueItems() {
      return IPTV.continueWatching().filter((p) => (kind === 'vod' ? p.kind === 'vod' : p.kind === 'episode'));
    }

    const favKind = kind === 'vod' ? 'vod' : 'series';
    const favItems = () => (IPTV.mediaFavorites ? IPTV.mediaFavorites(favKind) : []);

    function build() {
      const cats = IPTV.categories(kind);
      const list = [];
      const cont = continueItems();
      const favs = favItems();
      if (favs.length) list.push({ id: 'favorites', title: tr('media.favourites'), kind: 'favorites', items: favs, total: favs.length, loaded: true });
      if (cont.length) list.push({ id: 'continue', title: tr('media.continueWatching'), kind: 'continue', items: cont, total: cont.length, loaded: true });
      if (cats.length) list.push({ id: 'recent', title: tr('media.recentlyAdded'), kind: 'recent', items: [], total: null });
      cats.forEach((c) => list.push({ id: String(c.id), title: c.name, kind: 'cat', items: [], total: c.count != null ? c.count : null }));
      shelves = list;
      track.innerHTML = shelves.map((s, i) =>
        // ◀ ▶ stays within the shelf (▲ ▼ are handled by onKey) – so shelves off screen are never measured.
        '<section class="md-shelf' + (s.kind === 'continue' ? ' is-cards' : '') + '" data-si="' + i + '" data-nav-lock="left right">' +
          '<h2 class="shelf-title">' + esc(s.title) + '</h2>' +
          '<div class="shelf-viewport"><div class="shelf-track" data-scroll-track data-scroll-edge="120" data-remember-focus>' +
            (s.kind === 'continue' ? s.items.map(progressCard).join('') : s.kind === 'favorites' ? s.items.map((it, n) => posterHtml(it, kind, n)).join('') : skeleton()) +
          '</div></div>' +
        '</section>'
      ).join('');
      shelves.forEach((s, i) => { s.el = track.children[i]; });
      built = true;
      builtSig = sigOf();
      shelfIndex = 0;
      scrollTo(0, true);
      for (let i = 0; i < Math.min(3, shelves.length); i++) loadShelf(i);
    }

    function skeleton() {
      let h = '';
      for (let i = 0; i < 7; i++) h += '<span class="poster is-skeleton"><span class="poster-face"></span></span>';
      return h;
    }

    function loadShelf(i, more) {
      const s = shelves[i];
      if (!s || s.loading || s.kind === 'continue' || s.kind === 'favorites') return;
      if (s.loaded && !more) return;
      if (more && s.total != null && s.items.length >= s.total) return;
      s.loading = true;
      const offset = more ? s.items.length : 0;
      const fn = kind === 'vod' ? src().vodList : src().seriesList;
      fn({ category: s.kind === 'recent' ? 'recent' : s.id, offset, limit: PAGE, sort: s.kind === 'recent' ? 'added' : undefined })
        .then((r) => {
          s.loading = false;
          const items = (r && r.items) || [];
          s.total = r && r.total != null ? r.total : s.total;
          const t = s.el.querySelector('.shelf-track');
          if (!more) {
            s.items = items;
            s.loaded = true;
            if (!items.length) {
              s.el.classList.add('is-empty');
              t.innerHTML = '<p class="md-shelf-empty">' + L.noneHere + '</p>';
              return;
            }
            t.innerHTML = items.map((it, n) => posterHtml(it, kind, n)).join('');
            if (i === shelfIndex && Nav.current() && Nav.current().classList.contains('is-skeleton')) focusShelf(i);
            if (i === 0 && !heroItem) setHero(items[0]);
          } else {
            const start = s.items.length;
            s.items = s.items.concat(items);
            t.insertAdjacentHTML('beforeend', items.map((it, n) => posterHtml(it, kind, start + n)).join(''));
          }
        })
        .catch((err) => {
          s.loading = false;
          if (!more) {
            s.el.querySelector('.shelf-track').innerHTML = '<p class="md-shelf-empty">' + tr('media.loadFailedDetail', { error: esc(err.message) }) + '</p>';
          }
        });
    }

    // --- Vertical scrolling (our own, so that the hero shows at the first shelf)

    function scrollTo(i, instant) {
      const s = shelves[i];
      let y = 0;
      if (s && i > 0) y = -(SHELF_TOP + s.el.offsetTop - SHELF_FOCUS_Y);
      root.classList.toggle('is-scrolled', i > 0);
      track.style.transition = instant ? 'none' : '';
      track.style.transform = 'translate3d(0,' + (SHELF_TOP + y) + 'px,0)';
      if (instant) void track.offsetHeight;
    }

    function focusShelf(i) {
      const s = shelves[i];
      if (!s) return null;
      const t = s.el.querySelector('.shelf-track');
      const target = t.querySelector('[data-last-focus]') || t.querySelector('[data-focusable]');
      if (target) Nav.focus(target, { force: true });
      return target;
    }

    // --- The hero (background + title for what has focus)

    function setBackdrop(url) {
      if (url === bdUrl) return;
      bdUrl = url;
      const apply = () => {
        if (bdUrl !== url) return;
        const next = bds[bdIndex ^ 1];
        next.style.backgroundImage = url ? 'url("' + url.replace(/"/g, '%22') + '")' : 'none';
        next.classList.add('is-on');
        bds[bdIndex].classList.remove('is-on');
        bdIndex ^= 1;
      };
      if (!url) { apply(); return; }
      const img = new Image();
      // Decode before the cross-fade, so that it does not stutter on the TV.
      img.onload = () => (img.decode ? img.decode().then(apply, apply) : apply());
      img.onerror = () => {
        if (bdUrl === url) { bdUrl = ''; setBackdrop(''); }
      };
      img.src = url;
    }

    function setHero(it, full) {
      heroItem = it;
      if (!it) return;
      const isProgress = it.position != null;
      const title = isProgress && it.kind === 'episode' && it.seriesTitle ? it.seriesTitle : it.title;
      q('.md-hero-kicker').textContent = isProgress ? tr('media.continueWatching') : '';
      q('.md-hero-title').textContent = title || '';
      q('.md-hero-title').classList.toggle('is-long', String(title || '').length > 28);
      q('.md-hero-meta').innerHTML = isProgress
        ? (it.kind === 'episode' && it.season ? tr('media.seasonEpisode', { season: it.season, episode: it.episode }) + (it.title ? ' · ' + esc(it.title) : '') : (it.duration ? tr('media.minutesLeft', { n: Math.max(1, Math.round((it.duration - it.position) / 60)) }) : ''))
        : metaLine(full || it);
      q('.md-hero-plot').textContent = (full && full.plot) || '';
      const pic = (full && full.backdrop) || it.backdrop || it.still || '';
      const fallback = (full && full.poster) || it.poster || '';
      root.classList.toggle('is-poster-bg', !pic && !!fallback);
      setBackdrop(pic ? src().img(pic, 1280) : fallback ? src().img(fallback, 640) : '');
    }

    function itemAt(el) {
      const sh = el.closest('.md-shelf');
      if (!sh) return null;
      const s = shelves[+sh.getAttribute('data-si')];
      return s ? s.items[+el.getAttribute('data-i')] : null;
    }

    root.addEventListener('nav:focus', (e) => {
      const t = e.target;
      const sh = t.closest('.md-shelf');
      if (!sh) return;
      const si = +sh.getAttribute('data-si');
      if (si !== shelfIndex) {
        shelfIndex = si;
        scrollTo(si);
        for (let k = si; k <= si + 2; k++) loadShelf(k);
      }
      const s = shelves[si];
      const idx = +t.getAttribute('data-i');
      if (s && s.items.length - idx < 8) loadShelf(si, true);
      const it = itemAt(t);
      clearTimeout(heroTimer);
      clearTimeout(infoTimer);
      if (!it) return;
      heroTimer = setTimeout(() => setHero(it), 140);
      // The plot and background come from the info page – fetch them once focus has rested for a while.
      if (it.position == null) {
        infoTimer = setTimeout(() => {
          info(kind, it.id).then((full) => { if (heroItem === it) setHero(it, full); }, () => {});
        }, INFO_DWELL);
      }
    });

    root.addEventListener('nav:activate', (e) => {
      const t = e.target;
      const act = t.getAttribute('data-act');
      if (act === 'settings') { Router.go('settings', { section: 'iptv-source' }); return; }
      if (act === 'retry') { IPTV.reload(); message('loading'); return; }
      const it = itemAt(t);
      if (!it) return;
      if (it.position != null) resume(it);
      else detail.open(kind, it);
    });

    function toggleFav(it) {
      if (!it) return;
      const was = IPTV.isMediaFavorite(favKind, it.id);
      IPTV.toggleMediaFavorite(favKind, it);
      UI.toast(was ? tr('media.favRemoved', { name: it.title }) : tr('media.favAdded', { name: it.title }));
    }

    root.addEventListener('nav:longpress', (e) => {
      const it = itemAt(e.target);
      if (!it) return;
      if (it.position == null) {
        const fav = IPTV.isMediaFavorite(favKind, it.id);
        UI.menu({
          title: it.title,
          subtitle: it.year ? String(it.year) : '',
          items: [
            { label: tr('media.showDetails'), action: () => detail.open(kind, it) },
            { label: fav ? tr('media.removeFavourite') : tr('media.addFavourite'), action: () => toggleFav(it) }
          ]
        });
        return;
      }
      UI.menu({
        title: it.kind === 'episode' && it.seriesTitle ? it.seriesTitle : it.title,
        items: [
          { label: tr('media.continueWatching'), action: () => resume(it) },
          { label: tr('media.showDetails'), action: () => detail.open(kind, it.kind === 'episode' && it.seriesId ? { id: it.seriesId, title: it.seriesTitle } : it) },
          { label: tr('media.removeFromContinue'), danger: true, action: () => IPTV.saveProgress(Object.assign({}, it, { position: it.duration || 1, duration: it.duration || 1 }), { final: true }) }
        ]
      });
    });

    function show() {
      shown = true;
      if (!IPTV.configured()) { message('setup'); return; }
      const st = IPTV.status();
      const cats = IPTV.categories(kind);
      if (!cats.length && !continueItems().length) {
        if (st.state === 'loading' || st.state === 'idle') {
          message('loading'); // redrawn via IPTV.onChange / the status event
          return;
        }
        if (st.state === 'error') { message('error', st.error && st.error.message); return; }
        message('empty');
        return;
      }
      hideMessage();
      if (!built) build();
    }

    function enter() {
      if (root.classList.contains('has-message')) return q('.md-message [data-focusable]');
      if (!built) return null;
      return focusShelf(shelfIndex) || null;
    }

    function onKey(name) {
      const cur = Nav.current();
      if (!cur || !root.contains(cur)) return false;
      const sh = cur.closest('.md-shelf');
      if (!sh) return false;
      if (name === 'yellow') {
        const it = itemAt(cur);
        if (it && it.position == null) toggleFav(it);
        return true;
      }
      const si = +sh.getAttribute('data-si');
      if (name === 'up' && si === 0) { IPTV.ui.focusTabs(); return true; }
      if (name === 'up' || name === 'down') {
        const j = si + (name === 'up' ? -1 : 1);
        if (j < 0 || j >= shelves.length) return true;
        // Skip empty shelves.
        let k = j;
        while (shelves[k] && shelves[k].el.classList.contains('is-empty')) k += name === 'up' ? -1 : 1;
        if (!shelves[k]) return true;
        loadShelf(k);
        focusShelf(k);
        return true;
      }
      if (name === 'back' && si > 0) {
        focusShelf(0);
        return true;
      }
      return false;
    }

    // New categories/Continue watching from the source. Only rebuild when the categories have changed –
    // otherwise Continue watching is updated in place, so that you do not lose your place.
    const sigOf = () => IPTV.categories(kind).map((c) => c.id).join('|');

    // Continue watching and Favourites are updated in place (so that you do not lose your place),
    // but the shelf is added/removed by rebuilding.
    function updateShelf(shelfKind, items, render) {
      const i = shelves.findIndex((x) => x.kind === shelfKind);
      if ((i >= 0) !== !!items.length) return false;
      if (i < 0) return true;
      const sh = shelves[i];
      sh.items = items;
      sh.total = items.length;
      const t = sh.el.querySelector('.shelf-track');
      const focusIn = Nav.current() && t.contains(Nav.current());
      t.innerHTML = items.map(render).join('');
      t.dataset.offset = '0';
      t.style.transform = '';
      if (focusIn) focusShelf(i);
      return true;
    }

    function updateContinue() {
      return updateShelf('continue', continueItems(), progressCard);
    }

    function updateFavorites() {
      if (!updateShelf('favorites', favItems(), (it, n) => posterHtml(it, kind, n))) return false;
      // The star badges on the other shelves.
      track.querySelectorAll('.poster[data-id]').forEach((el) => {
        el.classList.toggle('is-fav', IPTV.isMediaFavorite(favKind, el.getAttribute('data-id')));
      });
      return true;
    }

    IPTV.onChange((reason) => {
      if (reason === 'favorites') return;
      if (built && sigOf() === builtSig && updateContinue() && updateFavorites()) return;
      const wasIn = Nav.current() && root.contains(Nav.current());
      built = false;
      heroItem = null;
      if (shown && IPTV.ui.tab() === tabName) {
        show();
        if (wasIn) {
          const f = enter();
          if (f) Nav.focus(f, { force: true });
        }
      } else {
        track.innerHTML = '';
      }
    });

    IPTV.on('status', () => {
      if (shown && !built && IPTV.ui.tab() === tabName) show();
    });

    IPTV.ui.registerTab(tabName, {
      el: root,
      show,
      resume() { if (!built) show(); },
      hide() {
        shown = false;
        clearTimeout(heroTimer);
        clearTimeout(infoTimer);
      },
      enter,
      onKey
    });
  }

  // =========================================================================================
  // Detail page
  // =========================================================================================

  const detail = (function () {
    const root = document.createElement('div');
    root.className = 'md-detail';
    root.hidden = true;
    root.innerHTML =
      '<div class="md-d-bg"></div><div class="md-d-shade"></div>' +
      '<div class="md-d-body">' +
        '<h1 class="md-d-title"></h1>' +
        '<p class="md-d-meta"></p>' +
        '<p class="md-d-plot"></p>' +
        '<p class="md-d-cast"></p>' +
        '<div class="md-d-actions"></div>' +
      '</div>' +
      '<div class="md-d-series" hidden>' +
        '<div class="md-d-seasons" data-scroll-viewport><div class="md-d-seasons-track" data-scroll-track data-scroll-edge="80"></div></div>' +
        '<div class="shelf-viewport md-d-eps"><div class="shelf-track" data-scroll-track data-scroll-edge="120"></div></div>' +
      '</div>' +
      '<div class="md-d-state"></div>';
    const q = (sel) => root.querySelector(sel);

    const D = { kind: null, item: null, full: null, season: 0, token: 0, open: false, fromHome: false };
    let seasonTimer = null;

    function epProgress(ep) {
      return IPTV.progressFor(ep.id);
    }

    // Which episode should "Play" start? The one in progress, otherwise the next after the last watched, otherwise the first.
    function nextEpisode(full) {
      const all = [];
      (full.seasons || []).forEach((s) => s.episodes.forEach((e) => all.push(e)));
      const cont = IPTV.continueWatching().find((p) => p.kind === 'episode' && String(p.seriesId) === String(full.id));
      if (cont) {
        const ep = all.find((e) => String(e.id) === String(cont.id));
        if (ep) return { ep, progress: cont };
      }
      return { ep: all[0] || null, progress: null };
    }

    function renderActions() {
      const full = D.full;
      const box = q('.md-d-actions');
      if (!full) { box.innerHTML = ''; return; }
      if (D.kind === 'vod') {
        const p = IPTV.progressFor(full.id);
        box.innerHTML =
          '<button class="btn btn-primary" data-focusable data-act="play">' + u.icon('play') +
            '<span>' + (p ? tr('media.resumeFrom', { time: u.clock(p.position) }) : tr('media.play')) + '</span></button>' +
          (p ? '<button class="btn" data-focusable data-act="restart">' + u.icon('restart') + '<span>' + tr('media.fromStart') + '</span></button>' : '') +
          favButton(full);
      } else {
        const n = nextEpisode(full);
        const label = n.ep
          ? (n.progress ? tr('media.resumeEpisode', { season: n.ep.season, episode: n.ep.episode }) : tr('media.playEpisode', { season: n.ep.season, episode: n.ep.episode }))
          : tr('media.noEpisodes');
        box.innerHTML =
          '<button class="btn btn-primary" data-focusable data-act="play"' + (n.ep ? '' : ' disabled') + '>' + u.icon('play') + '<span>' + label + '</span></button>' +
          (n.progress ? '<button class="btn" data-focusable data-act="restart">' + u.icon('restart') + '<span>' + tr('media.fromStart') + '</span></button>' : '') +
          favButton(full);
      }
    }

    function favButton(full) {
      const on = IPTV.isMediaFavorite(D.kind === 'vod' ? 'vod' : 'series', full.id);
      return '<button class="btn btn-icon md-d-fav' + (on ? ' is-on' : '') + '" data-focusable data-act="fav" aria-label="' + tr('media.favourite') + '">' +
        u.icon(on ? 'star-fill' : 'star') + '</button>';
    }

    function render() {
      const it = D.full || D.item || {};
      root.classList.toggle('is-series', D.kind === 'series');
      q('.md-d-title').textContent = it.title || '';
      q('.md-d-title').classList.toggle('is-long', String(it.title || '').length > 26);
      const seasons = D.full && D.full.seasons ? D.full.seasons.length : 0;
      q('.md-d-meta').innerHTML = metaLine(it, D.kind === 'series' && seasons ? tr('media.seasons', { n: seasons }) : '');
      q('.md-d-plot').textContent = it.plot || '';
      q('.md-d-cast').innerHTML = it.cast ? '<span>' + tr('media.cast') + '</span> ' + esc(String(it.cast).split(/\s*,\s*/).slice(0, 5).join(', ')) +
        (it.director ? '<br><span>' + tr('media.director') + '</span> ' + esc(it.director) : '') : (it.director ? '<span>' + tr('media.director') + '</span> ' + esc(it.director) : '');
      const pic = it.backdrop || '';
      const bg = q('.md-d-bg');
      root.classList.toggle('is-poster-bg', !pic && !!it.poster);
      const url = pic ? src().img(pic, 1280) : it.poster ? src().img(it.poster, 640) : '';
      if (bg.getAttribute('data-url') !== url) {
        bg.setAttribute('data-url', url);
        bg.classList.remove('is-on');
        if (url) {
          const img = new Image();
          const show = () => {
            if (bg.getAttribute('data-url') !== url) return;
            bg.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
            bg.classList.add('is-on');
          };
          img.onload = () => (img.decode ? img.decode().then(show, show) : show());
          img.src = url;
        } else {
          bg.style.backgroundImage = 'none';
        }
      }
      renderActions();
      q('.md-d-series').hidden = D.kind !== 'series' || !seasons;
      if (D.kind === 'series' && seasons) renderSeasons();
    }

    function renderSeasons() {
      const full = D.full;
      q('.md-d-seasons-track').innerHTML = full.seasons.map((s, i) =>
        '<button class="pill md-season' + (i === D.season ? ' is-active' : '') + '" data-focusable data-season="' + i + '">' + esc(s.name || tr('media.seasonN', { season: s.season })) + '</button>'
      ).join('');
      renderEpisodes();
    }

    function renderEpisodes() {
      const s = D.full.seasons[D.season];
      const t = q('.md-d-eps .shelf-track');
      t.dataset.offset = '0';
      t.style.transform = '';
      if (!s || !s.episodes.length) {
        t.innerHTML = '<p class="md-shelf-empty">' + tr('media.noEpisodesHere') + '</p>';
        return;
      }
      t.innerHTML = s.episodes.map((ep, i) => {
        const p = epProgress(ep);
        const pct = p && p.duration ? Math.round((p.position / p.duration) * 100) : 0;
        const pic = ep.still || D.full.backdrop || D.full.poster;
        return '<button class="card md-ep" data-focusable data-ep="' + i + '">' +
          '<div class="lift-shadow"></div>' +
          '<div class="card-face">' +
            '<span class="poster-fallback">' + ep.episode + '</span>' +
            (pic ? '<img src="' + esc(src().img(pic, 480)) + '" data-orig="' + esc(pic) + '" alt="" loading="lazy" decoding="async" data-hide-broken>' : '') +
            (pct ? '<span class="progress md-card-progress"><i style="--p:' + pct + '%"></i></span>' : '') +
            '<i class="shine"></i>' +
          '</div>' +
          '<span class="card-label"><b>' + ep.episode + '. ' + esc(ep.title) + '</b><small>' +
            esc([ep.duration ? u.duration(ep.duration) : '', ep.plot ? ep.plot : ''].filter(Boolean).join(' · ')) + '</small></span>' +
        '</button>';
      }).join('');
    }

    function selectSeason(i, focusEps) {
      if (!D.full || !D.full.seasons[i]) return;
      D.season = i;
      root.querySelectorAll('.md-season').forEach((b) => b.classList.toggle('is-active', +b.getAttribute('data-season') === i));
      renderEpisodes();
      if (focusEps) {
        const f = q('.md-d-eps [data-focusable]');
        if (f) Nav.focus(f, { force: true });
      }
    }

    function state(kindOf, text) {
      const box = q('.md-d-state');
      if (!kindOf) { box.innerHTML = ''; return; }
      box.innerHTML = kindOf === 'loading' ? '<div class="spinner"></div>' :
        '<div class="md-d-error">' + u.icon('signal') + '<span>' + esc(text || tr('media.loadFailed')) + '</span><button class="btn" data-focusable data-act="retry">' + tr('common.retry') + '</button></div>';
      const f = box.querySelector('[data-focusable]');
      if (f) Nav.focus(f, { force: true });
    }

    function load() {
      const token = ++D.token;
      state('loading');
      return info(D.kind, D.item.id).then((full) => {
        if (token !== D.token) return null;
        D.full = Object.assign({}, D.item, full);
        // Start on the season with the episode in progress.
        if (D.kind === 'series') {
          const n = nextEpisode(D.full);
          D.season = n.ep ? Math.max(0, D.full.seasons.findIndex((s) => s.episodes.indexOf(n.ep) >= 0)) : 0;
        }
        state(null);
        render();
        const f = q('[data-act="play"]:not([disabled])') || q('.md-d-actions [data-focusable]') || q('.md-d-eps [data-focusable]');
        if (f && D.open) Nav.focus(f, { force: true });
        return D.full;
      }).catch((err) => {
        if (token !== D.token) return null;
        state('error', err.message);
        return null;
      });
    }

    function open(kind, item, opts) {
      opts = opts || {};
      D.kind = kind === 'movies' ? 'vod' : kind;
      D.item = item;
      D.full = null;
      D.season = 0;
      D.fromHome = !!opts.fromHome;
      if (!D.open) {
        D.open = true;
        IPTV.ui.pushScreen({
          name: 'detail',
          el: root,
          onKey,
          onClose() {
            D.open = false;
            D.token++;
            clearTimeout(seasonTimer);
          },
          onResume() {
            if (!D.full) return;
            renderActions();
            if (D.kind === 'series') renderEpisodes();
            const f = q('[data-act="play"]');
            if (f && !(Nav.current() && root.contains(Nav.current()))) Nav.focus(f, { force: true });
          }
        });
      }
      render();
      return load();
    }

    function close() {
      if (!D.open) return;
      IPTV.ui.popScreen();
      if (D.fromHome) {
        D.fromHome = false;
        Router.back();
      }
    }

    function playMovie(start) {
      const f = D.full;
      IPTV.playback.play({
        id: f.id, kind: 'vod', url: f.url, title: f.title, poster: f.poster, backdrop: f.backdrop,
        duration: f.duration, year: f.year, plot: f.plot || '', genre: f.genre || ''
      }, { start });
    }

    function playEpisode(ep, start, ask) {
      const f = D.full;
      const all = [];
      f.seasons.forEach((s) => s.episodes.forEach((e) => all.push(e)));
      const i = all.indexOf(ep);
      IPTV.playback.play(episodeMedia(f, ep), {
        start,
        ask: !!ask,
        next: i >= 0 && all[i + 1] ? () => episodeMedia(f, all[i + 1]) : null
      });
    }

    function playAction(restart) {
      if (!D.full) return;
      if (D.kind === 'vod') {
        const p = IPTV.progressFor(D.full.id);
        playMovie(restart || !p ? 0 : p.position);
      } else {
        const n = nextEpisode(D.full);
        if (n.ep) playEpisode(n.ep, restart || !n.progress ? 0 : n.progress.position);
      }
    }

    root.addEventListener('nav:activate', (e) => {
      const t = e.target;
      const act = t.getAttribute('data-act');
      if (act === 'play') playAction(false);
      else if (act === 'restart') playAction(true);
      else if (act === 'fav') {
        const k = D.kind === 'vod' ? 'vod' : 'series';
        const item = Object.assign({}, D.item || {}, D.full || {});
        const was = IPTV.isMediaFavorite(k, item.id);
        IPTV.toggleMediaFavorite(k, item).then(() => {
          renderActions();
          const f = q('[data-act="fav"]');
          if (f) Nav.focus(f, { force: true });
        });
        UI.toast(was ? tr('media.favRemoved', { name: item.title }) : tr('media.favAdded', { name: item.title }));
      }
      else if (act === 'retry') load();
      else if (t.hasAttribute('data-season')) selectSeason(+t.getAttribute('data-season'), true);
      else if (t.hasAttribute('data-ep')) {
        const ep = D.full.seasons[D.season].episodes[+t.getAttribute('data-ep')];
        const p = epProgress(ep);
        playEpisode(ep, p ? p.position : 0, true);
      }
    });

    root.addEventListener('nav:longpress', (e) => {
      const t = e.target;
      if (!t.hasAttribute('data-ep')) return;
      const ep = D.full.seasons[D.season].episodes[+t.getAttribute('data-ep')];
      const p = epProgress(ep);
      UI.menu({
        title: ep.episode + '. ' + ep.title,
        subtitle: ep.plot ? ep.plot.slice(0, 160) : '',
        items: [
          { label: p ? tr('media.resumeFrom', { time: u.clock(p.position) }) : tr('media.play'), action: () => playEpisode(ep, p ? p.position : 0) },
          p && { label: tr('media.fromStart'), action: () => playEpisode(ep, 0) }
        ]
      });
    });

    root.addEventListener('nav:focus', (e) => {
      const t = e.target;
      root.classList.toggle('is-down', !!t.closest('.md-d-series'));
      if (t.hasAttribute('data-season')) {
        clearTimeout(seasonTimer);
        const i = +t.getAttribute('data-season');
        if (i !== D.season) seasonTimer = setTimeout(() => selectSeason(i), 250);
      }
    });

    function onKey(name) {
      if (name === 'back') {
        close();
        return true;
      }
      const cur = Nav.current();
      if (name === 'up' && cur && cur.closest('.md-d-actions')) return true;
      return false;
    }

    return { open, close, isOpen: () => D.open, reload: load };
  })();

  function episodeMedia(full, ep) {
    return {
      id: ep.id, kind: 'episode', url: ep.url, title: ep.title, seriesId: full.id, seriesTitle: full.title,
      season: ep.season, episode: ep.episode, poster: full.poster, backdrop: full.backdrop, still: ep.still,
      duration: ep.duration, plot: ep.plot || full.plot || ''
    };
  }

  // --- Continue watching (from a shelf or the home screen) ----------------------------------------

  function resume(p, opts) {
    opts = opts || {};
    if (!p) return;
    if (p.kind === 'episode' && p.seriesId) {
      detail.open('series', { id: p.seriesId, title: p.seriesTitle, poster: p.poster, backdrop: p.backdrop }, opts).then((full) => {
        if (!full) return;
        let ep = null;
        full.seasons.forEach((s) => s.episodes.forEach((e) => { if (String(e.id) === String(p.id)) ep = e; }));
        if (!ep) { UI.toast(tr('media.episodeGone')); return; }
        const all = [];
        full.seasons.forEach((s) => s.episodes.forEach((e) => all.push(e)));
        const i = all.indexOf(ep);
        IPTV.playback.play(episodeMedia(full, ep), {
          start: p.position,
          next: all[i + 1] ? () => episodeMedia(full, all[i + 1]) : null
        });
      });
      return;
    }
    detail.open('vod', { id: p.id, title: p.title, poster: p.poster, backdrop: p.backdrop }, opts).then((full) => {
      if (!full) return;
      IPTV.playback.play({
        id: full.id, kind: 'vod', url: full.url, title: full.title, poster: full.poster, backdrop: full.backdrop, duration: full.duration
      }, { start: p.position });
    });
  }

  browser('vod');
  browser('series');

  IPTV.media = {
    openDetail: detail.open,
    closeDetail: detail.close,
    resume
  };
})(window);
