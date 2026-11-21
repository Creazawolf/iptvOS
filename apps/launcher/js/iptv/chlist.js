/*
 * Channel list on top of the video in full screen (as in TiviMate): browse without switching, OK switches.
 *
 *   OK or ◀ (in full screen)  open the list, with the playing channel selected
 *   ▲ ▼  /  CH+ CH−           browse (one row / one page) – the video keeps playing as usual
 *   OK                        switch to the selected channel (the list stays open) · on the playing channel: close
 *   ◀                         groups (Favourites, Recently watched, your categories)
 *   ▶                         upcoming programmes for the selected channel
 *   Yellow                    favourite on/off
 *   Back                      close (step by step)
 *
 * The list hides itself after a while without a key press.
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const P = IPTV.player;
  const E = IPTV.epg;
  const u = IPTV.u;
  const esc = u.esc;

  const ROWS = 9;
  const HIDE_MS = 12000;

  const host = document.querySelector('.tv-full');
  if (!host) return;

  const root = document.createElement('aside');
  root.className = 'chl';
  root.hidden = true;
  root.innerHTML =
    '<div class="chl-groups glass"><h3>' + tr('chlist.groups') + '</h3><div class="chl-glist"></div></div>' +
    '<div class="chl-main glass">' +
      '<header class="chl-head"><span class="chl-gname"></span><span class="chl-count"></span></header>' +
      '<div class="chl-list"></div>' +
      '<footer class="chl-hint"><span><b>OK</b> ' + tr('chlist.hint.switch') + '</span><span><b>◀</b> ' + tr('chlist.groups') + '</span><span><b>▶</b> ' + tr('chlist.hint.guide') + '</span><span><b class="k-yellow"></b> ' + tr('chlist.hint.favourite') + '</span></footer>' +
    '</div>' +
    '<div class="chl-detail glass"><h3></h3><div class="chl-progs"></div></div>';
  host.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const listEl = $('.chl-list');
  const glistEl = $('.chl-glist');

  const S = {
    open: false,
    pane: 'list',       // 'list' | 'groups' | 'detail'
    groups: [],
    gi: 0,              // selected group in the group list
    group: null,        // active group { id, name }
    list: [],
    sel: 0,
    token: 0,
    hideTimer: null,
    detailFor: null
  };
  const cache = {};     // group id -> [Channel]
  let rowEls = new Map(); // list index -> { el, html } (the rows shown right now)
  const guideCache = new Map(); // channel id -> { at, promise } (upcoming programmes)
  let detailTimer = null;

  const same = (a, b) => !!a && !!b && String(a.id) === String(b.id);
  const NO_GUIDE = tr('chlist.noGuide'); // row HTML is built often: look it up once

  // --- Groups and lists --------------------------------------------------------------------

  function buildGroups() {
    const g = [];
    if (IPTV.favorites().length) g.push({ id: 'favorites', name: tr('chlist.favourites'), icon: 'star' });
    if (IPTV.recent && IPTV.recent().length) g.push({ id: 'recent', name: tr('chlist.recent'), icon: 'clock' });
    IPTV.categories('live').forEach((c) => g.push({ id: String(c.id), name: c.name, count: c.count }));
    S.groups = g;
  }

  function channelsOf(group) {
    if (group.id === 'favorites') return Promise.resolve(IPTV.favorites());
    if (group.id === 'recent') return Promise.resolve(IPTV.recent());
    if (cache[group.id]) return Promise.resolve(cache[group.id]);
    return IPTV.source.channels(group.id).then((list) => (cache[group.id] = list || []));
  }

  // The group the playing channel belongs to (the same list that ▲▼ zapping uses).
  function currentGroup(ch) {
    const zap = IPTV.live && IPTV.live.S && IPTV.live.S.zapList;
    if (ch && IPTV.isFavorite(ch.id) && (!zap || zap === IPTV.favorites() || zap.length === IPTV.favorites().length)) {
      return S.groups.find((g) => g.id === 'favorites');
    }
    if (ch && ch.categoryId) {
      const g = S.groups.find((x) => x.id === String(ch.categoryId));
      if (g) return g;
    }
    return S.groups[0] || null;
  }

  function useGroup(group, focusCh) {
    if (!group) return Promise.resolve();
    S.group = group;
    S.gi = Math.max(0, S.groups.indexOf(group));
    const token = ++S.token;
    $('.chl-gname').textContent = group.name;
    $('.chl-count').textContent = '';
    rowEls = new Map();
    listEl.innerHTML = '<p class="chl-wait">' + tr('chlist.loadingChannels') + '</p>';
    return channelsOf(group).then((list) => {
      if (token !== S.token) return;
      S.list = list || [];
      const i = focusCh ? S.list.findIndex((c) => same(c, focusCh)) : -1;
      S.sel = i >= 0 ? i : 0;
      $('.chl-count').textContent = tr('chlist.channelCount', { n: S.list.length });
      render();
    }, () => {
      if (token === S.token) listEl.innerHTML = '<p class="chl-wait">' + tr('chlist.channelsFailed') + '</p>';
    });
  }

  // --- Drawing ----------------------------------------------------------------------------

  function rowInner(ch, playing) {
    const nn = E.nowNext(ch);
    const now = nn && nn.now;
    return '<span class="chl-num tabular">' + (ch.num != null ? ch.num : '') + '</span>' +
      '<span class="chl-logo">' + u.logo(ch, '', 160) + '</span>' +
      '<span class="chl-txt"><b>' + esc(ch.name) + (IPTV.isFavorite(ch.id) ? ' <em>★</em>' : '') + '</b>' +
        '<small>' + (now ? esc(now.title) : nn && nn.pending ? '' : NO_GUIDE) + '</small>' +
        (now ? '<span class="progress"><i style="--p:' + Math.round(E.progress(now) * 100) + '%"></i></span>' : '') +
      '</span>' +
      (playing ? '<span class="chl-live">' + u.icon('play') + '</span>' : '');
  }

  // Rows are reused: on ▲▼ the existing nodes are moved (the logos are not reloaded) and only
  // rows whose content has changed are rewritten.
  function render() {
    if (!S.open) return;
    const n = S.list.length;
    if (!n) {
      rowEls = new Map();
      listEl.innerHTML = '<p class="chl-wait">' + tr('chlist.noChannels') + '</p>';
      return;
    }
    const top = Math.max(0, Math.min(S.sel - Math.floor(ROWS / 2), n - ROWS));
    const rows = S.list.slice(top, top + ROWS);
    E.want(rows);
    const cur = P.current();
    const next = new Map();
    const els = rows.map((ch, k) => {
      const i = top + k;
      let r = rowEls.get(i);
      if (!r) {
        r = { el: document.createElement('div'), html: '' };
        r.el.className = 'chl-row';
      }
      const playing = same(ch, cur);
      const html = rowInner(ch, playing);
      if (html !== r.html) {
        r.el.innerHTML = html;
        r.html = html;
      }
      r.el.setAttribute('data-i', String(i));
      r.el.classList.toggle('is-sel', i === S.sel);
      r.el.classList.toggle('is-playing', playing);
      next.set(i, r);
      return r.el;
    });
    const kids = listEl.children;
    let inOrder = kids.length === els.length;
    for (let k = 0; inOrder && k < els.length; k++) inOrder = kids[k] === els[k];
    if (!inOrder) listEl.replaceChildren.apply(listEl, els);
    rowEls = next;
    if (S.pane === 'detail') scheduleDetail();
  }

  function renderGroups() {
    const n = S.groups.length;
    const top = Math.max(0, Math.min(S.gi - 5, n - 11));
    glistEl.innerHTML = S.groups.slice(top, top + 11).map((g, k) => {
      const i = top + k;
      return '<div class="chl-grow' + (i === S.gi ? ' is-sel' : '') + (S.group && g.id === S.group.id ? ' is-active' : '') + '">' +
        (g.icon ? u.icon(g.icon) : '') + '<span>' + esc(g.name) + '</span>' + (g.count != null ? '<i>' + g.count + '</i>' : '') + '</div>';
    }).join('');
  }

  // Upcoming programmes per channel: kept for a while, so that ▲▼ back and forth does not ask again.
  function guideOf(id) {
    const hit = guideCache.get(id);
    if (hit && Date.now() - hit.at < 5 * 60000) return hit.promise;
    const promise = IPTV.source.guide(id).catch((e) => { guideCache.delete(id); throw e; });
    guideCache.set(id, { at: Date.now(), promise });
    if (guideCache.size > 60) guideCache.delete(guideCache.keys().next().value);
    return promise;
  }

  // ▲▼ in the guide pane: the name straight away, the programmes once you stop (not one request per row).
  function scheduleDetail() {
    const ch = S.list[S.sel];
    if (!ch) return;
    $('.chl-detail h3').textContent = ch.name;
    if (S.detailFor === ch.id) return;
    clearTimeout(detailTimer);
    const cached = guideCache.has(ch.id);
    if (!cached) $('.chl-progs').innerHTML = '<p class="chl-wait">' + tr('chlist.loadingGuide') + '</p>';
    detailTimer = setTimeout(renderDetail, cached ? 0 : 250);
  }

  function renderDetail() {
    const ch = S.list[S.sel];
    if (!ch) return;
    $('.chl-detail h3').textContent = ch.name;
    const box = $('.chl-progs');
    if (S.detailFor === ch.id && box.childNodes.length) return;
    S.detailFor = ch.id;
    if (!guideCache.has(ch.id)) box.innerHTML = '<p class="chl-wait">' + tr('chlist.loadingGuide') + '</p>';
    const id = ch.id;
    guideOf(id).then((items) => {
      if (S.detailFor !== id) return;
      const now = Date.now();
      const list = (items || []).filter((p) => p.end > now).slice(0, 7);
      box.innerHTML = list.length ? list.map((p) =>
        '<div class="chl-prog' + (p.start <= now ? ' is-now' : '') + '">' +
          '<span class="tabular">' + u.time(p.start) + '</span><b>' + esc(p.title) + '</b>' +
          (p.start <= now && p.desc ? '<small>' + esc(p.desc) + '</small>' : '') +
        '</div>').join('') : '<p class="chl-wait">' + tr('chlist.noGuideForChannel') + '</p>';
    }, () => { if (S.detailFor === id) box.innerHTML = '<p class="chl-wait">' + tr('chlist.guideFailed') + '</p>'; });
  }

  function setPane(pane) {
    S.pane = pane;
    root.setAttribute('data-pane', pane);
    if (pane === 'groups') renderGroups();
    if (pane === 'detail') { S.detailFor = null; renderDetail(); }
  }

  // --- Open/close ---------------------------------------------------------------------------

  function armHide() {
    clearTimeout(S.hideTimer);
    S.hideTimer = setTimeout(close, HIDE_MS);
  }

  function open() {
    const ch = P.current();
    buildGroups();
    S.open = true;
    root.hidden = false;
    setPane('list');
    void root.offsetWidth;
    root.classList.add('is-on');
    host.classList.add('has-chl');
    armHide();
    const g = currentGroup(ch);
    if (S.group && g && S.group.id === g.id && S.list.length) {
      const i = S.list.findIndex((c) => same(c, ch));
      if (i >= 0) S.sel = i;
      $('.chl-gname').textContent = g.name;
      render();
    } else {
      useGroup(g, ch);
    }
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    clearTimeout(S.hideTimer);
    clearTimeout(detailTimer);
    root.classList.remove('is-on');
    host.classList.remove('has-chl');
    setTimeout(() => { if (!S.open) root.hidden = true; }, 220);
  }

  function move(d) {
    const n = S.list.length;
    if (!n) return;
    S.sel = Math.max(0, Math.min(n - 1, S.sel + d));
    render();
  }

  function switchTo() {
    const ch = S.list[S.sel];
    if (!ch) return;
    if (same(ch, P.current()) && P.state() !== 'error') { close(); return; }
    // Further zapping with ▲▼ follows the group you chose in the list.
    IPTV.live.tune(ch, { list: S.list });
    setTimeout(render, 50);
  }

  function toggleFav() {
    const ch = S.list[S.sel];
    if (!ch) return;
    Promise.resolve(IPTV.toggleFavorite(ch)).then(() => {
      if (S.group && S.group.id === 'favorites') {
        S.list = IPTV.favorites();
        S.sel = Math.min(S.sel, Math.max(S.list.length - 1, 0));
        rowEls = new Map();
      }
      render();
    });
  }

  function onKey(name) {
    if (!S.open) return false;
    armHide();
    if (S.pane === 'groups') {
      switch (name) {
        case 'up': S.gi = Math.max(0, S.gi - 1); renderGroups(); return true;
        case 'down': S.gi = Math.min(S.groups.length - 1, S.gi + 1); renderGroups(); return true;
        case 'channelUp': S.gi = Math.max(0, S.gi - 10); renderGroups(); return true;
        case 'channelDown': S.gi = Math.min(S.groups.length - 1, S.gi + 10); renderGroups(); return true;
        case 'enter':
        case 'right': {
          const g = S.groups[S.gi];
          setPane('list');
          if (g && (!S.group || g.id !== S.group.id)) useGroup(g, P.current());
          return true;
        }
        case 'left': return true;
        case 'back': setPane('list'); return true;
      }
      return true;
    }
    if (S.pane === 'detail') {
      switch (name) {
        case 'up': move(-1); return true;
        case 'down': move(1); return true;
        case 'left':
        case 'back':
        case 'right': setPane('list'); return true;
        case 'enter': switchTo(); return true;
        case 'yellow': toggleFav(); return true;
      }
      return true;
    }
    switch (name) {
      case 'up': move(-1); return true;
      case 'down': move(1); return true;
      case 'channelUp': move(-ROWS); return true;
      case 'channelDown': move(ROWS); return true;
      case 'enter': switchTo(); return true;
      case 'left': setPane('groups'); return true;
      case 'right': setPane('detail'); return true;
      case 'yellow': toggleFav(); return true;
      case 'back': close(); return true;
    }
    return false; // e.g. digits: let full screen handle channel numbers
  }

  // Magic Remote: clicking a row switches channel.
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.chl-row');
    if (!row) return;
    S.sel = +row.getAttribute('data-i');
    switchTo();
    armHide();
  });

  IPTV.on('epg', () => { if (S.open) render(); });
  IPTV.onChange((reason) => {
    if (reason === 'continue') return;
    Object.keys(cache).forEach((k) => delete cache[k]);
    if (S.open) { buildGroups(); if (S.pane === 'groups') renderGroups(); }
  });

  IPTV.chlist = { open, close, onKey, isOpen: () => S.open };
})(window);
