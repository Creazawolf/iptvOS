/*
 * Guide: channels in rows, time in columns (like a classic TV guide), with info about the
 * programme you are on at the top.
 *
 *   ← →        previous/next programme (the time window moves along)
 *   ↑ ↓        channel up/down (same time)     CH+/CH−  one page at a time
 *   OK         on now: watch · upcoming: reminder on/off · past: catch-up (if the channel has it)
 *   Hold OK    menu (watch, from the start, reminder, favourite)    Yellow  favourite on/off
 *   Back       jump to "now" · again: the tab bar
 *
 * Its own key handling (not spatial navigation), so that it stays fast even with
 * hundreds of channels: only the visible rows are drawn.
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const u = IPTV.u;
  const esc = u.esc;

  const ROWS = 7;               // visible rows
  const ROW_H = 92;             // px per row (incl. spacing)
  const CH_W = 300;             // the channel column
  const LINE_W = 1920 - 80 - 80 - CH_W - 16; // width of the timeline
  const WINDOW = 150;           // minutes shown
  const PX = LINE_W / WINDOW;   // px per minute
  const CHUNK = 30;             // channels per fetch
  const SPAN_H = 4;             // hours per fetch
  const MIN = 60000;

  const root = IPTV.ui.el.querySelector('[data-pane="guide"]');
  root.innerHTML =
    '<div class="gd">' +
      '<div class="gd-info">' +
        '<div class="gd-info-logo"></div>' +
        '<div class="gd-info-text">' +
          '<p class="gd-info-meta"></p>' +
          '<h2 class="gd-info-title"></h2>' +
          '<p class="gd-info-desc"></p>' +
        '</div>' +
        '<button class="btn gd-cat" data-focusable>' + u.icon('list') + '<span></span></button>' +
      '</div>' +
      '<div class="gd-grid">' +
        '<div class="gd-times"></div>' +
        '<div class="gd-rows"></div>' +
        '<div class="gd-now"></div>' +
      '</div>' +
      '<p class="gd-empty" hidden></p>' +
    '</div>';

  const $ = (sel) => root.querySelector(sel);
  const rowsEl = $('.gd-rows');
  const timesEl = $('.gd-times');
  const nowEl = $('.gd-now');
  const catBtn = $('.gd-cat');

  const S = {
    cat: 'favorites',
    catName: tr('guide.favourites'),
    total: 0,
    channels: [],        // all channels in the category (filled in chunks)
    programs: {},        // id -> [Program] (sorted)
    loaded: {},          // "offset:from" -> true
    from: 0,             // start of the time window (ms)
    row: 0,              // selected channel
    top: 0,              // first visible row
    t: 0,                // the cursor's time (ms)
    cursor: null,        // focused programme cell
    shown: false,
    token: 0
  };

  // The visible rows, per channel index: { el, ch, line } – reused so that only what has changed
  // (the cursor, the time window, new programmes) is rewritten. The logos are left alone while browsing.
  let rowEls = new Map();

  const floor30 = (ms) => Math.floor(ms / (30 * MIN)) * 30 * MIN;
  const bucket = (ms) => Math.floor(ms / (SPAN_H * 3600000));

  // --- Data -----------------------------------------------------------------------------

  function chunkKey(offset, from) { return offset + ':' + bucket(from); }

  function load(offset, from) {
    offset = Math.max(0, Math.floor(offset / CHUNK) * CHUNK);
    const start = bucket(from) * SPAN_H * 3600000;
    const key = chunkKey(offset, start);
    if (S.loaded[key]) return S.loaded[key];
    const token = S.token;
    S.loaded[key] = IPTV.source.grid({ category: S.cat, from: start, hours: SPAN_H, offset, limit: CHUNK })
      .then((r) => {
        if (token !== S.token || !r) return;
        S.total = r.total || 0;
        (r.channels || []).forEach((c, i) => { S.channels[offset + i] = c; });
        const progs = r.programs || {};
        Object.keys(progs).forEach((id) => {
          const old = S.programs[id] || [];
          const seen = {};
          old.concat(progs[id] || []).forEach((p) => { seen[p.start + '|' + p.title] = p; });
          S.programs[id] = Object.keys(seen).map((k) => seen[k]).sort((a, b) => a.start - b.start);
        });
        render();
      })
      .catch((e) => {
        delete S.loaded[key];
        if (token === S.token) showEmpty(e.friendly ? e.message : tr('guide.loadFailed'));
      });
    return S.loaded[key];
  }

  // Make sure what is visible (and a bit more) has been fetched.
  function ensure() {
    load(S.top, S.from);
    load(S.top + ROWS, S.from);
    if (S.from + WINDOW * MIN > (bucket(S.from) + 1) * SPAN_H * 3600000) load(S.top, S.from + WINDOW * MIN);
  }

  function reset(cat, name) {
    S.token++;
    S.cat = cat;
    S.catName = name;
    S.total = 0;
    S.channels = [];
    S.programs = {};
    S.loaded = {};
    S.row = 0;
    S.top = 0;
    S.from = floor30(Date.now()) - 30 * MIN;
    S.t = Date.now();
    catBtn.querySelector('span').textContent = name;
    $('.gd-empty').hidden = true;
    rowsEl.innerHTML = '';
    rowEls = new Map();
    ensure();
  }

  // --- Drawing ----------------------------------------------------------------------------

  const x = (ms) => (ms - S.from) / MIN * PX;

  function programAt(id, t) {
    const list = S.programs[id] || [];
    for (let i = 0; i < list.length; i++) if (list[i].start <= t && list[i].end > t) return list[i];
    return null;
  }

  function renderTimes() {
    let html = '';
    for (let t = S.from; t <= S.from + WINDOW * MIN; t += 30 * MIN) {
      html += '<span style="left:' + Math.round(x(t)) + 'px">' + u.time(t) + '</span>';
    }
    if (timesEl._html !== html) {
      timesEl._html = html;
      timesEl.innerHTML = html;
    }
    const now = Date.now();
    const nx = x(now);
    nowEl.hidden = nx < 0 || nx > LINE_W;
    nowEl.style.transform = 'translate3d(' + Math.round(CH_W + 16 + nx) + 'px,0,0)';
  }

  function cellHtml(c, p, rowIdx, selected) {
    const a = Math.max(x(p.start), 0);
    const b = Math.min(x(p.end), LINE_W);
    if (b <= 0 || a >= LINE_W) return '';
    const w = Math.max(b - a - 6, 4);
    const now = Date.now();
    const live = p.start <= now && p.end > now;
    const past = p.end <= now;
    const cu = past && IPTV.catchup && IPTV.catchup.available(c, p);
    const rem = !past && !live && IPTV.reminders && IPTV.reminders.has(c, p);
    const cls = 'gd-prog' + (live ? ' is-live' : '') + (past ? ' is-past' : '') + (cu ? ' is-catchup' : '') + (rem ? ' is-reminder' : '') +
      (selected ? ' is-cursor' : '') + (w < 90 ? ' is-narrow' : '');
    return '<div class="' + cls + '"' + (selected ? ' data-focusable' : '') + ' data-row="' + rowIdx + '" data-start="' + p.start + '"' +
      ' style="left:' + Math.round(a) + 'px;width:' + Math.round(w) + 'px">' +
      '<b>' + (cu ? '<i class="gd-mark">↺</i>' : rem ? '<i class="gd-mark">' + u.icon('bell') + '</i>' : '') + esc(p.title || '') + '</b>' +
      (w >= 160 ? '<small>' + u.time(p.start) + '–' + u.time(p.end) + '</small>' : '') +
      '</div>';
  }

  function render() {
    if (!S.shown) return;
    renderTimes();
    const end = Math.min(S.top + ROWS, Math.max(S.total, S.channels.length));
    const next = new Map();
    for (let r = S.top; r < end; r++) {
      const c = S.channels[r];
      const sel = r === S.row;
      let cells = '';
      if (c) {
        const list = S.programs[c.id] || [];
        const cur = sel ? programAt(c.id, S.t) : null;
        list.forEach((p) => { cells += cellHtml(c, p, r, cur === p); });
        if (sel && !cur) {
          // No programme at the cursor: an empty cell you can still stand on.
          cells += '<div class="gd-prog is-none is-cursor" data-focusable data-row="' + r + '" style="left:' +
            Math.round(Math.max(x(S.t) - 60, 0)) + 'px;width:180px"><b>' + (list.length ? tr('guide.noProgramme') : tr('guide.noGuide')) + '</b></div>';
        }
      }
      const chHtml = (c && c.logo ? '<img src="' + esc(IPTV.source.img(c.logo, 160)) + '" alt="" loading="lazy" onerror="this.remove()">' : '') +
        '<span><i>' + (c && c.num != null ? c.num : '') + '</i>' + esc(c ? c.name : '…') + (c && IPTV.isFavorite(c.id) ? ' <em>★</em>' : '') + '</span>';
      let R = rowEls.get(r);
      if (!R) {
        R = { el: document.createElement('div'), ch: null, line: null, y: null };
        R.el.className = 'gd-row';
        R.el.innerHTML = '<div class="gd-ch"></div><div class="gd-line"></div>';
        rowsEl.appendChild(R.el);
      }
      const y = (r - S.top) * ROW_H;
      if (R.y !== y) { R.el.style.transform = 'translate3d(0,' + y + 'px,0)'; R.y = y; }
      R.el.classList.toggle('is-selected', sel);
      if (R.ch !== chHtml) { R.el.firstChild.innerHTML = chHtml; R.ch = chHtml; }
      if (R.line !== cells) { R.el.lastChild.innerHTML = cells; R.line = cells; }
      next.set(r, R);
    }
    rowEls.forEach((R, r) => { if (!next.has(r)) R.el.remove(); });
    rowEls = next;
    S.cursor = rowsEl.querySelector('.is-cursor');
    const cur = Nav.current();
    if (S.cursor && S.focusGrid && (!cur || !document.contains(cur) || root.contains(cur))) Nav.focus(S.cursor, { force: true });
    renderInfo();
    if (!S.total && !S.channels.length && Object.keys(S.loaded).length) {
      // Finished loading but empty?
      Promise.all(Object.keys(S.loaded).map((k) => S.loaded[k])).then(() => {
        if (!S.total && S.shown) showEmpty(S.cat === 'favorites' ? tr('guide.noFavourites') : tr('guide.noChannels'));
      });
    }
  }

  function renderInfo() {
    const c = S.channels[S.row];
    const p = c ? programAt(c.id, S.t) : null;
    const logo = $('.gd-info-logo');
    const logoUrl = c && c.logo ? IPTV.source.img(c.logo, 320) : '';
    if (logo.getAttribute('data-url') !== logoUrl) {
      logo.setAttribute('data-url', logoUrl);
      logo.innerHTML = logoUrl ? '<img src="' + esc(logoUrl) + '" alt="" onerror="this.remove()">' : '';
    }
    const now = Date.now();
    let meta = c ? esc(c.name) : '';
    if (p) {
      meta += ' · ' + u.time(p.start) + '–' + u.time(p.end);
      if (p.start <= now && p.end > now) meta += ' · <span class="gd-live">' + tr('guide.onNow') + '</span> · ' + tr('guide.minutesLeft', { n: Math.max(1, Math.round((p.end - now) / MIN)) });
      else if (p.start > now) meta += ' · ' + tr('guide.startsIn', { time: rel(p.start - now) });
    }
    $('.gd-info-meta').innerHTML = meta;
    $('.gd-info-title').textContent = p ? p.title : (c ? tr('guide.noInfo') : '');
    $('.gd-info-desc').textContent = p && p.desc ? p.desc : '';
  }

  function rel(ms) {
    const m = Math.round(ms / MIN);
    if (m < 60) return tr('common.minutesShort', { n: m });
    const h = Math.floor(m / 60);
    return tr('guide.hoursShort', { n: h }) + (m % 60 ? ' ' + tr('common.minutesShort', { n: m % 60 }) : '');
  }

  function showEmpty(text) {
    const e = $('.gd-empty');
    e.textContent = text;
    e.hidden = false;
  }

  // --- Movement ---------------------------------------------------------------------------

  function keepInView() {
    if (S.row < S.top) S.top = S.row;
    if (S.row >= S.top + ROWS) S.top = S.row - ROWS + 1;
    // Cursor outside the time window: move the window in half-hour steps.
    while (S.t < S.from + 10 * MIN) S.from -= 30 * MIN;
    while (S.t > S.from + (WINDOW - 20) * MIN) S.from += 30 * MIN;
    ensure();
  }

  function moveRow(d) {
    const max = Math.max(S.total, S.channels.length) - 1;
    const next = Math.min(Math.max(S.row + d, 0), Math.max(max, 0));
    if (next === S.row) return false;
    S.row = next;
    keepInView();
    render();
    return true;
  }

  function moveTime(d) {
    const c = S.channels[S.row];
    const list = c ? S.programs[c.id] || [] : [];
    const cur = c ? programAt(c.id, S.t) : null;
    let target = null;
    if (d > 0) {
      const after = cur ? cur.end : S.t;
      target = list.find((p) => p.start >= after - 1000);
      S.t = target ? Math.max(target.start, S.t + MIN) + MIN : S.t + 30 * MIN;
    } else {
      const before = cur ? cur.start : S.t;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].end <= before + 1000) { target = list[i]; break; }
      S.t = target ? target.start + MIN : S.t - 30 * MIN;
    }
    // No more than one day back or two days ahead.
    const now = Date.now();
    S.t = Math.min(Math.max(S.t, now - 24 * 3600000), now + 48 * 3600000);
    keepInView();
    render();
  }

  function jumpNow() {
    S.t = Date.now();
    S.from = floor30(S.t) - 30 * MIN;
    keepInView();
    render();
  }

  function watchLive(c) {
    // Full screen on top of the guide – Back lands here again. ▲▼ zaps through the guide's channels.
    IPTV.ui.setFromHome(false);
    IPTV.live.tune(c, { list: S.channels.filter(Boolean) });
  }

  function activate() {
    const c = S.channels[S.row];
    if (!c) return;
    const p = programAt(c.id, S.t);
    const now = Date.now();
    if (p && p.end <= now) {
      // Past: catch-up if the channel has it, otherwise live.
      if (IPTV.catchup.available(c, p)) { IPTV.catchup.play(c, p); return; }
      UI.toast(tr('guide.noCatchupShowingLive', { name: c.name }), 3500);
      watchLive(c);
      return;
    }
    if (p && p.start > now) {
      IPTV.reminders.toggle(c, p);
      render();
      return;
    }
    watchLive(c);
  }

  // Hold OK: everything you can do with the programme.
  function programMenu() {
    const c = S.channels[S.row];
    if (!c) return;
    const p = programAt(c.id, S.t);
    const now = Date.now();
    const fav = IPTV.isFavorite(c.id);
    const items = [{ label: tr('guide.menu.watchChannel', { name: c.name }), detail: tr('guide.menu.live'), action: () => watchLive(c) }];
    if (p && p.start < now && IPTV.catchup.available(c, p)) {
      items.push({ label: p.end <= now ? tr('guide.menu.watchCatchup') : tr('guide.menu.watchFromStart'), detail: p.title, action: () => IPTV.catchup.play(c, p) });
    }
    if (p && p.start > now) {
      items.push({ label: IPTV.reminders.has(c, p) ? tr('guide.menu.removeReminder') : tr('guide.menu.remindMe'), detail: u.time(p.start) + ' ' + p.title, action: () => { IPTV.reminders.toggle(c, p); render(); } });
    }
    items.push({ label: fav ? tr('guide.menu.removeFavourite') : tr('guide.menu.addFavourite'), danger: fav, action: toggleFav });
    UI.menu({ title: p ? p.title : c.name, subtitle: c.name + (p ? ' · ' + u.time(p.start) + '–' + u.time(p.end) : ''), items });
  }

  function toggleFav() {
    const c = S.channels[S.row];
    if (!c) return;
    const was = IPTV.isFavorite(c.id);
    Promise.resolve(IPTV.toggleFavorite(c)).then(() => {
      UI.toast(was ? tr('guide.favRemoved', { name: c.name }) : tr('guide.favAdded', { name: c.name }));
      render();
    });
  }

  function chooseCategory() {
    const items = [{ label: tr('guide.favourites'), detail: String(IPTV.favorites().length), action: () => { reset('favorites', tr('guide.favourites')); focusGrid(); } }];
    IPTV.categories('live').forEach((cat) => {
      items.push({ label: cat.name, detail: cat.count != null ? String(cat.count) : '', action: () => { reset(String(cat.id), cat.name); focusGrid(); } });
    });
    UI.menu({ title: tr('guide.guideFor'), items });
  }

  function focusGrid() {
    S.focusGrid = true;
    render();
    // Nothing fetched yet: stay on the category button until the rows arrive (render() moves focus then).
    return S.cursor || catBtn;
  }

  // --- Tab lifecycle -------------------------------------------------------------------------

  catBtn.addEventListener('nav:activate', chooseCategory);
  rowsEl.addEventListener('nav:activate', (e) => { if (e.target.closest('.gd-prog')) activate(); });
  rowsEl.addEventListener('nav:longpress', (e) => { if (e.target.closest('.gd-prog')) programMenu(); });

  let nowTimer = null;

  IPTV.ui.registerTab('guide', {
    el: root,
    show() {
      S.shown = true;
      if (!S.from) reset('favorites', tr('guide.favourites'));
      else if (Date.now() - S.t > 30 * MIN && S.t < Date.now()) jumpNow();
      else render();
      clearInterval(nowTimer);
      nowTimer = setInterval(() => { if (S.shown) { renderTimes(); renderInfo(); } }, 30000);
    },
    resume() {
      // Back from full screen: no video behind the guide.
      if (IPTV.player.mode() !== 'off') IPTV.player.stop();
      render();
    },
    hide() {
      S.shown = false;
      S.focusGrid = false;
      clearInterval(nowTimer);
    },
    enter() { return focusGrid(); },
    onKey(name) {
      const cur = Nav.current();
      if (!cur || !root.contains(cur)) return false;
      if (cur === catBtn) {
        if (name === 'down') { const f = focusGrid(); if (f && f !== catBtn) Nav.focus(f, { force: true }); return true; }
        if (name === 'left' || name === 'right') return true;
        return false;
      }
      switch (name) {
        case 'up':
          if (S.row === 0) { S.focusGrid = false; Nav.focus(catBtn, { force: true, dir: 'up' }); return true; }
          moveRow(-1);
          return true;
        case 'down': moveRow(1); return true;
        case 'channelUp': moveRow(-ROWS); return true;
        case 'channelDown': moveRow(ROWS); return true;
        case 'left': moveTime(-1); return true;
        case 'right': moveTime(1); return true;
        case 'yellow': toggleFav(); return true;
        case 'back':
          if (Math.abs(S.t - Date.now()) > 15 * MIN || S.row > 0) {
            S.row = 0;
            S.top = 0;
            jumpNow();
            return true;
          }
          S.focusGrid = false;
          IPTV.ui.focusTabs();
          return true;
      }
      return false;
    }
  });

  // New favourites/categories: reload if the guide shows favourites.
  IPTV.onChange((reason) => {
    if (S.cat === 'favorites' && (reason === 'favorites' || reason === 'bootstrap' || reason === 'remote') && S.from) {
      const keep = { row: S.row, t: S.t, from: S.from };
      reset('favorites', tr('guide.favourites'));
      S.row = Math.min(keep.row, Math.max(IPTV.favorites().length - 1, 0));
      S.t = keep.t;
      S.from = keep.from;
      keepInView();
      if (S.shown) render();
    }
  });
})(window);
