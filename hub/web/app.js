/* G3 Hub – web admin. No frameworks, no build step. */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const nf = (n) => (n == null ? '–' : Number(n).toLocaleString(I18n.locale));
  const main = $('#main');

  // --- Icons (Lucide, ISC) -----------------------------------------------------------------

  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    tv: '<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="m8 2.5 4 3.5 4-3.5"/>',
    star: '<path d="m12 2.8 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.6l-5.8 3.1 1.1-6.5L2.6 9.6l6.5-.9L12 2.8Z"/>',
    film: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18"/>',
    series: '<rect x="2.5" y="7" width="19" height="13" rx="2.5"/><path d="M6 3.5h12M8.5 1.8h7"/><path d="m10 11 5 2.5-5 2.5v-5Z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-3 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M14.1 14.1A3 3 0 1 1 9.9 9.9"/><path d="M2 2l20 20"/>',
    grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/>',
    wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1"/>'
  };
  const ico = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;

  // --- Time --------------------------------------------------------------------------------------

  function ago(ms) {
    if (!ms) return tr('time.never');
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 45) return tr('time.justNow');
    if (s < 3600) return tr('time.minutesAgo', { n: Math.round(s / 60) });
    if (s < 86400) return tr('time.hoursAgo', { n: Math.round(s / 3600) });
    if (s < 2 * 86400) return tr('time.yesterday');
    return new Date(ms).toLocaleDateString(I18n.locale, { day: 'numeric', month: 'short' });
  }
  const date = (ms) => (ms ? new Date(ms).toLocaleDateString(I18n.locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '–');

  // --- API -----------------------------------------------------------------------------------------

  let token = localStorage.getItem('g3hub:token') || '';
  let lastLocal = 0;

  async function api(path, opts = {}) {
    // The hub answers errors and status texts in this language.
    const headers = { Accept: 'application/json', 'Accept-Language': I18n.lang };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['X-Hub-Token'] = token;
    if (opts.method && opts.method !== 'GET') lastLocal = Date.now();
    const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    if (res.status === 401) {
      await askToken();
      return api(path, opts);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  // --- Toast, sheet, confirm --------------------------------------------------------------------

  let toastTimer = null;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', !!err);
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), err ? 4200 : 2200);
  }

  function sheet(html, { onClose, wide } = {}) {
    const layer = document.createElement('div');
    layer.className = 'layer';
    layer.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"${wide ? ' style="max-width:720px"' : ''}>${html}</div>`;
    $('#layers').appendChild(layer);
    requestAnimationFrame(() => layer.classList.add('is-on'));
    const close = () => {
      layer.classList.remove('is-on');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => layer.remove(), 220);
      if (onClose) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    layer.addEventListener('mousedown', (e) => { if (e.target === layer) close(); });
    layer.close = close;
    layer.sheet = $('.sheet', layer);
    return layer;
  }

  function confirmBox(title, text, ok = tr('common.ok'), danger = false) {
    return new Promise((resolve) => {
      let done = false;
      const l = sheet(`<h2>${esc(title)}</h2><p>${esc(text)}</p>
        <div class="sheet-actions"><button class="btn" data-a="no">${tr('common.cancel')}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes">${esc(ok)}</button></div>`,
        { onClose: () => { if (!done) resolve(false); } });
      l.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]');
        if (!a) return;
        done = true;
        resolve(a.dataset.a === 'yes');
        l.close();
      });
    });
  }

  let tokenPromise = null;
  function askToken() {
    if (tokenPromise) return tokenPromise;
    tokenPromise = new Promise((resolve) => {
      const l = sheet(`<h2>${ico('key')} ${tr('login.title')}</h2><p>${tr('login.text')}</p>
        <label class="field"><span>${tr('login.token')}</span><input class="input" type="password" id="tok" autocomplete="current-password"></label>
        <div class="sheet-actions"><button class="btn primary" data-a="ok">${tr('login.button')}</button></div>`);
      const input = $('#tok', l);
      setTimeout(() => input.focus(), 50);
      const go = () => {
        token = input.value.trim();
        localStorage.setItem('g3hub:token', token);
        tokenPromise = null;
        l.close();
        connectEvents();
        resolve();
      };
      l.addEventListener('click', (e) => { if (e.target.closest('[data-a="ok"]')) go(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
    return tokenPromise;
  }

  // --- Sortable list (drag the handle) -----------------------------------------------------------
  // The row is moved with a transform and swaps places with its neighbour when the middle is passed.
  // Works inside glass panels (position: fixed does not) and with touchscreens.

  function sortable(list, onEnd) {
    list.addEventListener('pointerdown', (e) => {
      const handle = e.target.closest('.drag-handle');
      if (!handle || !list.contains(handle)) return;
      const row = handle.closest('.row');
      if (!row) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      let startY = e.clientY;
      let lastY = e.clientY;
      const scroller = list.scrollHeight > list.clientHeight + 4 ? list : null;
      let raf = 0;
      row.classList.add('is-dragging');

      const place = () => {
        let dy = lastY - startY;
        let moved = true;
        while (moved) {
          moved = false;
          const next = row.nextElementSibling;
          const prev = row.previousElementSibling;
          if (dy > 0 && next && next.classList.contains('row')) {
            const h = next.offsetHeight;
            if (dy > h / 2) { list.insertBefore(next, row); startY += h; dy -= h; moved = true; }
          } else if (dy < 0 && prev && prev.classList.contains('row')) {
            const h = prev.offsetHeight;
            if (-dy > h / 2) { list.insertBefore(row, prev); startY -= h; dy += h; moved = true; }
          }
        }
        row.style.transform = `translateY(${dy}px)`;
      };

      const autoscroll = () => {
        raf = 0;
        const edge = 60;
        let by = 0;
        if (scroller) {
          const r = scroller.getBoundingClientRect();
          if (lastY < r.top + edge) by = -12; else if (lastY > r.bottom - edge) by = 12;
          if (by) { const before = scroller.scrollTop; scroller.scrollTop += by; startY -= scroller.scrollTop - before; }
        } else {
          if (lastY < edge) by = -12; else if (lastY > innerHeight - edge) by = 12;
          if (by) { const before = scrollY; scrollBy(0, by); startY -= scrollY - before; }
        }
        if (by) { place(); raf = requestAnimationFrame(autoscroll); }
      };

      const move = (ev) => {
        lastY = ev.clientY;
        place();
        if (!raf) raf = requestAnimationFrame(autoscroll);
      };
      const end = () => {
        cancelAnimationFrame(raf);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        row.classList.remove('is-dragging');
        row.style.transform = '';
        onEnd($$('.row[data-id]', list).map((r) => r.dataset.id));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  }

  function debounce(fn, ms) {
    let t = null;
    const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    d.flush = (...a) => { clearTimeout(t); fn(...a); };
    return d;
  }

  const logo = (url, name) => url
    ? `<span class="logo" style="background-image:url('${esc(url)}${url.includes('/api/img?') ? '&w=120' : ''}')"></span>`
    : `<span class="logo empty">${esc(String(name || '').replace(/^[^|]*\|\s*/, '').slice(0, 3).toUpperCase())}</span>`;

  // --- Status (the side menu) -----------------------------------------------------------------

  let status = null;

  async function loadStatus() {
    try {
      status = await api('/api/admin/status');
    } catch (e) {
      status = null;
    }
    renderNav();
    return status;
  }

  const NAV = [
    { path: '', label: tr('nav.overview'), short: tr('nav.overview'), icon: 'home' },
    { path: 'spellistor', label: tr('nav.playlists'), short: tr('nav.playlistsShort'), icon: 'list', badge: () => status && status.playlists.length },
    { path: 'kategorier/live', label: tr('nav.liveCategories'), short: tr('nav.liveCategoriesShort'), icon: 'layers', badge: () => status && `${status.counts.categories.liveVisible}/${status.counts.categories.live}` },
    { path: 'kanaler', label: tr('nav.channels'), short: tr('nav.channels'), icon: 'tv', badge: () => status && nf(status.counts.live) },
    { path: 'favoriter', label: tr('nav.favourites'), short: tr('nav.favourites'), icon: 'star', badge: () => status && status.favorites },
    { sep: true },
    { path: 'kategorier/vod', label: tr('nav.movies'), short: tr('nav.movies'), icon: 'film', badge: () => status && `${status.counts.categories.vodVisible}/${status.counts.categories.vod}` },
    { path: 'kategorier/series', label: tr('nav.series'), short: tr('nav.series'), icon: 'series', badge: () => status && `${status.counts.categories.seriesVisible}/${status.counts.categories.series}` },
    { sep: true },
    { path: 'installningar', label: tr('nav.settings'), short: tr('nav.settingsShort'), icon: 'gear' }
  ];

  function renderNav() {
    const cur = route().path;
    $('#nav').innerHTML = NAV.map((n) => {
      if (n.sep) return '<div class="nav-sep"></div>';
      const active = cur === n.path || (n.path && cur.startsWith(n.path + '/'));
      const b = n.badge ? n.badge() : '';
      return `<a href="#/${n.path}" class="${active ? 'is-active' : ''}">${ico(n.icon)}<span class="hide-phone">${esc(n.label)}</span><span class="show-phone">${esc(n.short)}</span>${b !== '' && b != null ? `<span class="badge">${esc(b)}</span>` : ''}</a>`;
    }).join('');
    if (status) {
      $('#brand-name').textContent = status.name || 'G3 Hub';
      document.title = status.name || 'G3 Hub';
      const tv = status.tv.connected ? `<b>${tr('side.tvConnected')}</b>` : status.tv.lastRequest ? tr('side.tvLastSeen', { when: ago(status.tv.lastRequest.at) }) : tr('side.noTv');
      $('#side-foot').innerHTML = `${tv}<br>${tr('side.version', { version: esc(status.version) })} · ${status.sharp ? tr('side.scalingOn') : tr('side.scalingOff')}`;
    }
  }

  // --- Router ------------------------------------------------------------------------------------

  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, qs] = h.split('?');
    return { path: path.replace(/\/$/, ''), params: new URLSearchParams(qs || '') };
  }

  let current = null;

  async function render() {
    const r = route();
    if (current && current.destroy) current.destroy();
    current = null;
    renderNav();
    main.innerHTML = `<div class="loading"><div class="spinner"></div>${tr('common.loading')}</div>`;
    let page;
    if (r.path === '') page = Overview;
    else if (r.path === 'spellistor') page = Playlists;
    else if (r.path.startsWith('kategorier/')) page = Categories;
    else if (r.path === 'kanaler') page = Channels;
    else if (r.path === 'favoriter') page = Favorites;
    else if (r.path === 'installningar') page = Settings;
    else page = Overview;
    try {
      current = await page(r);
    } catch (e) {
      main.innerHTML = `<div class="page"><div class="card"><div class="empty-state">${ico('x')}<h3>${tr('error.title')}</h3><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">${tr('common.reload')}</button></div></div></div>`;
    }
    main.scrollTop = 0;
  }

  window.addEventListener('hashchange', render);

  // --- Events from the hub (SSE) ---------------------------------------------------------------

  let es = null;
  const refreshSoon = debounce(async () => {
    await loadStatus();
    if (current && current.refresh) current.refresh(true);
  }, 400);

  function connectEvents() {
    if (es) es.close();
    es = new EventSource('/api/events?admin=1&lang=' + encodeURIComponent(I18n.lang) + (token ? '&token=' + encodeURIComponent(token) : ''));
    es.addEventListener('rev', (e) => {
      const d = JSON.parse(e.data || '{}');
      if (!d.reason) return; // the first message on connecting
      const mine = Date.now() - lastLocal < 2000;
      if (!mine && (d.reason === 'favorites' || d.reason === 'curation')) toast(tr('toast.updatedFromTv'));
      if (!mine || d.reason === 'catalog') refreshSoon();
      else loadStatus();
    });
    es.addEventListener('status', (e) => {
      const d = JSON.parse(e.data || '{}');
      if (current && current.onStatus) current.onStatus(d.playlists || []);
    });
    es.addEventListener('continue', () => { if (current && current.name === 'overview') refreshSoon(); });
  }

  // ==================================================================================================
  // Overview
  // ==================================================================================================

  function playlistChip(p) {
    const s = p.status || {};
    if (!p.enabled) return `<span class="chip">${tr('status.off')}</span>`;
    if (s.refreshing) return `<span class="chip busy"><i class="dot"></i>${esc(s.step || tr('status.fetching'))}…</span>`;
    if (s.error) return `<span class="chip err"><i class="dot"></i>${tr('status.error')}</span>`;
    if (s.ok) return `<span class="chip ok"><i class="dot"></i>${tr('status.ok')}</span>`;
    return `<span class="chip">${tr('status.notFetched')}</span>`;
  }

  async function Overview() {
    const st = await loadStatus();
    if (!st) throw new Error(tr('overview.unreachable'));
    const isLocal = /^(localhost|127\.|\[::1\])/.test(location.hostname);
    const urls = isLocal ? st.urls : [location.origin].concat(st.urls.filter((u) => u !== location.origin));
    const c = st.counts;
    const tvChip = st.tv.connected ? `<span class="chip ok"><i class="dot"></i>${tr('overview.tvConnectedNow')}</span>`
      : st.tv.lastRequest ? `<span class="chip warn"><i class="dot"></i>${tr('side.tvLastSeen', { when: esc(ago(st.tv.lastRequest.at)) })}</span>`
        : `<span class="chip"><i class="dot"></i>${tr('side.noTv')}</span>`;
    const errors = st.playlists.filter((p) => p.enabled && p.status.error).length;

    main.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>${esc(st.name)}</h1><p>${tr('overview.intro')}</p></div>
        <div class="actions"><button class="btn" data-a="refresh-all">${ico('refresh')} ${tr('overview.refreshAll')}</button></div></div>

      <div class="card hero">
        <div>
          <h2>${tr('overview.connectTitle')}</h2>
          <p class="muted">${tr('overview.connectText')}</p>
          <div class="chips" style="margin-top:16px">${tvChip}${errors ? `<span class="chip err"><i class="dot"></i>${tr('overview.playlistErrors', { n: errors })}</span>` : st.playlists.length ? `<span class="chip ok"><i class="dot"></i>${tr('overview.playlistsOk')}</span>` : ''}</div>
        </div>
        <div class="connect">
          <div class="k">${tr('overview.hubAddress')}</div>
          ${urls.length ? urls.slice(0, 3).map((u) => `<div class="url"><span>${esc(u)}</span><button class="icon-btn" data-copy="${esc(u)}" title="${tr('common.copy')}">${ico('copy')}</button></div>`).join('') : `<div class="url">${tr('overview.noAddress')}</div>`}
          <p>${tr('overview.tvTokenHint')}</p>
        </div>
      </div>

      ${(st.pauses || []).map((g) => `<div class="card notice warn" style="margin-top:16px"><div class="title">${ico('refresh')} ${tr('overview.pausedTitle', { host: esc(g.host), code: esc(g.code || '?') })}</div>
        <p class="muted">${tr('overview.pausedText', { time: esc(new Date(g.until).toLocaleTimeString(I18n.locale, { hour: '2-digit', minute: '2-digit' })) })}</p></div>`).join('')}

      ${st.playlists.length ? '' : `<div class="card" style="margin-top:16px"><div class="empty-state">${ico('list')}<h3>${tr('overview.noPlaylistTitle')}</h3><p>${tr('overview.noPlaylistText')}</p><a class="btn primary" href="#/spellistor?ny=1">${ico('plus')} ${tr('playlists.addPlaylist')}</a></div></div>`}

      <div class="section-title">${tr('overview.onTvNow')}</div>
      <div class="grid stats">
        <a class="card stat" href="#/kategorier/live"><div class="k">${tr('nav.channels')}</div><div class="v">${nf(c.liveVisible)}<small> ${tr('overview.of', { total: nf(c.live) })}</small></div><div class="d">${tr('overview.inCategoriesOf', { visible: nf(c.categories.liveVisible), total: nf(c.categories.live) })}</div></a>
        <a class="card stat" href="#/favoriter"><div class="k">${tr('nav.favourites')}</div><div class="v">${nf(st.favorites)}</div><div class="d">${st.favoritesMissing ? tr('overview.favouritesMissing', { n: st.favoritesMissing }) : tr('overview.favouritesTop')}</div></a>
        <a class="card stat" href="#/kategorier/vod"><div class="k">${tr('nav.movies')}</div><div class="v">${nf(c.vodVisible)}<small> ${tr('overview.of', { total: nf(c.vod) })}</small></div><div class="d">${tr('overview.inCategories', { n: c.categories.vodVisible, count: nf(c.categories.vodVisible) })}</div></a>
        <a class="card stat" href="#/kategorier/series"><div class="k">${tr('nav.series')}</div><div class="v">${nf(c.seriesVisible)}<small> ${tr('overview.of', { total: nf(c.series) })}</small></div><div class="d">${tr('overview.inCategories', { n: c.categories.seriesVisible, count: nf(c.categories.seriesVisible) })}</div></a>
        <div class="card stat"><div class="k">${tr('overview.continueWatching')}</div><div class="v">${nf(st.continue)}</div><div class="d">${tr('overview.moviesAndEpisodes')}</div></div>
      </div>

      ${st.playlists.length ? `<div class="section-title">${tr('nav.playlists')}</div>
      <div class="card flush"><div class="list">${st.playlists.map((p) => `
        <div class="row ${p.enabled ? '' : 'is-off'}">
          <div class="main-col"><div class="title">${esc(p.name)}</div>
            <div class="sub">${p.status.error ? esc(p.status.error) : tr('overview.playlistSummary', {
              live: tr('counts.channels', { n: p.status.counts.live, count: nf(p.status.counts.live) }),
              vod: tr('counts.movies', { n: p.status.counts.vod, count: nf(p.status.counts.vod) }),
              series: tr('counts.series', { n: p.status.counts.series, count: nf(p.status.counts.series) }),
              when: esc(ago(p.status.updatedAt))
            })}</div></div>
          ${playlistChip(p)}
          <button class="icon-btn" data-refresh="${esc(p.id)}" title="${tr('playlists.refreshNow')}">${ico('refresh')}</button>
        </div>`).join('')}</div></div>` : ''}
    </div>`;

    main.onclick = async (e) => {
      const cp = e.target.closest('[data-copy]');
      if (cp) {
        try {
          await navigator.clipboard.writeText(cp.dataset.copy);
          toast(tr('overview.copied'));
        } catch {
          toast(cp.dataset.copy);
        }
      }
      if (e.target.closest('[data-a="refresh-all"]')) {
        await api('/api/admin/refresh', { method: 'POST', body: {} });
        toast(tr('overview.refreshingAll'));
      }
      const rf = e.target.closest('[data-refresh]');
      if (rf) {
        await api(`/api/admin/playlists/${rf.dataset.refresh}/refresh`, { method: 'POST', body: {} });
        toast(tr('overview.refreshing'));
      }
    };
    return {
      name: 'overview',
      refresh: () => Overview(),
      onStatus: debounce(() => Overview(), 600),
      destroy: () => { main.onclick = null; }
    };
  }

  // ==================================================================================================
  // Playlists
  // ==================================================================================================

  async function Playlists(r) {
    let items = (await api('/api/admin/playlists')).items;

    function card(p) {
      const s = p.status || {};
      const where = p.type === 'm3u' ? esc(p.m3uUrl) : `${esc(p.server)} · ${esc(p.username)}`;
      const meta = [];
      const cnt = (k) => (s.counts ? s.counts[k] : null);
      meta.push(`<span>${tr('playlists.metaChannels', { n: cnt('live'), count: nf(cnt('live')) })}</span>`);
      meta.push(`<span>${tr('playlists.metaMovies', { n: cnt('vod'), count: nf(cnt('vod')) })}</span>`);
      meta.push(`<span>${tr('playlists.metaSeries', { n: cnt('series'), count: nf(cnt('series')) })}</span>`);
      meta.push(`<span>${tr('playlists.metaUpdated', { when: esc(ago(s.updatedAt)) })}</span>`);
      if (s.expires) meta.push(`<span>${tr('playlists.metaExpires', { date: esc(date(s.expires)) })}</span>`);
      if (s.maxConnections) meta.push(`<span>${tr('playlists.metaConnections', { active: nf(s.activeConnections || 0), max: nf(s.maxConnections) })}</span>`);
      meta.push(`<span>${tr('playlists.metaFormat', { format: p.format === 'ts' ? 'MPEG-TS' : 'HLS' })}</span>`);
      return `<div class="card" data-id="${esc(p.id)}">
        <div class="pl-head">
          <div class="main-col"><h2>${esc(p.name)} <span class="chip">${p.type === 'm3u' ? 'M3U' : 'Xtream'}</span> ${playlistChip(p)}</h2>
            <div class="mono muted" style="margin-top:4px;word-break:break-all">${where}</div></div>
          <button class="switch ${p.enabled ? 'is-on' : ''}" data-a="toggle" title="${p.enabled ? tr('playlists.turnOff') : tr('playlists.turnOn')}" aria-label="${tr('playlists.active')}"></button>
        </div>
        <div class="pl-meta">${meta.join('')}</div>
        ${s.error ? `<div class="pl-error">${esc(s.error)}</div>` : ''}
        ${(s.warnings || []).map((w) => `<div class="pl-warn">${esc(w)}</div>`).join('')}
        <div class="pl-actions">
          <button class="btn small" data-a="refresh" ${s.refreshing ? 'disabled' : ''}>${ico('refresh')} ${tr('playlists.refreshNow')}</button>
          <button class="btn small" data-a="edit">${ico('edit')} ${tr('common.edit')}</button>
          <button class="btn small danger" data-a="delete">${ico('trash')} ${tr('common.remove')}</button>
        </div>
      </div>`;
    }

    function draw() {
      main.innerHTML = `<div class="page">
        <div class="page-head"><div><h1>${tr('nav.playlists')}</h1><p>${tr('playlists.intro')}</p></div>
          <div class="actions"><button class="btn primary" data-a="add">${ico('plus')} ${tr('common.add')}</button></div></div>
        ${items.length ? items.map(card).join('') : `<div class="card"><div class="empty-state">${ico('list')}<h3>${tr('playlists.emptyTitle')}</h3><p>${tr('playlists.emptyText')}</p><button class="btn primary" data-a="add">${ico('plus')} ${tr('playlists.addPlaylist')}</button></div></div>`}
      </div>`;
    }

    function form(p) {
      const isNew = !p;
      p = p || { type: 'xtream', format: 'm3u8', enabled: true };
      const l = sheet(`<h2>${isNew ? tr('playlists.newTitle') : tr('playlists.editTitle')}</h2>
        <p>${tr('playlists.storedInHub')}</p>
        <div class="segmented" style="margin-bottom:16px" data-seg="type">
          <button type="button" data-v="xtream" class="${p.type !== 'm3u' ? 'is-on' : ''}">Xtream Codes</button>
          <button type="button" data-v="m3u" class="${p.type === 'm3u' ? 'is-on' : ''}">${tr('playlists.typeM3u')}</button>
        </div>
        <label class="field"><span>${tr('playlists.name')}</span><input class="input" name="name" value="${esc(p.name || '')}" placeholder="${tr('playlists.namePlaceholder')}"></label>
        <div data-type="xtream">
          <label class="field"><span>${tr('playlists.server')}</span><input class="input" name="server" value="${esc(p.server || '')}" placeholder="${tr('playlists.serverPlaceholder')}" autocapitalize="off" spellcheck="false"><small>${tr('playlists.serverHint')}</small></label>
          <div class="field-row">
            <label class="field"><span>${tr('playlists.username')}</span><input class="input" name="username" value="${esc(p.username || '')}" autocapitalize="off" spellcheck="false" autocomplete="off"></label>
            <label class="field"><span>${tr('playlists.password')}</span><input class="input" name="password" type="password" placeholder="${p.hasPassword ? tr('playlists.passwordUnchanged') : ''}" autocomplete="new-password"></label>
          </div>
        </div>
        <div data-type="m3u">
          <label class="field"><span>${tr('playlists.m3uUrl')}</span><input class="input" name="m3uUrl" value="${esc(p.m3uUrl || '')}" placeholder="http://…/get.php?username=…&type=m3u_plus" autocapitalize="off" spellcheck="false"></label>
        </div>
        <label class="field" data-type="xtream"><span>${tr('playlists.format')}</span>
          <div class="segmented" data-seg="format">
            <button type="button" data-v="m3u8" class="${p.format !== 'ts' ? 'is-on' : ''}">HLS (.m3u8)</button>
            <button type="button" data-v="ts" class="${p.format === 'ts' ? 'is-on' : ''}">MPEG-TS (.ts)</button>
          </div><small>${tr('playlists.formatHint')}</small></label>
        <details class="advanced"><summary>${tr('playlists.advanced')}</summary>
          <label class="field"><span>${tr('playlists.epgUrl')}</span><input class="input" name="epgUrl" value="${esc(p.epgUrl || '')}" placeholder="http://…/xmltv.php" autocapitalize="off" spellcheck="false"><small>${tr('playlists.epgHint')}</small></label>
          <label class="field"><span>${tr('playlists.userAgent')}</span><input class="input" name="userAgent" value="${esc(p.userAgent || '')}" placeholder="IPTVSmartersPro" autocapitalize="off" spellcheck="false"><small>${tr('playlists.userAgentHint')}</small></label>
        </details>
        <div id="test-out"></div>
        <div class="sheet-actions"><button class="btn" data-a="test">${ico('wifi')} ${tr('playlists.test')}</button><span class="spacer"></span><button class="btn" data-a="cancel">${tr('common.cancel')}</button><button class="btn primary" data-a="save">${isNew ? tr('common.add') : tr('common.save')}</button></div>`);
      const box = l.sheet;
      let type = p.type === 'm3u' ? 'm3u' : 'xtream';
      let format = p.format === 'ts' ? 'ts' : 'm3u8';
      const showType = () => $$('[data-type]', box).forEach((el) => { el.hidden = el.dataset.type !== type; });
      showType();
      setTimeout(() => $('[name="name"]', box).focus(), 60);
      const values = () => {
        const v = { type, format, enabled: p.enabled !== false };
        for (const el of $$('input[name]', box)) v[el.name] = el.value.trim();
        if (!isNew) v.id = p.id;
        return v;
      };
      box.addEventListener('click', async (e) => {
        const seg = e.target.closest('[data-seg] [data-v]');
        if (seg) {
          const group = seg.parentElement;
          $$('[data-v]', group).forEach((b) => b.classList.toggle('is-on', b === seg));
          if (group.dataset.seg === 'type') { type = seg.dataset.v; showType(); } else format = seg.dataset.v;
          return;
        }
        const a = e.target.closest('[data-a]');
        if (!a) return;
        if (a.dataset.a === 'cancel') return l.close();
        if (a.dataset.a === 'test') {
          const out = $('#test-out', box);
          out.innerHTML = `<div class="test-result"><div class="loading" style="padding:0"><div class="spinner"></div>${tr('playlists.testing')}</div></div>`;
          const res = await api('/api/admin/playlists/test', { method: 'POST', body: values() }).catch((err) => ({ ok: false, error: err.message }));
          if (res.ok) {
            const i = res.info || {};
            const bits = [i.status && tr('playlists.testStatus', { status: i.status }), i.expires && tr('playlists.testExpires', { date: date(i.expires) }),
              i.maxConnections && tr('playlists.testConnections', { n: Number(i.maxConnections) }), i.entries && tr('playlists.testEntries', { entries: i.entries })].filter(Boolean);
            out.innerHTML = `<div class="test-result ok">${ico('check')} ${tr('playlists.testOk')} ${esc(bits.join(' · '))}</div>`;
          } else out.innerHTML = `<div class="test-result err">${esc(res.error || tr('playlists.testFailed'))}</div>`;
          return;
        }
        if (a.dataset.a === 'save') {
          const v = values();
          if (type === 'xtream' && (!v.server || !v.username)) return toast(tr('playlists.needServer'), true);
          if (type === 'm3u' && !v.m3uUrl) return toast(tr('playlists.needM3u'), true);
          a.disabled = true;
          try {
            if (isNew) await api('/api/admin/playlists', { method: 'POST', body: v });
            else await api(`/api/admin/playlists/${p.id}`, { method: 'PUT', body: v });
            l.close();
            toast(isNew ? tr('playlists.added') : tr('common.saved'));
            reload();
          } catch (err) {
            a.disabled = false;
            toast(err.message, true);
          }
        }
      });
    }

    async function reload() {
      items = (await api('/api/admin/playlists')).items;
      draw();
      loadStatus();
    }

    main.onclick = async (e) => {
      const a = e.target.closest('[data-a]');
      if (!a) return;
      const cardEl = a.closest('[data-id]');
      const p = cardEl && items.find((x) => x.id === cardEl.dataset.id);
      try {
        if (a.dataset.a === 'add') form(null);
        else if (a.dataset.a === 'edit') form(p);
        else if (a.dataset.a === 'refresh') {
          await api(`/api/admin/playlists/${p.id}/refresh`, { method: 'POST', body: {} });
          toast(tr('playlists.refreshingOne', { name: p.name }));
          setTimeout(reload, 300);
        } else if (a.dataset.a === 'toggle') {
          await api(`/api/admin/playlists/${p.id}`, { method: 'PUT', body: { enabled: !p.enabled } });
          reload();
        } else if (a.dataset.a === 'delete') {
          if (await confirmBox(tr('playlists.deleteTitle'), tr('playlists.deleteText', { name: p.name }), tr('common.remove'), true)) {
            await api(`/api/admin/playlists/${p.id}`, { method: 'DELETE' });
            toast(tr('common.removed'));
            reload();
          }
        }
      } catch (err) {
        toast(err.message, true);
      }
    };

    draw();
    if (r.params.get('ny')) form(null);
    return {
      refresh: reload,
      onStatus: debounce(reload, 300),
      destroy: () => { main.onclick = null; }
    };
  }

  // ==================================================================================================
  // Categories (live, films, series)
  // ==================================================================================================

  // count(n) → "12 kanaler" / "12 channels"
  const KIND_TEXT = {
    live: { title: tr('categories.liveTitle'), count: (n) => tr('counts.channels', { n, count: nf(n) }), intro: tr('categories.liveIntro') },
    vod: { title: tr('categories.vodTitle'), count: (n) => tr('counts.movies', { n, count: nf(n) }), intro: tr('categories.vodIntro') },
    series: { title: tr('categories.seriesTitle'), count: (n) => tr('counts.series', { n, count: nf(n) }), intro: tr('categories.seriesIntro') }
  };

  // "SE | SVERIGE HD" → small label "SE" + "SVERIGE HD".
  const catName = (name) => {
    const m = /^\s*([^|]{1,16}?)\s*\|\s*(.+)$/.exec(name);
    return m ? `<span class="pfx">${esc(m[1])}</span>${esc(m[2])}` : esc(name);
  };

  const prefixOf = (name) => {
    const m = /^\s*([^|]{1,16}?)\s*\|/.exec(name);
    return m ? m[1].trim().toUpperCase() : tr('categories.otherPrefix');
  };

  async function Categories(r) {
    const kind = r.path.split('/')[1] || 'live';
    if (!KIND_TEXT[kind]) throw new Error(tr('error.unknownPage'));
    const T = KIND_TEXT[kind];
    let items = [];
    let byId = new Map();
    let order = [];
    let visible = new Set();
    let filter = '';
    let mode = 'all';
    let prefix = null;
    let tab = 'visible';
    let multi = false;

    async function load() {
      items = (await api(`/api/admin/categories?kind=${kind}`)).items;
      byId = new Map(items.map((c) => [c.id, c]));
      order = items.map((c) => c.id);
      visible = new Set(items.filter((c) => c.visible).map((c) => c.id));
      multi = new Set(items.map((c) => c.playlistId)).size > 1;
    }

    const save = debounce(async () => {
      try {
        await api(`/api/admin/categories?kind=${kind}`, { method: 'PUT', body: { order, visible: order.filter((id) => visible.has(id)) } });
        loadStatus();
      } catch (e) {
        toast(e.message, true);
      }
    }, 350);

    function shell() {
      main.innerHTML = `<div class="page">
        <div class="page-head"><div><h1>${T.title}</h1><p>${T.intro}</p></div></div>
        <div class="segmented cat-tabs" data-seg="tab"><button data-v="visible" class="is-on">${tr('categories.onTv')}</button><button data-v="all">${tr('categories.all')}</button></div>
        <div class="cat-layout" data-tab="visible">
          <div class="card sticky pane-visible">
            <div class="panel-head"><h2>${tr('categories.onTv')}</h2><span class="count" id="vis-count"></span></div>
            <div class="list" id="vis-list"></div>
          </div>
          <div class="card pane-all">
            <div class="panel-head"><h2>${tr('categories.all')}</h2><span class="count" id="all-count"></span></div>
            <div class="toolbar" style="margin-bottom:0">
              <label class="search">${ico('search')}<input id="cat-filter" type="search" placeholder="${tr('categories.filterPlaceholder')}" autocomplete="off"></label>
              <div class="segmented" data-seg="mode"><button data-v="all" class="is-on">${tr('categories.modeAll')}</button><button data-v="visible">${tr('categories.modeVisible')}</button><button data-v="hidden">${tr('categories.modeHidden')}</button></div>
            </div>
            <div class="chips prefixes" id="prefixes"></div>
            <div class="bulk">
              <button class="btn small" data-a="show-filtered">${ico('eye')} ${tr('categories.showFiltered')}</button>
              <button class="btn small" data-a="hide-filtered">${ico('eyeOff')} ${tr('categories.hideFiltered')}</button>
              <button class="btn small danger" data-a="hide-all">${tr('categories.hideAll')}</button>
            </div>
            <div class="list" id="all-list"></div>
          </div>
        </div>
      </div>`;
      const input = $('#cat-filter');
      input.addEventListener('input', debounce(() => { filter = input.value; drawAll(); }, 120));
      sortable($('#vis-list'), (ids) => {
        // Keep the hidden ones in their places, put the visible ones in the new order.
        const queue = ids.slice();
        order = order.map((id) => (visible.has(id) ? queue.shift() : id));
        save();
      });
    }

    function filtered() {
      const f = filter.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const words = f.split(/\s+/).filter(Boolean);
      return order.map((id) => byId.get(id)).filter((c) => {
        if (!c) return false;
        if (mode === 'visible' && !visible.has(c.id)) return false;
        if (mode === 'hidden' && visible.has(c.id)) return false;
        if (prefix && prefixOf(c.name) !== prefix) return false;
        if (words.length) {
          const n = c.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          return words.every((w) => n.includes(w));
        }
        return true;
      });
    }

    function drawVisible() {
      const list = order.filter((id) => visible.has(id)).map((id) => byId.get(id));
      $('#vis-count').textContent = tr('categories.visibleCount', { n: list.length, items: T.count(list.reduce((n, c) => n + c.count, 0)) });
      $('#vis-list').innerHTML = list.length ? list.map((c, i) => `
        <div class="row" data-id="${esc(c.id)}">
          <button class="icon-btn drag-handle" title="${tr('common.dragToMove')}" aria-label="${tr('common.move')}">${ico('grip')}</button>
          <div class="main-col">${kind === 'live' ? `<a class="title" href="#/kanaler?cat=${encodeURIComponent(c.id)}">${catName(c.name)}</a>` : `<div class="title">${catName(c.name)}</div>`}
            <div class="sub">${T.count(c.count)}${multi ? ' · ' + esc(c.playlistName) : ''}</div></div>
          <button class="icon-btn hide-phone" data-move="-1" ${i === 0 ? 'disabled' : ''} title="${tr('common.up')}">${ico('up')}</button>
          <button class="icon-btn hide-phone" data-move="1" ${i === list.length - 1 ? 'disabled' : ''} title="${tr('common.down')}">${ico('down')}</button>
          <button class="icon-btn danger" data-hide title="${tr('common.hide')}">${ico('eyeOff')}</button>
        </div>`).join('') : `<div class="empty-state">${ico('eyeOff')}<h3>${tr('categories.noneShownTitle')}</h3><p>${innerWidth < 980 ? tr('categories.noneShownBelow') : tr('categories.noneShownRight')}</p></div>`;
    }

    function drawPrefixes() {
      const counts = new Map();
      for (const c of items) {
        const p = prefixOf(c.name);
        counts.set(p, (counts.get(p) || 0) + 1);
      }
      const list = Array.from(counts).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 48);
      $('#prefixes').innerHTML = list.length > 1 ? list.map(([p, n]) => `<button class="filter-chip ${prefix === p ? 'is-on' : ''}" data-prefix="${esc(p)}">${esc(p)}<small>${n}</small></button>`).join('') : '';
    }

    function drawAll() {
      const list = filtered();
      $('#all-count').textContent = tr('categories.shownOf', { shown: nf(visible.size), total: nf(items.length) });
      const max = 600;
      $('#all-list').innerHTML = list.length ? list.slice(0, max).map((c) => `
        <div class="row ${visible.has(c.id) ? '' : 'is-off'}" data-cat="${esc(c.id)}">
          <div class="main-col"><div class="title">${catName(c.name)}</div><div class="sub">${T.count(c.count)}${multi ? ' · ' + esc(c.playlistName) : ''}</div></div>
          ${kind === 'live' ? `<a class="icon-btn" href="#/kanaler?cat=${encodeURIComponent(c.id)}" title="${tr('categories.showChannels')}">${ico('chevron')}</a>` : ''}
          <button class="switch ${visible.has(c.id) ? 'is-on' : ''}" data-toggle aria-label="${tr('categories.showOnTv')}"></button>
        </div>`).join('') + (list.length > max ? `<div class="list-more muted">${tr('categories.more', { n: nf(list.length - max) })}</div>` : '')
        : `<div class="empty-state"><h3>${tr('common.noResults')}</h3><p>${tr('categories.tryOtherFilter')}</p></div>`;
    }

    function draw() {
      drawVisible();
      drawPrefixes();
      drawAll();
    }

    main.onclick = (e) => {
      const seg = e.target.closest('[data-seg] [data-v]');
      if (seg) {
        const group = seg.parentElement;
        $$('[data-v]', group).forEach((b) => b.classList.toggle('is-on', b === seg));
        if (group.dataset.seg === 'mode') { mode = seg.dataset.v; drawAll(); }
        if (group.dataset.seg === 'tab') { tab = seg.dataset.v; $('.cat-layout').dataset.tab = tab; }
        return;
      }
      const pf = e.target.closest('[data-prefix]');
      if (pf) {
        prefix = prefix === pf.dataset.prefix ? null : pf.dataset.prefix;
        drawPrefixes();
        drawAll();
        return;
      }
      const tg = e.target.closest('[data-toggle]');
      if (tg) {
        const id = tg.closest('[data-cat]').dataset.cat;
        if (visible.has(id)) visible.delete(id);
        else visible.add(id);
        drawVisible();
        drawAll();
        save();
        return;
      }
      const row = e.target.closest('#vis-list .row');
      if (row && e.target.closest('[data-hide]')) {
        visible.delete(row.dataset.id);
        draw();
        save();
        return;
      }
      const mv = e.target.closest('[data-move]');
      if (row && mv) {
        const vis = order.filter((id) => visible.has(id));
        const i = vis.indexOf(row.dataset.id);
        const j = i + Number(mv.dataset.move);
        if (j < 0 || j >= vis.length) return;
        [vis[i], vis[j]] = [vis[j], vis[i]];
        const queue = vis.slice();
        order = order.map((id) => (visible.has(id) ? queue.shift() : id));
        drawVisible();
        save();
        return;
      }
      const a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'show-filtered') {
        const list = filtered();
        if (list.length > 60 && !window.confirm(tr('categories.confirmShowMany', { n: list.length }))) return;
        list.forEach((c) => visible.add(c.id));
      } else if (a.dataset.a === 'hide-filtered') filtered().forEach((c) => visible.delete(c.id));
      else if (a.dataset.a === 'hide-all') {
        confirmBox(tr('categories.hideAllTitle'), tr('categories.hideAllText'), tr('categories.hideAll'), true).then((ok) => {
          if (!ok) return;
          visible.clear();
          draw();
          save();
        });
        return;
      }
      draw();
      save();
    };

    await load();
    shell();
    draw();
    return {
      refresh: async () => {
        await load();
        draw();
      },
      destroy: () => {
        save.flush();
        main.onclick = null;
      }
    };
  }

  // ==================================================================================================
  // Channels
  // ==================================================================================================

  async function Channels(r) {
    const [{ items: cats }, favRes] = await Promise.all([api('/api/admin/categories?kind=live'), api('/api/admin/favorites')]);
    let favs = favRes.items.map((f) => f.id);
    const catById = new Map(cats.map((c) => [c.id, c]));
    let category = r.params.get('cat') || (favs.length ? 'favorites' : (cats.find((c) => c.visible) || cats[0] || {}).id || '');
    let q = r.params.get('q') || '';
    let offset = 0;
    let total = 0;
    let rows = [];
    const PAGE = 200;
    const totalChannels = cats.reduce((n, c) => n + c.count, 0);

    const options = () => {
      const vis = cats.filter((c) => c.visible);
      const hid = cats.filter((c) => !c.visible);
      const opt = (c) => `<option value="${esc(c.id)}" ${c.id === category ? 'selected' : ''}>${esc(c.name)} (${nf(c.count)})</option>`;
      return `<option value="favorites" ${category === 'favorites' ? 'selected' : ''}>${tr('channels.favouritesOption', { n: favs.length })}</option>`
        + (vis.length ? `<optgroup label="${tr('channels.visibleOnTv')}">${vis.map(opt).join('')}</optgroup>` : '')
        + (hid.length ? `<optgroup label="${tr('channels.hidden')}">${hid.map(opt).join('')}</optgroup>` : '');
    };

    main.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>${tr('nav.channels')}</h1><p>${tr('channels.intro', { n: nf(totalChannels) })}</p></div></div>
      <div class="toolbar">
        <label class="search">${ico('search')}<input id="ch-q" type="search" placeholder="${tr('channels.searchPlaceholder')}" value="${esc(q)}" autocomplete="off"></label>
        <select class="input" id="ch-cat" style="max-width:360px">${options()}</select>
      </div>
      <div id="ch-head"></div>
      <div class="card flush"><div class="list" id="ch-list"></div><div id="ch-more"></div></div>
    </div>`;

    const listEl = $('#ch-list');

    function head() {
      const c = catById.get(category);
      if (q) return `<div class="section-title">${tr('channels.resultsFor', { n: nf(total), q: esc(q) })}</div>`;
      if (!c) return `<div class="section-title">${category === 'favorites' ? tr('channels.yourFavourites') : ''}</div>`;
      return `<div class="card" style="margin-bottom:16px;padding:16px 18px"><div class="setting" style="padding:0">
        <div class="main-col"><div class="title">${esc(c.name)}</div><div class="sub">${tr('counts.channels', { n: c.count, count: nf(c.count) })} · ${c.visible ? tr('channels.shownInGuide') : tr('channels.hiddenOnTv')}</div></div>
        <span class="muted hide-phone" style="font-size:13px">${tr('categories.showOnTv')}</span><button class="switch ${c.visible ? 'is-on' : ''}" data-a="cat-visible" aria-label="${tr('categories.showOnTv')}"></button></div></div>`;
    }

    function rowHtml(ch) {
      const fav = favs.includes(ch.id);
      return `<div class="row" data-id="${esc(ch.id)}">
        <span class="num">${ch.num != null ? esc(ch.num) : ''}</span>
        ${logo(ch.logo, ch.name)}
        <div class="main-col"><div class="title">${esc(ch.name)}</div>${q || category === 'favorites' ? `<div class="sub">${esc(ch.categoryName)}${ch.categoryVisible === false ? ' · ' + tr('channels.hiddenCategory') : ''}</div>` : ''}</div>
        <button class="icon-btn star ${fav ? 'is-on' : ''}" data-star title="${fav ? tr('channels.removeFavourite') : tr('channels.addFavourite')}">${ico('star')}</button>
      </div>`;
    }

    async function load(more) {
      if (!more) {
        offset = 0;
        rows = [];
        listEl.innerHTML = `<div class="loading" style="padding:30px 18px"><div class="spinner"></div>${tr('common.loading')}</div>`;
      }
      const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE) });
      if (q) params.set('q', q);
      else if (category) params.set('category', category);
      if (!q && !category) {
        listEl.innerHTML = `<div class="empty-state"><h3>${tr('channels.pickCategory')}</h3></div>`;
        return;
      }
      const res = await api('/api/admin/channels?' + params);
      total = res.total;
      rows = rows.concat(res.items);
      offset = rows.length;
      $('#ch-head').innerHTML = head();
      listEl.innerHTML = rows.length ? rows.map(rowHtml).join('') : `<div class="empty-state"><h3>${q ? tr('common.noResults') : tr('channels.empty')}</h3><p>${q ? tr('channels.searchScope') : category === 'favorites' ? tr('channels.starHint') : ''}</p></div>`;
      $('#ch-more').innerHTML = rows.length < total ? `<div class="list-more"><button class="btn small" data-a="more">${tr('common.showMore', { n: nf(total - rows.length) })}</button></div>` : '';
    }

    const input = $('#ch-q');
    input.addEventListener('input', debounce(() => {
      q = input.value.trim();
      history.replaceState(null, '', `#/kanaler?${new URLSearchParams(q ? { q } : { cat: category })}`);
      load();
    }, 250));
    $('#ch-cat').addEventListener('change', (e) => {
      category = e.target.value;
      q = '';
      input.value = '';
      history.replaceState(null, '', `#/kanaler?cat=${encodeURIComponent(category)}`);
      load();
    });

    main.onclick = async (e) => {
      const star = e.target.closest('[data-star]');
      if (star) {
        const id = star.closest('[data-id]').dataset.id;
        const on = !favs.includes(id);
        favs = on ? favs.concat(id) : favs.filter((x) => x !== id);
        star.classList.toggle('is-on', on);
        star.title = on ? tr('channels.removeFavourite') : tr('channels.addFavourite');
        try {
          await api('/api/admin/favorites', { method: 'PUT', body: { ids: favs } });
          toast(on ? tr('channels.favAdded') : tr('channels.favRemoved'));
          loadStatus();
          const opt = $('#ch-cat option[value="favorites"]');
          if (opt) opt.textContent = tr('channels.favouritesOption', { n: favs.length });
        } catch (err) {
          toast(err.message, true);
        }
        return;
      }
      const a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'more') load(true);
      if (a.dataset.a === 'cat-visible') {
        const c = catById.get(category);
        const all = (await api('/api/admin/categories?kind=live')).items;
        const vis = all.filter((x) => x.visible).map((x) => x.id);
        const next = c.visible ? vis.filter((x) => x !== c.id) : vis.concat(c.id);
        await api('/api/admin/categories?kind=live', { method: 'PUT', body: { visible: next } });
        c.visible = !c.visible;
        $('#ch-head').innerHTML = head();
        $('#ch-cat').innerHTML = options();
        toast(c.visible ? tr('channels.catShown') : tr('channels.catHidden'));
        loadStatus();
      }
    };

    await load();
    return {
      refresh: async () => {
        favs = (await api('/api/admin/favorites')).items.map((f) => f.id);
        load();
      },
      destroy: () => { main.onclick = null; }
    };
  }

  // ==================================================================================================
  // Favourites
  // ==================================================================================================

  async function Favorites() {
    let items = (await api('/api/admin/favorites')).items;

    const save = debounce(async () => {
      try {
        await api('/api/admin/favorites', { method: 'PUT', body: { ids: items.map((f) => f.id) } });
        loadStatus();
      } catch (e) {
        toast(e.message, true);
      }
    }, 300);

    function draw() {
      main.innerHTML = `<div class="page">
        <div class="page-head"><div><h1>${tr('nav.favourites')}</h1><p>${tr('favourites.intro')}</p></div>
          <div class="actions"><a class="btn" href="#/kanaler">${ico('plus')} ${tr('favourites.addChannels')}</a></div></div>
        <div class="card flush"><div class="list" id="fav-list">${items.length ? items.map((f, i) => `
          <div class="row ${f.missing ? 'is-off' : ''}" data-id="${esc(f.id)}">
            <button class="icon-btn drag-handle" title="${tr('common.dragToMove')}" aria-label="${tr('common.move')}">${ico('grip')}</button>
            <span class="num">${i + 1}</span>
            ${f.missing ? '<span class="logo empty">?</span>' : logo(f.logo, f.name)}
            <div class="main-col"><div class="title">${esc(f.missing ? tr('favourites.missing') : f.name)}</div><div class="sub">${esc(f.missing ? f.id : f.categoryName)}</div></div>
            <button class="icon-btn hide-phone" data-move="-1" ${i === 0 ? 'disabled' : ''} title="${tr('common.up')}">${ico('up')}</button>
            <button class="icon-btn hide-phone" data-move="1" ${i === items.length - 1 ? 'disabled' : ''} title="${tr('common.down')}">${ico('down')}</button>
            <button class="icon-btn danger" data-remove title="${tr('common.remove')}">${ico('x')}</button>
          </div>`).join('') : `<div class="empty-state">${ico('star')}<h3>${tr('favourites.emptyTitle')}</h3><p>${tr('favourites.emptyText')}</p><a class="btn primary" href="#/kanaler">${tr('favourites.findChannels')}</a></div>`}</div></div>
      </div>`;
      sortable($('#fav-list'), (ids) => {
        const map = new Map(items.map((f) => [f.id, f]));
        items = ids.map((id) => map.get(id)).filter(Boolean);
        draw();
        save();
      });
    }

    main.onclick = (e) => {
      const row = e.target.closest('.row[data-id]');
      if (!row) return;
      const i = items.findIndex((f) => f.id === row.dataset.id);
      if (e.target.closest('[data-remove]')) {
        items.splice(i, 1);
        draw();
        save();
        toast(tr('common.removed'));
      }
      const mv = e.target.closest('[data-move]');
      if (mv) {
        const j = i + Number(mv.dataset.move);
        if (j < 0 || j >= items.length) return;
        [items[i], items[j]] = [items[j], items[i]];
        draw();
        save();
      }
    };

    draw();
    return {
      refresh: async () => {
        items = (await api('/api/admin/favorites')).items;
        draw();
      },
      destroy: () => {
        save.flush();
        main.onclick = null;
      }
    };
  }

  // ==================================================================================================
  // Settings
  // ==================================================================================================

  async function Settings() {
    const [{ settings: s }, st] = await Promise.all([api('/api/admin/settings'), loadStatus()]);
    // An empty TMDB language follows the hub language (the same rule as in the hub).
    const tmdbAuto = (lang) => (lang === 'sv' ? 'sv-SE' : 'en-US');
    const hubLang = s.language === 'sv' ? 'sv' : 'en';
    const uiPref = I18n.pref();
    const tmdbLink = '<a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener" style="text-decoration:underline">themoviedb.org</a>';
    main.innerHTML = `<div class="page">
      <div class="page-head"><div><h1>${tr('nav.settings')}</h1><p>${tr('settings.intro')}</p></div>
        <div class="actions"><button class="btn primary" data-a="save">${ico('check')} ${tr('common.save')}</button></div></div>

      <div class="card">
        <div class="setting"><div class="main-col"><div class="title">${tr('settings.name')}</div><div class="sub">${tr('settings.nameHint')}</div></div><input class="input" name="name" value="${esc(s.name)}"></div>
        <div class="setting"><div class="main-col"><div class="title">${tr('settings.refresh')}</div><div class="sub">${tr('settings.refreshHint')}</div></div>
          <select class="input" name="refreshHours">${[3, 6, 12, 24, 48].map((h) => `<option value="${h}" ${Number(s.refreshHours) === h ? 'selected' : ''}>${tr('settings.everyHours', { n: h })}</option>`).join('')}</select></div>
        <div class="setting"><div class="main-col"><div class="title">${tr('settings.imageProxy')}</div><div class="sub">${tr('settings.imageProxyHint')}${st && !st.sharp ? ' ' + tr('settings.installSharp') : ''}</div></div>
          <button class="switch ${s.imageProxy ? 'is-on' : ''}" data-switch="imageProxy" aria-label="${tr('settings.imageProxy')}"></button></div>
      </div>

      <div class="section-title">${tr('settings.languageSection')}</div>
      <div class="card">
        <div class="setting"><div class="main-col"><div class="title">${tr('settings.uiLanguage')}</div><div class="sub">${tr('settings.uiLanguageHint')}</div></div>
          <select class="input" id="ui-lang" style="max-width:200px"><option value="auto" ${uiPref === 'auto' ? 'selected' : ''}>${tr('settings.langAuto')}</option>${I18n.langs.map((l) => `<option value="${l.id}" ${uiPref === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
        <div class="setting"><div class="main-col"><div class="title">${tr('settings.hubLanguage')}</div><div class="sub">${tr('settings.hubLanguageHint')}</div></div>
          <select class="input" name="language" style="max-width:200px">${I18n.langs.map((l) => `<option value="${l.id}" ${hubLang === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>
      </div>

      <div class="section-title">${tr('settings.coversSection')}</div>
      <div class="card">
        <div class="setting"><div class="main-col"><div class="title">${tr('settings.tmdbKey')}</div><div class="sub">${tr('settings.tmdbKeyHint', { link: tmdbLink })}</div></div>
          <input class="input" name="tmdbKey" type="password" value="${esc(s.tmdbKey)}" placeholder="${tr('settings.tmdbKeyPlaceholder')}" autocomplete="off"></div>
        <div class="setting"><div class="main-col"><div class="title">${tr('settings.tmdbLanguage')}</div><div class="sub">${tr('settings.tmdbLanguageHint')}</div></div><input class="input" name="tmdbLanguage" value="${esc(s.tmdbLanguage || '')}" placeholder="${tmdbAuto(hubLang)}" style="max-width:160px"></div>
      </div>

      <div class="section-title">${tr('settings.security')}</div>
      <div class="card">
        <div class="setting"><div class="main-col"><div class="title">${tr('settings.adminToken')}</div><div class="sub">${tr('settings.adminTokenHint')}</div></div>
          <input class="input" name="adminToken" type="password" value="${esc(s.adminToken)}" autocomplete="new-password"></div>
        <div class="setting"><div class="main-col"><div class="title">${tr('settings.tvToken')}</div><div class="sub">${tr('settings.tvTokenHint')}</div></div>
          <input class="input" name="tvToken" type="password" value="${esc(s.tvToken)}" autocomplete="new-password"></div>
      </div>

      <div class="section-title">${tr('settings.maintenance')}</div>
      <div class="card">
        <div class="setting"><div class="main-col"><div class="title">${tr('overview.continueWatching')}</div><div class="sub">${tr('settings.continueSaved', { n: st ? st.continue : null, count: nf(st && st.continue) })}</div></div><button class="btn small danger" data-a="clear-progress">${tr('settings.clear')}</button></div>
        <div class="setting"><div class="main-col"><div class="title">${tr('settings.backup')}</div><div class="sub">${tr('settings.backupHint')}</div></div>
          <div class="actions"><button class="btn small" data-a="backup">${ico('copy')} ${tr('settings.download')}</button><button class="btn small" data-a="restore">${tr('settings.restoreButton')}</button></div>
          <input type="file" accept="application/json,.json" data-file="restore" hidden></div>
        <div class="setting"><div class="main-col"><div class="title">${tr('settings.about')}</div><div class="sub">${tr('settings.aboutLine', { version: esc(st && st.version), node: esc(st && st.node) })} · ${st && st.sharp ? tr('settings.sharpInstalled') : tr('settings.noSharp')}${st && st.tmdb ? ' · ' + tr('settings.tmdbOn') : ''}<br><span class="mono">${esc(st && st.dataDir)}</span></div></div></div>
      </div>
    </div>`;

    const values = () => {
      const v = {};
      for (const el of $$('[name]', main)) v[el.name] = el.value;
      for (const el of $$('[data-switch]', main)) v[el.dataset.switch] = el.classList.contains('is-on');
      return v;
    };

    main.onclick = async (e) => {
      const sw = e.target.closest('[data-switch]');
      if (sw) sw.classList.toggle('is-on');
      const a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'save') {
        try {
          const v = values();
          await api('/api/admin/settings', { method: 'PUT', body: v });
          if (v.adminToken !== token) {
            token = v.adminToken;
            localStorage.setItem('g3hub:token', token);
            connectEvents();
          }
          toast(tr('common.saved'));
          loadStatus();
        } catch (err) {
          toast(err.message, true);
        }
      }
      if (a.dataset.a === 'backup') {
        try {
          const data = await api('/api/admin/backup');
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = 'g3hub-backup-' + new Date().toISOString().slice(0, 10) + '.json';
          document.body.appendChild(link);
          link.click();
          setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
          toast(tr('settings.backupDone'));
        } catch (err) {
          toast(err.message, true);
        }
      }
      if (a.dataset.a === 'restore') $('[data-file="restore"]', main).click();
      if (a.dataset.a === 'clear-progress') {
        if (await confirmBox(tr('settings.clearTitle'), tr('settings.clearText'), tr('settings.clear'), true)) {
          await api('/api/admin/progress', { method: 'DELETE' });
          toast(tr('settings.cleared'));
          Settings();
        }
      }
    };
    main.onchange = async (e) => {
      // Language of this page: stored in this browser only, then the page reloads.
      if (e.target.id === 'ui-lang') {
        I18n.set(e.target.value);
        return;
      }
      if (e.target.name === 'language') {
        const tl = $('[name="tmdbLanguage"]', main);
        if (tl) tl.placeholder = tmdbAuto(e.target.value);
        return;
      }
      const input = e.target.closest('[data-file="restore"]');
      if (!input || !input.files || !input.files[0]) return;
      let data;
      try {
        data = JSON.parse(await input.files[0].text());
      } catch {
        toast(tr('settings.fileUnreadable'), true);
        return;
      } finally {
        input.value = '';
      }
      const n = data && data.config && Array.isArray(data.config.playlists) ? data.config.playlists.length : 0;
      const when = data && data.exportedAt ? new Date(data.exportedAt).toLocaleString(I18n.locale) : tr('settings.unknownDate');
      if (!(await confirmBox(tr('settings.restoreTitle'), tr('settings.restoreText', { n, when }), tr('settings.restore'), true))) return;
      try {
        await api('/api/admin/restore', { method: 'POST', body: data });
        toast(tr('settings.restored'));
        Settings();
      } catch (err) {
        toast(err.message, true);
      }
    };
    return { destroy: () => { main.onclick = null; main.onchange = null; } };
  }

  // --- Start -------------------------------------------------------------------------------------

  const style = document.createElement('style');
  style.textContent = '.show-phone{display:none}@media (max-width:820px){.show-phone{display:inline}}';
  document.head.appendChild(style);
  $('#brand-sub').textContent = tr('brand.sub');

  connectEvents();
  render();
  loadStatus();
  // The status line (TV connected, fetches) is kept fresh even without events.
  setInterval(() => { if (!document.hidden) loadStatus(); }, 60000);
})();
