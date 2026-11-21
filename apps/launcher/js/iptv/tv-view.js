/*
 * The TV view: a glass tab bar (Live · Guide · Movies · Series · Search) and the Live tab
 * (categories · virtualised channel list · preview) with full screen and an info panel.
 *
 * Other modules add tabs and full-screen modes via IPTV.ui:
 *   IPTV.ui.registerTab(name, { el, show(params), hide(), enter(), onKey(name, e) })
 *   IPTV.ui.pushScreen({ name, el, onKey(name, e), onClose() })  / popScreen() / topScreen()
 *   IPTV.open(params)  { tab, channel, fullscreen, item, play }
 *
 * Nothing switches just because focus moves (Settings › IPTV › Navigation, Store 'iptv.nav.*'):
 *   tabs     'ok' (default): ◀ ▶ on the tab bar only moves the cursor, OK or ▼ switches tab · 'focus': as before
 *   preview  'ok' (default): OK on a channel plays it in the pane, OK again = full screen ·
 *            'auto': the channel under the cursor starts playing after a second · 'off': OK = full screen straight away
 *   zap      'direct' (default): ▲▼ in full screen switches channel · 'confirm': ▲▼ browses, OK switches
 *   back     'app' (default): Back from something started on the home screen goes to the TV app · 'home'
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const P = IPTV.player;
  const E = IPTV.epg;
  const u = IPTV.u;
  const esc = u.esc;

  const el = document.querySelector('[data-view="tv"]');
  const ROW_H = 104;
  const VISIBLE = 8;
  const BUFFER = 5;
  const PREVIEW_DELAY = 1000;
  const BROWSE_MS = 8000;

  const navPref = (key, def) => { const v = Store.get('iptv.nav.' + key); return v == null || v === '' ? def : v; };
  const tabOnFocus = () => navPref('tabs', 'ok') === 'focus';
  const previewMode = () => { const v = navPref('preview', 'ok'); return v === 'auto' || v === 'off' ? v : 'ok'; };
  const zapConfirm = () => navPref('zap', 'direct') === 'confirm';
  const backToHome = () => navPref('back', 'app') === 'home';
  const bannerMs = () => { const n = Number(Store.get('live.bannerSeconds')); return (n >= 2 && n <= 30 ? n : 5) * 1000; };
  const TABS = [
    { id: 'live', label: tr('tv.tabs.live') },
    { id: 'guide', label: tr('tv.tabs.guide') },
    { id: 'movies', label: tr('tv.tabs.movies') },
    { id: 'series', label: tr('tv.tabs.series') },
    { id: 'search', label: tr('tv.tabs.search'), icon: 'search' }
  ];
  // Fixed strings on hot paths (rows, banner): the language only changes on restart.
  const NO_GUIDE = tr('tv.noGuide');

  const $ = (sel) => el.querySelector(sel);
  const clamp = u.clamp;
  const sameCh = u.sameId;

  // --- Shell --------------------------------------------------------------------------

  el.innerHTML =
    '<div class="tv-shell">' +
      '<div class="tv-bg"></div>' +
      '<header class="tv-top">' +
        '<nav class="tv-tabs glass">' +
          TABS.map((t) => '<button class="tv-tab" data-focusable data-tab="' + t.id + '">' +
            (t.icon ? u.icon(t.icon) : '') + '<span>' + t.label + '</span></button>').join('') +
          '<button class="tv-tab tv-tab-gear" data-focusable data-act="iptv-settings" aria-label="' + tr('common.settings') + '">' + u.icon('gear') + '</button>' +
        '</nav>' +
        '<div class="tv-top-right"><span class="tv-badge" hidden>' + tr('tv.demo') + '</span><span class="tv-clock tabular"></span></div>' +
      '</header>' +
      '<div class="tv-panes">' +
        '<section class="tv-pane-wrap" data-pane="live"></section>' +
        '<section class="tv-pane-wrap" data-pane="guide" hidden></section>' +
        '<section class="tv-pane-wrap" data-pane="movies" hidden></section>' +
        '<section class="tv-pane-wrap" data-pane="series" hidden></section>' +
        '<section class="tv-pane-wrap" data-pane="search" hidden></section>' +
      '</div>' +
    '</div>' +
    '<div class="tv-screens"></div>' +
    '<div class="tv-numpad glass" hidden></div>';

  const shell = $('.tv-shell');
  const screensHost = $('.tv-screens');
  const tabs = {};
  const screens = [];
  let tab = 'live';
  let tabTimer = null;
  let visible = false;
  let fromHome = false;   // opened straight into full screen from the home screen
  let clockTimer = null;

  const paneEl = (name) => el.querySelector('[data-pane="' + name + '"]');
  const tabBtn = (name) => el.querySelector('.tv-tab[data-tab="' + name + '"]');

  function registerTab(name, def) {
    def.el = def.el || paneEl(name);
    tabs[name] = def;
  }

  function markTab() {
    el.querySelectorAll('.tv-tab').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-tab') === tab));
  }

  function setTab(name, params) {
    if (!tabs[name]) return;
    const changed = name !== tab;
    if (changed && tabs[tab] && tabs[tab].hide) tabs[tab].hide();
    tab = name;
    Object.keys(tabs).forEach((k) => { tabs[k].el.hidden = k !== name; });
    shell.setAttribute('data-tab', name);
    markTab();
    if ((changed || params) && tabs[name].el.animate) {
      tabs[name].el.animate([
        { opacity: 0, transform: 'translate3d(0, 14px, 0)' },
        { opacity: 1, transform: 'none' }
      ], { duration: 300, easing: Nav.ease });
    }
    if (tabs[name].show) tabs[name].show(params || {}, changed);
  }

  function enterTab() {
    const t = tabs[tab];
    const target = t && t.enter ? t.enter() : null;
    if (target) Nav.focus(target, { force: true, dir: 'down' });
  }

  function focusTabs() {
    Nav.focus(tabBtn(tab), { force: true, dir: 'up' });
  }

  // --- Full-screen modes (detail page, live, movie) --------------------------------------

  function pushScreen(scr) {
    // The screen below (e.g. the detail page behind the movie player) is hidden so that the video shows.
    const under = screens[screens.length - 1];
    if (under) under.el.classList.add('is-covered');
    screens.push(scr);
    scr.el.classList.add('tv-screen');
    if (!scr.el.parentNode) screensHost.appendChild(scr.el);
    scr.el.hidden = false;
    el.classList.toggle('has-screen', true);
    el.setAttribute('data-screen', scr.name);
    Nav.pushScope(scr.el, scr.focus ? { focus: scr.focus } : undefined);
    return scr;
  }

  function popScreen() {
    const scr = screens.pop();
    if (!scr) return null;
    scr.el.hidden = true;
    if (scr.onClose) scr.onClose();
    if (scr.remove) scr.el.remove();
    Nav.popScope();
    clearTimeout(tabTimer);
    const top = screens[screens.length - 1];
    // The element that had focus may have been redrawn in the meantime (e.g. Continue watching) –
    // in that case land in the tab again instead of on the first focusable element.
    if (!top && !closingAll) {
      const t = tabs[tab];
      const cur = Nav.current();
      if (!(cur && document.contains(cur) && t && t.el.contains(cur))) {
        const f = t && t.enter ? t.enter() : null;
        if (f) Nav.focus(f, { force: true }); else focusTabs();
      }
    }
    if (top) top.el.classList.remove('is-covered');
    el.classList.toggle('has-screen', !!top);
    if (top) el.setAttribute('data-screen', top.name); else el.removeAttribute('data-screen');
    if (top && top.onResume) top.onResume();
    else if (!top && tabs[tab] && tabs[tab].resume) tabs[tab].resume();
    return scr;
  }

  const topScreen = () => screens[screens.length - 1] || null;

  let closingAll = false;
  function closeAllScreens() {
    closingAll = true;
    try { while (screens.length) popScreen(); } finally { closingAll = false; }
  }

  // --- Clock --------------------------------------------------------------------------------

  // Weekdays and months in the interface language – built once.
  const names = (opts, n, at) => {
    const f = new Intl.DateTimeFormat(I18n.locale, opts);
    const out = [];
    for (let i = 0; i < n; i++) out.push(f.format(at(i)));
    return out;
  };
  const DAYS = names({ weekday: 'short' }, 7, (i) => new Date(2024, 0, 7 + i)); // 7 Jan 2024 = Sunday
  const MONTHS = names({ month: 'short' }, 12, (i) => new Date(2024, i, 1));
  function clockText() {
    const d = new Date();
    return { time: u.time(d.getTime()), date: DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] };
  }

  function tick() {
    const c = clockText();
    $('.tv-clock').textContent = c.time;
    $('.tv-badge').hidden = !IPTV.api.isDemo();
    live.tick(c);
  }

  // =======================================================================================
  // Live
  // =======================================================================================

  const live = (function () {
    const root = paneEl('live');
    root.innerHTML =
      '<nav class="tv-cats" data-vscroll-viewport>' +
        '<div class="tv-cats-track" data-vscroll-track data-scroll-edge="140"></div>' +
      '</nav>' +
      '<section class="tv-list">' +
        '<div class="tv-list-head"><span class="tv-list-title"></span><span class="tv-list-count"></span></div>' +
        '<div class="tv-list-viewport"><div class="tv-list-track"></div></div>' +
        '<div class="tv-list-state" hidden></div>' +
      '</section>' +
      '<aside class="tv-pane">' +
        '<div class="tv-pane-video"><div class="tv-pane-poster"></div><div class="tv-pane-state"></div></div>' +
        '<div class="tv-pane-info">' +
          '<p class="tv-pane-playing" hidden></p>' +
          '<p class="tv-pane-name"></p>' +
          '<p class="tv-pane-title"></p>' +
          '<div class="tv-pane-meta" hidden><span class="tv-pane-time"></span><span class="progress"><i></i></span></div>' +
          '<p class="tv-pane-desc"></p>' +
          '<p class="tv-pane-next"></p>' +
        '</div>' +
        '<p class="tv-pane-hint"></p>' +
        '<div class="tv-pane-actions">' +
          '<button class="btn" data-focusable data-act="full">' + u.icon('play') + '<span>' + tr('tv.fullscreen') + '</span></button>' +
          '<button class="btn btn-icon" data-focusable data-act="fav" aria-label="' + tr('tv.favourite') + '">' + u.icon('star') + '</button>' +
        '</div>' +
      '</aside>' +
      '<div class="tv-message" hidden></div>';

    const q = (sel) => root.querySelector(sel);

    const S = {
      cats: [],
      catIndex: 0,
      list: [],
      listCat: null,
      index: 0,
      zapList: null,
      mode: 'guide',
      shown: false
    };
    const listCache = {}; // category id -> Promise<[Channel]>

    let rows = {};
    let scrollTop = 0;
    let listToken = 0;
    let catTimer = null;
    let previewTimer = null;
    let epgTimer = null;
    let numBuf = '';
    let numTimer = null;

    // --- Messages

    function message(kind, text) {
      const box = q('.tv-message');
      root.classList.add('has-message');
      box.hidden = false;
      let html;
      if (kind === 'loading') {
        html = '<div class="spinner"></div><p class="tv-msg-text">' + tr('tv.msg.connecting') + '</p>';
      } else if (kind === 'setup') {
        const hubMode = IPTV.mode() === 'hub';
        html =
          '<div class="tv-msg-icon">' + u.icon('tv') + '</div>' +
          '<h2 class="tv-msg-title">' + tr('tv.msg.setupTitle') + '</h2>' +
          '<p class="tv-msg-text">' + (hubMode
            ? tr('tv.msg.setupHub')
            : tr('tv.msg.setupAny')) + '</p>' +
          '<div class="tv-msg-actions"><button class="btn" data-focusable data-autofocus data-act="settings">' + u.icon('gear') + '<span>' + tr('tv.msg.openSettings') + '</span></button></div>';
      } else if (kind === 'empty') {
        html =
          '<div class="tv-msg-icon">' + u.icon('grid') + '</div>' +
          '<h2 class="tv-msg-title">' + tr('tv.msg.noCatsTitle') + '</h2>' +
          '<p class="tv-msg-text">' + (IPTV.mode() === 'hub'
            ? tr('tv.msg.noCatsHub', { url: esc(IPTV.hubUrl()) })
            : tr('tv.msg.allHidden')) + '</p>' +
          '<div class="tv-msg-actions"><button class="btn" data-focusable data-autofocus data-act="retry">' + u.icon('refresh') + '<span>' + tr('common.reload') + '</span></button></div>';
      } else {
        html =
          '<div class="tv-msg-icon is-error">' + u.icon('signal') + '</div>' +
          '<h2 class="tv-msg-title">' + tr('tv.msg.connectFailed') + '</h2>' +
          '<p class="tv-msg-text">' + esc(text || tr('common.unknownError')) + '</p>' +
          '<div class="tv-msg-actions">' +
          '<button class="btn" data-focusable data-autofocus data-act="retry">' + u.icon('refresh') + '<span>' + tr('common.retry') + '</span></button>' +
          '<button class="btn" data-focusable data-act="settings">' + u.icon('gear') + '<span>' + tr('common.settings') + '</span></button></div>';
      }
      box.innerHTML = html;
    }

    function hideMessage() {
      q('.tv-message').hidden = true;
      root.classList.remove('has-message');
    }

    // --- Categories

    function buildCats() {
      const cats = [{ id: 'favorites', name: tr('tv.favourites'), kind: 'fav', icon: 'star', count: IPTV.favorites().length }];
      if (IPTV.recent().length) cats.push({ id: 'recent', name: tr('tv.recent'), kind: 'recent', icon: 'history' });
      IPTV.categories('live').forEach((c) => cats.push({ id: String(c.id), name: c.name, kind: 'cat', count: c.count }));
      return cats;
    }

    function renderCats(keepId) {
      const prevId = keepId || (S.cats[S.catIndex] && S.cats[S.catIndex].id);
      S.cats = buildCats();
      const i = S.cats.findIndex((c) => c.id === prevId);
      S.catIndex = i >= 0 ? i : clamp(S.catIndex, 0, S.cats.length - 1);
      q('.tv-cats-track').innerHTML = S.cats.map((c, n) =>
        '<button class="tv-cat' + (n === S.catIndex ? ' is-active' : '') + '" data-focusable data-ci="' + n + '">' +
        (c.icon ? '<span class="tv-cat-icon">' + u.icon(c.icon) + '</span>' : '') +
        '<span class="tv-cat-name">' + esc(c.name) + '</span>' +
        (c.count ? '<span class="tv-cat-count">' + c.count + '</span>' : '') + '</button>'
      ).join('');
    }

    const catEl = (i) => root.querySelector('.tv-cat[data-ci="' + i + '"]');

    function markActiveCat() {
      root.querySelectorAll('.tv-cat.is-active').forEach((c) => c.classList.remove('is-active'));
      const c = catEl(S.catIndex);
      if (c) c.classList.add('is-active');
    }

    function listFor(cat) {
      if (cat.kind === 'fav') return Promise.resolve(IPTV.favorites());
      if (cat.kind === 'recent') return Promise.resolve(IPTV.recent());
      if (!listCache[cat.id]) {
        listCache[cat.id] = IPTV.source.channels(cat.id).catch((e) => { delete listCache[cat.id]; throw e; });
      }
      return listCache[cat.id];
    }

    function selectCat(i, opts) {
      opts = opts || {};
      const cat = S.cats[i];
      if (!cat) return Promise.resolve();
      const token = ++listToken;
      S.catIndex = i;
      markActiveCat();
      q('.tv-list-title').textContent = cat.name;
      q('.tv-list-count').textContent = '';
      if (S.listCat !== cat.id || opts.reload) listState('loading');

      return listFor(cat).then((list) => {
        if (token !== listToken) return;
        const keep = S.listCat === cat.id && !opts.reload ? S.list[S.index] : null;
        S.list = list;
        S.listCat = cat.id;
        let idx = 0;
        const want = opts.channel || keep || (P.kind() === 'live' && P.current()) || IPTV.lastChannel();
        if (want) {
          const f = list.findIndex((c) => sameCh(c, want));
          if (f >= 0) idx = f;
        }
        S.index = clamp(idx, 0, Math.max(0, list.length - 1));
        q('.tv-list-count').textContent = list.length ? tr('tv.channelCount', { n: list.length }) : '';
        if (!list.length) {
          listState(cat.kind === 'fav' ? 'nofav' : cat.kind === 'recent' ? 'norecent' : 'empty');
          paneFor(null);
          if (opts.focusList) Nav.focus(catEl(i), { force: true });
          return;
        }
        listState(null);
        renderList();
        if (opts.focusList) focusRow(S.index);
        // The first time (the cursor is on the tab bar): show the selected channel's info in the pane anyway.
        else if (!q('.tv-pane').getAttribute('data-ch')) paneFor(S.list[S.index]);
      }).catch((err) => {
        if (token !== listToken) return;
        listState('error', err.message);
      });
    }

    function listState(kind, text) {
      const box = q('.tv-list-state');
      const track = q('.tv-list-track');
      if (!kind) {
        box.hidden = true;
        track.hidden = false;
        return;
      }
      track.hidden = true;
      track.innerHTML = '';
      rows = {};
      box.hidden = false;
      const msgs = {
        loading: '<div class="spinner"></div>',
        nofav: '<div class="tv-msg-icon">' + u.icon('star') + '</div><p>' + tr('tv.list.noFavourites') + '</p><p class="tv-dim">' +
          (IPTV.mode() === 'hub' ? tr('tv.list.noFavouritesHintHub') : tr('tv.list.noFavouritesHint')) + '</p>',
        norecent: '<div class="tv-msg-icon">' + u.icon('history') + '</div><p>' + tr('tv.list.noRecent') + '</p>',
        empty: '<p>' + tr('tv.list.empty') + '</p>',
        error: '<div class="tv-msg-icon is-error">' + u.icon('signal') + '</div><p>' + tr('tv.list.failed') + '</p><p class="tv-dim">' + esc(text || '') + '</p>'
      };
      box.innerHTML = msgs[kind] || '';
    }

    // --- Virtualised channel list

    function windowRange() {
      const first = Math.floor(scrollTop / ROW_H);
      return [Math.max(0, first - BUFFER), Math.min(S.list.length, first + VISIBLE + BUFFER)];
    }

    const isPlaying = (ch) => P.kind() === 'live' && sameCh(P.current(), ch) && P.mode() !== 'preview' && P.state() !== 'error';
    const nowHtml = (nn) => (nn && nn.now ? esc(nn.now.title) : nn ? '<span class="tv-dim">' + NO_GUIDE + '</span>' : '&nbsp;');

    // The row is built once; after that only what can change is patched (playing, favourite, programme now) –
    // the logo and the rest are left alone (no new <img> per key press or clock tick).
    function rowHtml(ch) {
      const nn = E.peek(ch);
      const now = nn && nn.now;
      return (
        '<span class="tv-row-logo">' + u.logo(ch, '', 160) + '</span>' +
        '<span class="tv-row-main">' +
          '<span class="tv-row-line">' +
            (ch.num != null ? '<span class="tv-row-num tabular">' + ch.num + '</span>' : '') +
            '<span class="tv-row-name">' + esc(ch.name) + '</span>' +
            '<span class="tv-row-fav"' + (IPTV.isFavorite(ch.id) ? '' : ' hidden') + '>' + u.icon('star-fill') + '</span>' +
            '<span class="tv-eq"><i></i><i></i><i></i></span>' +
          '</span>' +
          '<span class="tv-row-now">' + nowHtml(nn) + '</span>' +
          '<span class="progress tv-row-progress"' + (now ? '' : ' hidden') + '><i style="--p:' + (now ? Math.round(E.progress(now) * 100) : 0) + '%"></i></span>' +
        '</span>'
      );
    }

    function makeRow(i) {
      const b = document.createElement('button');
      const ch = S.list[i];
      b.className = 'tv-row' + (isPlaying(ch) ? ' is-playing' : '');
      b.setAttribute('data-focusable', '');
      b.setAttribute('data-i', String(i));
      b.style.transform = 'translate3d(0,' + i * ROW_H + 'px,0)';
      b.innerHTML = rowHtml(ch);
      b._now = nowHtml(E.peek(ch));
      return b;
    }

    function refreshRow(i) {
      const r = rows[i];
      const ch = S.list[i];
      if (!r || !ch) return;
      r.classList.toggle('is-playing', isPlaying(ch));
      const fav = r.querySelector('.tv-row-fav');
      const isFav = IPTV.isFavorite(ch.id);
      if (fav && fav.hidden === isFav) fav.hidden = !isFav;
      const nn = E.peek(ch);
      const html = nowHtml(nn);
      if (r._now !== html) {
        r._now = html;
        r.querySelector('.tv-row-now').innerHTML = html;
      }
      const prog = r.querySelector('.tv-row-progress');
      const now = nn && nn.now;
      if (prog.hidden === !!now) prog.hidden = !now;
      if (now) prog.firstChild.style.setProperty('--p', Math.round(E.progress(now) * 100) + '%');
    }

    function refreshRows() {
      Object.keys(rows).forEach((k) => refreshRow(+k));
    }

    function renderWindow() {
      const range = windowRange();
      const track = q('.tv-list-track');
      Object.keys(rows).forEach((k) => {
        const i = +k;
        if (i < range[0] || i >= range[1]) {
          if (rows[k] === Nav.current()) return; // do not remove what has focus
          rows[k].remove();
          delete rows[k];
        }
      });
      const frag = document.createDocumentFragment();
      for (let i = range[0]; i < range[1]; i++) {
        if (!rows[i]) {
          rows[i] = makeRow(i);
          frag.appendChild(rows[i]);
        }
      }
      track.appendChild(frag);
      scheduleEpg();
    }

    function scrollToIndex(i, instant) {
      const viewH = VISIBLE * ROW_H;
      const margin = ROW_H * 2;
      const y = i * ROW_H;
      let top = scrollTop;
      if (y - top < margin) top = y - margin;
      if (y + ROW_H - top > viewH - margin) top = y + ROW_H - viewH + margin;
      top = clamp(top, 0, Math.max(0, S.list.length * ROW_H - viewH));
      scrollTop = top;
      const track = q('.tv-list-track');
      track.style.transition = instant ? 'none' : '';
      track.style.transform = 'translate3d(0,' + -top + 'px,0)';
      if (instant) void track.offsetHeight;
    }

    function renderList() {
      const track = q('.tv-list-track');
      track.innerHTML = '';
      rows = {};
      track.style.height = S.list.length * ROW_H + 'px';
      scrollTop = 0;
      scrollToIndex(S.index, true);
      renderWindow();
      requestAnimationFrame(() => { track.style.transition = ''; });
    }

    function focusRow(i) {
      if (!S.list.length) return;
      S.index = clamp(i, 0, S.list.length - 1);
      scrollToIndex(S.index);
      renderWindow();
      Nav.focus(rows[S.index], { force: true });
    }

    function moveIndex(delta) {
      if (!S.list.length) return;
      const i = clamp(S.index + delta, 0, S.list.length - 1);
      if (i === S.index) return;
      focusRow(i);
    }

    // EPG for visible rows, a moment after the list has stopped.
    function scheduleEpg() {
      clearTimeout(epgTimer);
      epgTimer = setTimeout(() => {
        const first = Math.floor(scrollTop / ROW_H);
        E.want(S.list.slice(first, Math.min(S.list.length, first + VISIBLE + 2)));
      }, 160);
    }

    IPTV.on('epg', (ids) => {
      if (!S.shown || S.mode !== 'guide') return;
      const set = {};
      ids.forEach((id) => { set[id] = 1; });
      Object.keys(rows).forEach((k) => {
        const ch = S.list[+k];
        if (ch && set[String(ch.id)]) refreshRow(+k);
      });
      const ch = S.list[S.index];
      if (ch && set[String(ch.id)] && q('.tv-pane').getAttribute('data-ch') === String(ch.id)) fillPaneEpg(E.peek(ch));
      if (full.visible) full.epgUpdated(set);
    });

    // --- Preview (right column)

    function favBtn(ch) {
      const b = q('[data-act="fav"]');
      const on = ch && IPTV.isFavorite(ch.id);
      b.innerHTML = u.icon(on ? 'star-fill' : 'star');
      b.classList.toggle('is-on', !!on);
      b.setAttribute('aria-label', on ? tr('tv.removeFavourite') : tr('tv.addFavourite'));
    }

    // Logo and guide in the panel: straight away on a single press, but when a key is held
    // (presses closer than 150 ms) only once you stop – no image/EPG request per row passed.
    let paneTimer = null;
    let paneAt = 0;
    function paneDetails(ch) {
      if (q('.tv-pane').getAttribute('data-ch') !== String(ch.id)) return;
      q('.tv-pane-poster').innerHTML = '<div class="tv-pane-logo">' + u.logo(ch, '', 320) + '</div>';
      const nn = E.nowNext(ch);
      fillPaneEpg(nn.pending && !nn.now ? null : nn);
    }

    // What is playing in the pane right now (not in full screen, not a channel that has broken).
    function paneChannel() {
      return P.kind() === 'live' && P.mode() === 'pane' && P.state() !== 'error' && P.state() !== 'stopped' ? P.current() : null;
    }

    // "Now playing: SVT1" when the cursor is on a channel other than the one playing, and a hint about OK.
    function updateNowPlaying() {
      const cur = paneChannel();
      const focused = q('.tv-pane').classList.contains('is-empty') ? null : S.list[S.index];
      const other = !!(cur && focused && !sameCh(cur, focused));
      const box = q('.tv-pane-playing');
      if (box.hidden === other) box.hidden = !other;
      if (other) box.innerHTML = u.icon('play') + '<span>' + tr('tv.nowPlaying', { name: '<b>' + esc(cur.name) + '</b>' }) + '</span>';
      q('.tv-pane-hint').textContent = previewMode() !== 'ok' || !focused ? ''
        : cur && !other ? tr('tv.hint.okFullscreen') : tr('tv.hint.okPlayHere');
    }

    function paneFor(ch) {
      const pane = q('.tv-pane');
      clearTimeout(previewTimer);
      clearTimeout(paneTimer);
      pane.classList.toggle('is-empty', !ch);
      if (!ch) {
        pane.removeAttribute('data-ch');
        if (P.mode() === 'pane') P.stop();
        updateNowPlaying();
        return;
      }
      pane.setAttribute('data-ch', String(ch.id));
      q('.tv-pane-name').textContent = (ch.num != null ? ch.num + '  ' : '') + ch.name;
      favBtn(ch);
      const t = Date.now();
      const repeating = t - paneAt < 150;
      paneAt = t;
      if (repeating) {
        q('.tv-pane-poster').innerHTML = '';
        fillPaneEpg(null);
        paneTimer = setTimeout(() => paneDetails(ch), 160);
      } else {
        paneDetails(ch);
      }

      const cur = paneChannel();
      if (cur && sameCh(cur, ch)) {
        paneState(P.state());
        updateNowPlaying();
        return;
      }
      if (previewMode() !== 'auto') {
        // Browse freely: what is playing continues in the pane until you press OK on another channel.
        paneState(cur ? P.state() : 'idle');
        updateNowPlaying();
        return;
      }
      if (P.mode() === 'pane') P.stop();
      paneState('idle');
      updateNowPlaying();
      previewTimer = setTimeout(() => {
        if (S.mode === 'guide' && S.shown && !topScreen() && sameCh(S.list[S.index], ch)) P.play(ch, { mode: 'pane' });
      }, PREVIEW_DELAY);
    }

    // OK on a channel in the list.
    function activateRow(i) {
      const ch = S.list[i];
      if (!ch) return;
      if (previewMode() !== 'ok') {
        tune(ch, { list: S.list });
        return;
      }
      const cur = paneChannel();
      if (cur && sameCh(cur, ch)) {
        tune(ch, { list: S.list }); // already playing here: OK again = full screen
        return;
      }
      clearTimeout(previewTimer);
      S.index = i;
      S.zapList = S.list;
      IPTV.remember(ch);
      P.play(ch, { mode: 'pane' });
      paneState(P.state());
      updateNowPlaying();
      refreshRows();
    }

    function fillPaneEpg(nn) {
      const now = nn && nn.now;
      const next = nn && nn.next;
      q('.tv-pane-title').textContent = now ? now.title : nn ? NO_GUIDE : '';
      q('.tv-pane-title').classList.toggle('is-dim', !now);
      q('.tv-pane-time').textContent = now ? u.time(now.start) + '–' + u.time(now.end) + ' · ' + u.minutesLeft(now) : '';
      q('.tv-pane-meta').hidden = !now;
      q('.tv-pane-meta .progress i').style.setProperty('--p', (now ? Math.round(E.progress(now) * 100) : 0) + '%');
      q('.tv-pane-desc').textContent = now && now.desc ? now.desc : '';
      q('.tv-pane-next').innerHTML = next ? '<span class="tv-dim">' + tr('tv.next', { time: u.time(next.start) }) + '</span>  ' + esc(next.title) : '';
    }

    function paneState(s) {
      const pane = q('.tv-pane');
      const box = q('.tv-pane-state');
      pane.classList.toggle('is-playing', s === 'playing' || s === 'buffering');
      if (s === 'loading') box.innerHTML = '<div class="spinner"></div>';
      else if (s === 'error') box.innerHTML = '<div class="tv-nosignal">' + u.icon('signal') + '<span>' + tr('tv.noSignal') + '</span></div>';
      else box.innerHTML = '';
    }

    // --- Favourites and menu

    function toggleFav(ch) {
      if (!ch) return;
      const was = IPTV.isFavorite(ch.id);
      IPTV.toggleFavorite(ch);
      UI.toast(was ? tr('tv.favRemoved', { name: ch.name }) : tr('tv.favAdded', { name: ch.name }));
    }

    function channelMenu(i) {
      const ch = S.list[i];
      const cat = S.cats[S.catIndex];
      if (!ch) return;
      const fav = IPTV.isFavorite(ch.id);
      const items = [{ label: tr('tv.menu.watch'), action: () => tune(ch, { list: S.list }) }];
      if (cat && cat.kind === 'fav') {
        items.push({ label: tr('tv.menu.moveUp'), action: () => moveFav(ch, -1) });
        items.push({ label: tr('tv.menu.moveDown'), action: () => moveFav(ch, 1) });
      }
      items.push(fav
        ? { label: tr('tv.menu.removeFavourite'), danger: true, action: () => toggleFav(ch) }
        : { label: tr('tv.menu.addFavourite'), action: () => toggleFav(ch) });
      UI.menu({ title: ch.name, subtitle: cat ? cat.name : '', items });
    }

    function moveFav(ch, delta) {
      IPTV.moveFavorite(ch.id, delta).then((ok) => {
        if (!ok) return;
        const i = IPTV.favorites().findIndex((c) => sameCh(c, ch));
        S.list = IPTV.favorites();
        renderList();
        focusRow(i);
      });
    }

    function catMenu(i) {
      const cat = S.cats[i];
      if (!cat || cat.kind !== 'cat') return;
      const kinds = S.cats.filter((c) => c.kind === 'cat');
      const pos = kinds.indexOf(cat);
      UI.menu({
        title: cat.name,
        subtitle: IPTV.mode() === 'hub' ? tr('tv.menu.alsoInWebAdmin') : '',
        items: [
          pos > 0 && { label: tr('tv.menu.moveUp'), action: () => moveCat(cat, -1) },
          pos < kinds.length - 1 && { label: tr('tv.menu.moveDown'), action: () => moveCat(cat, 1) },
          { label: tr('tv.menu.hideCategory'), danger: true, action: () => hideCat(cat) }
        ]
      });
    }

    function moveCat(cat, delta) {
      IPTV.moveCategory('live', cat.id, delta).then(() => {
        renderCats(cat.id);
        Nav.focus(catEl(S.catIndex), { force: true });
      });
      renderCats(cat.id);
      Nav.focus(catEl(S.catIndex), { force: true });
    }

    function hideCat(cat) {
      const idx = S.catIndex;
      IPTV.hideCategory('live', cat.id);
      UI.toast(tr('tv.categoryHidden', { name: cat.name }));
      renderCats();
      S.catIndex = clamp(idx, 0, S.cats.length - 1);
      markActiveCat();
      selectCat(S.catIndex);
      Nav.focus(catEl(S.catIndex), { force: true });
    }

    // --- Channel numbers

    function clearNumber() {
      numBuf = '';
      clearTimeout(numTimer);
      $('.tv-numpad').hidden = true;
    }

    // Channels that can be reached with digits: the list shown, the zap list and the favourites.
    function numberPool() {
      const out = [];
      const seen = {};
      [S.list, S.zapList, IPTV.favorites()].forEach((l) => (l || []).forEach((c) => {
        if (c && c.num != null && !seen[c.id]) { seen[c.id] = 1; out.push(c); }
      }));
      return out;
    }

    // Show which channel the number leads to while typing. Switch straight away when no longer number
    // starts with the digits typed (e.g. 7 when there are only channels 1–9) – otherwise after
    // a short pause, as before.
    function typeDigit(d) {
      if (numBuf.length >= 4) numBuf = '';
      numBuf += d;
      const pool = numberPool();
      const exact = pool.find((c) => String(c.num) === numBuf) || null;
      const longer = pool.some((c) => String(c.num).length > numBuf.length && String(c.num).indexOf(numBuf) === 0);
      const pad = $('.tv-numpad');
      pad.innerHTML = '<b class="tabular">' + esc(numBuf) + '</b>' +
        (exact ? '<span class="tv-numpad-ch">' + u.logo(exact, '', 160) + '<span>' + esc(exact.name) + '</span></span>' : '');
      pad.hidden = false;
      clearTimeout(numTimer);
      if (!longer && (exact || numBuf.length >= 2)) numTimer = setTimeout(goToNumber, exact ? 250 : 700);
      else numTimer = setTimeout(goToNumber, 1400);
    }

    function goToNumber() {
      const n = Number(numBuf);
      clearNumber();
      if (!n) return;
      const hit = (list) => (list || []).find((c) => c.num === n);
      const inList = hit(S.list);
      if (inList) {
        if (full.visible) tune(inList, { list: S.list });
        else focusRow(S.list.indexOf(inList));
        return;
      }
      const other = hit(S.zapList) || hit(IPTV.favorites());
      if (other) tune(other);
      else UI.toast(tr('tv.noChannelNumber', { num: n }));
    }

    // --- Open / watching

    function tune(ch, opts) {
      opts = opts || {};
      if (!ch) return;
      if (!opts.keepZap) cancelZap();
      if (opts.list) S.zapList = opts.list;
      IPTV.remember(ch);
      full.open(ch);
      prefetchNeighbors(ch);
    }

    // Next/previous channel in the zap list: guide and logo in advance, so that the banner is ready
    // straight away on ▲▼. (No preloading of the stream – the TV only allows one active video player.)
    let neighborTimer = null;
    function prefetchNeighbors(ch) {
      clearTimeout(neighborTimer);
      neighborTimer = setTimeout(() => {
        const list = (S.zapList && S.zapList.length ? S.zapList : S.list) || [];
        const i = list.findIndex((c) => sameCh(c, ch));
        if (i < 0 || list.length < 2) return;
        const near = [list[(i + 1) % list.length], list[(i - 1 + list.length) % list.length]];
        E.want(near);
        near.forEach((c) => {
          if (!c || !c.logo) return;
          const im = new Image();
          im.decoding = 'async';
          im.src = u.img(c.logo, 320);
        });
      }, 800);
    }

    // ▲▼ in full screen. The first press switches straight away; if you press rapidly (hold) only
    // the banner is shown for each channel and the stream starts once you stop – the video pipeline and
    // the provider's connections are spared a new stream per channel passed.
    const ZAP_QUIET = 350;
    let zapTimer = null;
    let zapTarget = null;
    let zapBrowse = false;   // 'confirm': the channel is only shown, OK switches
    let lastZapAt = 0;

    function zap(delta) {
      const cur = zapTarget || P.current();
      const list = (S.zapList && S.zapList.length ? S.zapList : S.list) || [];
      if (!list.length || !cur) return;
      let i = list.findIndex((c) => sameCh(c, cur));
      i = i < 0 ? 0 : (i + delta + list.length) % list.length;
      const ch = list[i];
      clearTimeout(zapTimer);
      if (zapConfirm()) {
        // Browse the channels in the banner without switching. No key for a while = cancel.
        zapTarget = ch;
        zapBrowse = true;
        full.showBanner(ch, true, true);
        zapTimer = setTimeout(cancelBrowse, BROWSE_MS);
        return;
      }
      if (list === S.list) S.index = i;
      const now = Date.now();
      const rapid = now - lastZapAt < ZAP_QUIET || !!zapTimer;
      lastZapAt = now;
      if (!rapid) {
        zapTarget = null;
        zapTimer = null;
        tune(ch);
        return;
      }
      zapTarget = ch;
      full.showBanner(ch);
      zapTimer = setTimeout(() => {
        zapTimer = null;
        zapTarget = null;
        tune(ch);
      }, ZAP_QUIET);
    }

    function cancelZap() {
      clearTimeout(zapTimer);
      zapTimer = null;
      zapTarget = null;
      zapBrowse = false;
    }

    // OK while browsing: switch to the channel shown.
    function commitZap() {
      const ch = zapBrowse ? zapTarget : null;
      if (!ch) return false;
      const list = (S.zapList && S.zapList.length ? S.zapList : S.list) || [];
      if (list === S.list) S.index = Math.max(0, list.findIndex((c) => sameCh(c, ch)));
      cancelZap();
      if (sameCh(ch, P.current()) && P.state() !== 'error') full.showBanner(ch);
      else tune(ch);
      return true;
    }

    function cancelBrowse() {
      if (!zapBrowse) return false;
      cancelZap();
      full.hideBanner();
      return true;
    }

    // Previous channel (blue button): toggle between the two most recent. The zap list is kept.
    function previousChannel() {
      const cur = zapTarget || P.current();
      const prev = IPTV.recent().find((c) => !sameCh(c, cur));
      if (!prev) {
        UI.toast(tr('tv.noPreviousChannel'));
        return;
      }
      tune(prev);
    }

    function initialCat() {
      const last = IPTV.lastChannel();
      if (IPTV.favorites().length) {
        return { i: 0, channel: last && IPTV.isFavorite(last.id) ? last : null };
      }
      if (last && last.categoryId) {
        const i = S.cats.findIndex((c) => c.id === String(last.categoryId));
        if (i >= 0) return { i, channel: last };
      }
      const first = S.cats.findIndex((c) => c.kind === 'cat');
      return { i: first >= 0 ? first : 0, channel: null };
    }

    function open(focusInside) {
      S.mode = 'guide';
      if (!IPTV.configured()) {
        message('setup');
        if (focusInside) focusMessage();
        return;
      }
      const st = IPTV.status();
      const noData = !IPTV.categories('live').length && !IPTV.favorites().length;
      if (noData && (st.state === 'loading' || st.state === 'idle')) {
        // Redrawn when the bootstrap arrives (IPTV.onChange) or fails (the status event).
        message('loading');
        return;
      }
      if (noData && st.state === 'error') {
        message('error', st.error && st.error.message);
        if (focusInside) focusMessage();
        return;
      }
      if (noData) {
        message('empty');
        if (focusInside) focusMessage();
        return;
      }
      hideMessage();
      renderCats();
      if (S.listCat && S.list.length && S.cats.some((c) => c.id === S.listCat)) {
        const i = S.cats.findIndex((c) => c.id === S.listCat);
        S.catIndex = i;
        markActiveCat();
        renderList();
        paneFor(S.list[S.index]);
        if (focusInside) focusRow(S.index);
        return;
      }
      const start = initialCat();
      selectCat(start.i, { focusList: !!focusInside, channel: start.channel });
    }

    function focusMessage() {
      const f = q('.tv-message [data-autofocus]');
      if (f) Nav.focus(f, { force: true });
    }

    // Straight to full screen (e.g. a favourite on the home screen).
    function openChannel(ch) {
      const isFav = IPTV.isFavorite(ch.id);
      S.zapList = isFav ? IPTV.favorites() : null;
      tune(ch);
      // Prepare guide mode behind it, so that Left/Stop lands in the right place.
      renderCats();
      if (isFav) {
        selectCat(0, { channel: ch });
      } else if (ch.categoryId) {
        const ci = S.cats.findIndex((c) => c.id === String(ch.categoryId));
        if (ci >= 0) selectCat(ci, { channel: ch }).then(() => { if (!S.zapList) S.zapList = S.list; });
      }
    }

    // Back from full screen to guide mode – the video continues in the preview pane.
    function backToGuide() {
      const cur = P.kind() === 'live' ? P.current() : null;
      // The video continues in the pane – except when preview is turned off.
      if (cur && P.state() !== 'error' && previewMode() !== 'off') P.setMode('pane');
      else if (cur) P.stop();
      if (!S.cats.length) {
        open(true);
        return;
      }
      const i = cur ? S.list.findIndex((c) => sameCh(c, cur)) : -1;
      if (i >= 0) {
        focusRow(i);
        paneFor(S.list[i]);
      } else if (S.list.length) {
        focusRow(S.index);
        paneFor(S.list[S.index]);
      } else {
        open(true);
      }
    }

    // --- Events

    root.addEventListener('nav:focus', (e) => {
      const t = e.target;
      if (t.classList.contains('tv-row')) {
        const i = +t.getAttribute('data-i');
        S.index = i;
        paneFor(S.list[i]);
      } else if (t.classList.contains('tv-cat')) {
        const i = +t.getAttribute('data-ci');
        clearTimeout(catTimer);
        if (i !== S.catIndex) catTimer = setTimeout(() => selectCat(i), 300);
      }
    });

    root.addEventListener('nav:activate', (e) => {
      const t = e.target;
      const act = t.getAttribute('data-act');
      if (t.classList.contains('tv-row')) {
        activateRow(+t.getAttribute('data-i'));
      } else if (t.classList.contains('tv-cat')) {
        const i = +t.getAttribute('data-ci');
        clearTimeout(catTimer);
        if (i !== S.catIndex || S.listCat !== S.cats[i].id) selectCat(i, { focusList: true });
        else if (S.list.length) focusRow(S.index);
      } else if (act === 'settings') {
        Router.go('settings', { section: 'iptv-source' });
      } else if (act === 'retry') {
        IPTV.reload().then(() => open(true));
        message('loading');
      } else if (act === 'full') {
        const ch = S.list[S.index];
        if (ch) tune(ch, { list: S.list });
      } else if (act === 'fav') {
        toggleFav(S.list[S.index]);
      }
    });

    root.addEventListener('nav:longpress', (e) => {
      const t = e.target;
      if (t.classList.contains('tv-row')) channelMenu(+t.getAttribute('data-i'));
      else if (t.classList.contains('tv-cat')) catMenu(+t.getAttribute('data-ci'));
    });

    P.onState((s, detail, ch) => {
      if (!S.shown || full.visible || P.kind() !== 'live') return;
      const here = ch && q('.tv-pane').getAttribute('data-ch') === String(ch.id);
      // The pane shows the state of what is playing. "No signal" only when the cursor is on that channel.
      if (s === 'stopped' || (s === 'error' && !here)) paneState('idle');
      else if (P.mode() === 'pane') paneState(s);
      if (s === 'playing' || s === 'stopped' || s === 'error') { refreshRows(); updateNowPlaying(); }
    });

    // New data from the source (the hub/settings).
    IPTV.onChange((reason) => {
      if (reason === 'continue') return;
      if (reason !== 'favorites') Object.keys(listCache).forEach((k) => delete listCache[k]);
      // In full screen/detail page: guide mode is redrawn when you come back (resume).
      if (!S.shown || S.mode !== 'guide' || tab !== 'live' || topScreen()) return;
      const focusIn = Nav.current() && root.contains(Nav.current());
      const onCat = focusIn && Nav.current().classList.contains('tv-cat');
      if (root.classList.contains('has-message')) {
        open(focusIn);
        return;
      }
      const curCat = S.cats[S.catIndex];
      renderCats();
      if (curCat && curCat.kind === 'fav' && reason !== 'categories') {
        selectCat(S.catIndex, { reload: true, focusList: focusIn && !onCat });
      } else if (!S.cats[S.catIndex] || S.cats[S.catIndex].id !== (curCat && curCat.id)) {
        selectCat(S.catIndex, { focusList: focusIn && !onCat });
      } else {
        refreshRows();
        favBtn(S.list[S.index]);
      }
      if (onCat) Nav.focus(catEl(S.catIndex), { force: true });
    });

    IPTV.on('status', () => {
      if (S.shown && tab === 'live' && !topScreen() && root.classList.contains('has-message')) {
        open(Nav.current() && root.contains(Nav.current()));
      }
    });

    function tick(c) {
      if (S.mode === 'guide' && S.shown && S.list.length && tab === 'live') {
        refreshRows();
        scheduleEpg();
        const ch = S.list[S.index];
        if (ch && q('.tv-pane').getAttribute('data-ch') === String(ch.id)) fillPaneEpg(E.peek(ch));
      }
      full.tick(c);
    }

    // --- Keys (only in guide mode; full screen has its own handling)

    function onKey(name) {
      if (/^digit\d$/.test(name)) {
        if (!IPTV.configured()) return false;
        typeDigit(name.slice(5));
        return true;
      }
      if (name === 'back' && numBuf) {
        clearNumber();
        return true;
      }
      const cur = Nav.current();
      const inList = cur && cur.classList.contains('tv-row') && root.contains(cur);
      const inCats = cur && cur.classList.contains('tv-cat');
      const inPane = cur && cur.closest && cur.closest('.tv-pane-actions');

      if (inList) {
        switch (name) {
          case 'up':
            if (S.index === 0) { focusTabs(); return true; }
            moveIndex(-1);
            return true;
          case 'down': moveIndex(1); return true;
          case 'channelUp': moveIndex(-VISIBLE); return true;
          case 'channelDown': moveIndex(VISIBLE); return true;
          case 'left': {
            const c = catEl(S.catIndex);
            if (c) Nav.focus(c, { force: true });
            return true;
          }
          case 'right': {
            const btn = root.querySelector('.tv-pane-actions .btn');
            if (btn && !q('.tv-pane').classList.contains('is-empty')) Nav.focus(btn, { force: true });
            return true;
          }
          case 'yellow':
            toggleFav(S.list[S.index]);
            return true;
          default:
            return false;
        }
      }
      if (inCats) {
        const i = +cur.getAttribute('data-ci');
        if (name === 'right') {
          clearTimeout(catTimer);
          if (i !== S.catIndex || S.listCat !== S.cats[i].id) selectCat(i, { focusList: true });
          else if (S.list.length) focusRow(S.index);
          return true;
        }
        if (name === 'up' && i === 0) { focusTabs(); return true; }
        if (name === 'up' || name === 'down') {
          const j = clamp(i + (name === 'up' ? -1 : 1), 0, S.cats.length - 1);
          if (j !== i) Nav.focus(catEl(j), { force: true, dir: name });
          return true;
        }
        if (name === 'left') return true;
      }
      if (inPane) {
        if (name === 'left' && cur === root.querySelector('.tv-pane-actions .btn')) {
          focusRow(S.index);
          return true;
        }
        if (name === 'up') { focusTabs(); return true; }
        if (name === 'down') return true;
        if (name === 'yellow') {
          toggleFav(S.list[S.index]);
          return true;
        }
      }
      return false;
    }

    function enter() {
      if (root.classList.contains('has-message')) return q('.tv-message [data-focusable]');
      if (S.list.length) {
        scrollToIndex(S.index, true);
        renderWindow();
        return rows[S.index] || null;
      }
      return catEl(S.catIndex);
    }

    function hide() {
      S.shown = false;
      cancelZap();
      clearTimeout(previewTimer);
      clearTimeout(catTimer);
      clearNumber();
      if (P.mode() === 'pane') P.stop();
    }

    function stopPreview() {
      clearTimeout(previewTimer);
    }

    return {
      root,
      S,
      open,
      openChannel,
      backToGuide,
      tune,
      zap,
      toggleFav,
      typeDigit,
      clearNumber,
      cancelZap,
      commitZap,
      cancelBrowse,
      browsing: () => zapBrowse,
      previousChannel,
      hasNumber: () => !!numBuf,
      onKey,
      enter,
      hide,
      tick,
      stopPreview,
      setShown(v) { S.shown = v; },
      paneFor
    };
  })();

  registerTab('live', {
    show(params) {
      live.setShown(true);
      live.open(false);
      if (params && params.focus) setTimeout(enterTab, 0);
    },
    resume() {
      live.setShown(true);
      live.open(false);
    },
    hide: live.hide,
    enter: live.enter,
    onKey: live.onKey
  });

  // =======================================================================================
  // Full screen (live)
  // =======================================================================================

  const full = (function () {
    const root = document.createElement('div');
    root.className = 'tv-full';
    root.hidden = true;
    root.innerHTML =
      '<div class="tv-full-shade"></div>' +
      '<div class="tv-full-state"></div>' +
      '<div class="tv-full-clock tabular"></div>' +
      '<div class="tv-banner glass">' +
        '<div class="tv-banner-logo"></div>' +
        '<div class="tv-banner-main">' +
          '<div class="tv-banner-top"><span class="tv-banner-num tabular"></span><span class="tv-banner-name"></span><span class="tv-banner-fav"></span></div>' +
          '<div class="tv-banner-title"></div>' +
          '<div class="tv-banner-meta"><span class="tv-banner-time tabular"></span><span class="progress"><i></i></span><span class="tv-banner-left"></span></div>' +
          '<div class="tv-banner-next"></div>' +
        '</div>' +
        '<div class="tv-banner-hints">' +
          '<span><b>▲▼</b> ' + tr('tv.banner.changeChannel') + '</span><span><b class="k-dot k-blue"></b> ' + tr('tv.banner.previous') + '</span>' +
          '<span><b>OK</b> ' + tr('tv.banner.channelList') + '</span><span><b class="k-dot k-green"></b> ' + tr('tv.banner.audioSubtitles') + '</span>' +
          '<span><b class="k-yellow"></b> ' + tr('tv.favourite') + '</span><span><b class="k-dot k-red"></b> ' + tr('tv.options') + '</span>' +
        '</div>' +
        '<div class="tv-banner-browse"><span><b>OK</b> ' + tr('tv.banner.switchToChannel') + '</span><span><b>▲▼</b> ' + tr('tv.banner.browse') + '</span><span><b>' + tr('common.back') + '</b> ' + tr('common.cancel') + '</span></div>' +
      '</div>';
    screensHost.appendChild(root);
    const q = (sel) => root.querySelector(sel);

    let bannerTimer = null;
    let bannerCh = null;   // the channel the banner shows (the one playing, or one you have browsed to)
    let stateTimer = null;
    let scr = null;
    let origin = 'live';   // the tab you came from (Back goes there)

    const api = {
      visible: false,
      open(ch) {
        if (!scr) {
          origin = tab;
          scr = pushScreen({
            name: 'full',
            el: root,
            onKey,
            onClose() {
              api.visible = false;
              scr = null;
              if (IPTV.chlist) IPTV.chlist.close();
              hideBanner();
              root.hidden = true;
            }
          });
        }
        api.visible = true;
        live.stopPreview();
        P.play(ch, { mode: 'full' });
        state(P.state());
        showBanner(ch);
      },
      close(toGuide) {
        if (!scr) return;
        live.clearNumber();
        live.cancelZap();
        popScreen();
        if (toGuide) {
          if (tab !== 'live') setTab('live');
          live.backToGuide();
        }
      },
      tick(c) {
        q('.tv-full-clock').textContent = c.time;
        if (api.visible && q('.tv-banner').classList.contains('is-on') && bannerCh) fillEpg(E.peek(bannerCh));
      },
      epgUpdated(set) {
        if (bannerCh && set[String(bannerCh.id)]) fillEpg(E.peek(bannerCh));
      },
      showBanner,
      hideBanner
    };

    function state(s) {
      const box = q('.tv-full-state');
      clearTimeout(stateTimer);
      if (s === 'loading' || s === 'buffering') {
        // The spinner only shows after a short while, so quick switches do not flicker.
        box.innerHTML = '';
        stateTimer = setTimeout(() => {
          if (P.state() === 'loading' || P.state() === 'buffering') box.innerHTML = '<div class="spinner spinner-lg"></div>';
        }, 450);
      } else if (s === 'error') {
        box.innerHTML =
          '<div class="tv-nosignal tv-nosignal-lg">' + u.icon('signal') +
          '<span>' + tr('tv.noSignal') + '</span><span class="tv-dim">' + tr('tv.pressOkToRetry') + '</span></div>';
      } else if (s === 'paused') {
        box.innerHTML = '<div class="tv-paused glass">' + u.icon('pause') + '</div>';
      } else {
        box.innerHTML = '';
      }
    }

    function showBanner(ch, keep, browse) {
      ch = ch || P.current();
      if (!ch) return;
      const b = q('.tv-banner');
      bannerCh = ch;
      b.classList.toggle('is-browse', !!browse);
      b.setAttribute('data-ch', String(ch.id));
      q('.tv-banner-logo').innerHTML = u.logo(ch, '', 320);
      q('.tv-banner-num').textContent = ch.num != null ? ch.num : '';
      q('.tv-banner-name').textContent = ch.name;
      q('.tv-banner-fav').innerHTML = IPTV.isFavorite(ch.id) ? u.icon('star-fill') : '';
      const nn = E.nowNext(ch);
      fillEpg(nn.pending && !nn.now ? null : nn);
      q('.tv-full-clock').textContent = clockText().time;
      b.classList.add('is-on');
      root.classList.add('has-banner');
      clearTimeout(bannerTimer);
      if (!keep) bannerTimer = setTimeout(hideBanner, bannerMs());
    }

    function fillEpg(nn) {
      const now = nn && nn.now;
      const next = nn && nn.next;
      q('.tv-banner-title').textContent = now ? now.title : nn ? NO_GUIDE : '';
      q('.tv-banner-meta').style.visibility = now ? '' : 'hidden';
      q('.tv-banner-time').textContent = now ? u.time(now.start) + '–' + u.time(now.end) : '';
      q('.tv-banner-left').textContent = now ? u.minutesLeft(now) : '';
      q('.tv-banner-meta .progress i').style.setProperty('--p', (now ? Math.round(E.progress(now) * 100) : 0) + '%');
      q('.tv-banner-next').innerHTML = next ? '<span class="tv-dim">' + tr('tv.next', { time: u.time(next.start) }) + '</span>  ' + esc(next.title) : '';
    }

    function hideBanner() {
      clearTimeout(bannerTimer);
      q('.tv-banner').classList.remove('is-on', 'is-browse');
      root.classList.remove('has-banner');
    }

    function onKey(name) {
      // The channel list on top of the video takes the keys first (see chlist.js).
      if (IPTV.chlist && IPTV.chlist.isOpen() && IPTV.chlist.onKey(name)) return true;
      if (/^digit\d$/.test(name)) {
        live.typeDigit(name.slice(5));
        return true;
      }
      if (name === 'back' && live.hasNumber()) {
        live.clearNumber();
        return true;
      }
      // Browse mode (▲▼ only shows the channel): OK switches, Back cancels, anything else cancels first.
      if (live.browsing()) {
        if (name === 'enter') { live.commitZap(); return true; }
        if (name === 'back') { live.cancelBrowse(); return true; }
        if (name !== 'up' && name !== 'down' && name !== 'channelUp' && name !== 'channelDown') live.cancelBrowse();
      }
      switch (name) {
        case 'up':
        case 'channelUp':
          live.zap(1);
          return true;
        case 'down':
        case 'channelDown':
          live.zap(-1);
          return true;
        case 'enter':
          // As in TiviMate: OK shows the channel list (browse without switching).
          if (P.state() === 'error') P.retry();
          else if (P.state() === 'paused') P.resume();
          else if (IPTV.chlist) { hideBanner(); IPTV.chlist.open(); }
          else showBanner();
          return true;
        case 'info':
        case 'right':
          showBanner();
          return true;
        case 'yellow': {
          const ch = P.current();
          live.toggleFav(ch);
          setTimeout(() => showBanner(ch), 30);
          return true;
        }
        case 'pause':
          P.pause();
          showBanner(null, true);
          return true;
        case 'play':
          P.resume();
          showBanner();
          return true;
        case 'left':
          if (IPTV.chlist) { hideBanner(); IPTV.chlist.open(); return true; }
          api.close(true);
          return true;
        case 'blue':
          live.previousChannel();
          return true;
        case 'green':
          IPTV.options.tracksMenu();
          return true;
        case 'red': {
          const ch = P.current();
          const prev = IPTV.recent().find((c) => !sameCh(c, ch));
          IPTV.options.menu({
            title: ch ? ch.name : tr('tv.options'),
            before: prev ? [{ label: tr('tv.previousChannel'), detail: prev.name, action: live.previousChannel }] : [],
            after: IPTV.reminders && IPTV.reminders.menuItems ? IPTV.reminders.menuItems(ch) : []
          });
          return true;
        }
        case 'stop':
          api.close(true);
          return true;
        case 'back':
          if (fromHome) {
            fromHome = false;
            api.close(false);
            Router.back();
          } else {
            // Back to where you were (e.g. Search); from guide mode the video continues in the pane.
            api.close(origin === 'live');
          }
          return true;
        default:
          return name === 'left';
      }
    }

    // Magic Remote: a click shows/hides the info panel.
    root.addEventListener('click', () => {
      if (P.state() === 'error') P.retry();
      else if (q('.tv-banner').classList.contains('is-on')) hideBanner();
      else showBanner();
    });

    P.onState((s, detail, ch) => {
      if (!api.visible || P.kind() !== 'live') return;
      state(s);
      if (s === 'error') showBanner(ch, true);
    });

    return api;
  })();

  // =======================================================================================
  // The view
  // =======================================================================================

  el.addEventListener('nav:focus', (e) => {
    const t = e.target;
    if (!t.classList.contains('tv-tab')) return;
    const name = t.getAttribute('data-tab');
    clearTimeout(tabTimer);
    // Default: the cursor only moves – OK (or ▼) switches tab.
    if (name && name !== tab && tabOnFocus()) tabTimer = setTimeout(() => setTab(name), 220);
  });

  el.addEventListener('nav:activate', (e) => {
    const t = e.target;
    if (!t.classList.contains('tv-tab')) return;
    clearTimeout(tabTimer);
    if (t.getAttribute('data-act') === 'iptv-settings') {
      openSettings();
      return;
    }
    const name = t.getAttribute('data-tab');
    if (name !== tab) setTab(name);
    enterTab();
  });

  // The TV app's own settings (the same pages as Settings › IPTV). Back leads here again.
  function openSettings(section) {
    Router.go('settings', { section: section || 'iptv', root: true });
  }

  function onKey(name, e) {
    if (!name) {
      const t = tabs[tab];
      return !!(t && t.onKey && !topScreen() && t.onKey(name, e));
    }
    const scr = topScreen();
    if (scr) {
      if (scr.onKey && scr.onKey(name, e) === true) return true;
      if (name === 'back') {
        popScreen();
        return true;
      }
      return false;
    }
    const cur = Nav.current();
    const onTab = cur && cur.classList.contains('tv-tab');
    if (onTab) {
      if (name === 'down') {
        clearTimeout(tabTimer);
        const n = cur.getAttribute('data-tab');
        if (n && n !== tab) setTab(n);
        enterTab();
        return true;
      }
      if (name === 'up') return true;
      if (name === 'back') {
        // The cursor is on a tab other than the one shown: back to the one shown.
        if (cur.getAttribute('data-tab') !== tab) { focusTabs(); return true; }
        return false; // -> Router.back()
      }
      if (/^digit\d$/.test(name) && tab === 'live') return live.onKey(name, e);
      return false;
    }
    const t = tabs[tab];
    if (t && t.onKey && t.onKey(name, e) === true) return true;
    // Back from inside a tab: first up to the tab bar.
    if (name === 'back') {
      focusTabs();
      return true;
    }
    return false;
  }

  function handleParams(params) {
    params = params || {};
    if (params.channel && params.fullscreen !== false) {
      // Back from full screen: to the TV app (default) or straight to the home screen.
      fromHome = backToHome();
      if (tab !== 'live') setTab('live');
      else live.setShown(true);
      if (!IPTV.configured()) {
        fromHome = false;
        live.open(true);
        return;
      }
      live.openChannel(params.channel);
      return;
    }
    fromHome = false;
    if (params.item && IPTV.media) {
      const name = params.item.kind === 'vod' || params.item.kind === 'movie' ? 'movies' : 'series';
      setTab(name);
      if (params.play) IPTV.media.resume(params.item, { fromHome: backToHome() });
      else IPTV.media.openDetail(params.item.kind === 'episode' ? 'series' : name === 'movies' ? 'vod' : 'series',
        params.item.kind === 'episode' && params.item.seriesId ? { id: params.item.seriesId, title: params.item.seriesTitle } : params.item, { fromHome: backToHome() });
      return;
    }
    const name = params.tab && tabs[params.tab] ? params.tab : tab;
    setTab(name, params);
    requestAnimationFrame(() => {
      if (!topScreen()) {
        if (params.tab === 'search') enterTab();
        else focusTabs();
      }
    });
  }

  Router.register('tv', {
    el,
    show(params) {
      visible = true;
      el.classList.remove('view-enter');
      void el.offsetWidth;
      el.classList.add('view-enter');
      // Is the home screen already playing the channel in the background? Continue seamlessly in full screen.
      if (!(params && params.channel && P.kind() === 'live' && sameCh(P.current(), params.channel))) IPTV.preview.stop();
      clearInterval(clockTimer);
      tick();
      clockTimer = setInterval(tick, 15000);
      closeAllScreens();
      handleParams(params);
    },
    resume() {
      visible = true;
      tick();
      clearInterval(clockTimer);
      clockTimer = setInterval(tick, 15000);
      if (!topScreen() && tabs[tab] && tabs[tab].resume) tabs[tab].resume();
    },
    hide() {
      visible = false;
      clearInterval(clockTimer);
      clearTimeout(tabTimer);
      closeAllScreens();
      Object.keys(tabs).forEach((k) => { if (tabs[k].hide) tabs[k].hide(); });
      P.stop();
      fromHome = false;
    },
    onKey
  });

  // --- Public ------------------------------------------------------------------------------

  IPTV.ui = {
    el,
    registerTab,
    setTab,
    tab: () => tab,
    focusTabs,
    enterTab,
    pushScreen,
    popScreen,
    topScreen,
    isVisible: () => visible,
    openSettings,
    fromHome: () => fromHome,
    setFromHome: (v) => { fromHome = !!v; }
  };
  IPTV.live = live;
  IPTV.full = full;

  IPTV.open = (params) => Router.go('tv', params || {});
  IPTV.openItem = (p) => {
    if (!p) return;
    Router.go('tv', { item: p, play: true });
  };
})(window);
