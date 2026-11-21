/*
 * Search — on-screen keyboard on the left, results on the right in shelves: Channels · Programmes · Movies · Series.
 * Programmes (hub mode) searches the guide: OK on something on now = watch, upcoming = reminder,
 * past on a channel with catch-up = watch on catch-up.
 * Searches 300 ms after the last key. In hub mode Channels searches the visible categories and
 * favourites; "All channels" searches the provider's whole list (e.g. to find a new favourite).
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const u = IPTV.u;
  const esc = u.esc;

  const root = IPTV.ui.el.querySelector('[data-pane="search"]');
  root.innerHTML =
    '<div class="sr-left">' +
      '<div class="sr-field">' + u.icon('search', 'sr-field-icon') +
        '<span class="sr-query"></span><i class="sr-caret"></i>' +
        '<span class="sr-ph">' + tr('search.placeholder') + '</span>' +
      '</div>' +
      '<div class="sr-kb"></div>' +
      '<button class="btn sr-scope" data-focusable data-act="scope"></button>' +
    '</div>' +
    '<div class="sr-results">' +
      '<div class="sr-track"></div>' +
      '<div class="sr-state"></div>' +
    '</div>';

  const q = (sel) => root.querySelector(sel);
  const track = q('.sr-track');
  const FOCUS_Y = 0;

  let token = 0;
  let shelves = [];   // { kind, items, el }
  let shelfIndex = 0;
  let allScope = false;
  let lastQuery = '';

  const run = u.debounce(() => search(), 300);

  const kb = IPTV.keyboard(q('.sr-kb'), {
    onChange(v) {
      q('.sr-query').textContent = v;
      root.classList.toggle('has-query', !!v);
      run();
    }
  });

  function scopeLabel() {
    q('.sr-scope').innerHTML = u.icon(allScope ? 'grid' : 'star') +
      '<span>' + (allScope ? tr('search.scopeAll') : tr('search.scopeMine')) + '</span>';
  }

  function state(kind, text) {
    const box = q('.sr-state');
    root.classList.toggle('has-state', !!kind);
    if (!kind) { box.innerHTML = ''; return; }
    if (kind === 'hint') {
      box.innerHTML = '<div class="tv-msg-icon">' + u.icon('search') + '</div><h2 class="tv-msg-title">' + tr('search.title') + '</h2>' +
        '<p class="tv-msg-text">' + tr('search.hint') + '</p>';
    } else if (kind === 'loading') {
      box.innerHTML = '<div class="spinner"></div>';
    } else if (kind === 'none') {
      box.innerHTML = '<div class="tv-msg-icon">' + u.icon('search') + '</div><h2 class="tv-msg-title">' + tr('search.noResults') + '</h2>' +
        '<p class="tv-msg-text">' + tr('search.noMatch', { query: esc(text) }) + (allScope ? '' : ' ' + tr('search.tryAllChannels')) + '</p>';
    } else if (kind === 'setup') {
      box.innerHTML = '<div class="tv-msg-icon">' + u.icon('tv') + '</div><h2 class="tv-msg-title">' + tr('search.setupTitle') + '</h2>' +
        '<p class="tv-msg-text">' + tr('search.setupText') + '</p>';
    } else {
      box.innerHTML = '<div class="tv-msg-icon is-error">' + u.icon('signal') + '</div><h2 class="tv-msg-title">' + tr('search.failed') + '</h2>' +
        '<p class="tv-msg-text">' + esc(text || '') + '</p>';
    }
  }

  function search() {
    const query = kb.value().trim();
    const t = ++token;
    lastQuery = query;
    if (!IPTV.configured()) { render(null); state('setup'); return; }
    if (query.length < 1) { render(null); state('hint'); return; }
    if (!shelves.length) state('loading');
    root.classList.add('is-searching');
    Promise.all([
      IPTV.source.search(query, { limit: 40, all: allScope }),
      query.length >= 2 ? IPTV.source.epgSearch(query, 30).catch(() => []) : Promise.resolve([])
    ]).then((res) => {
      const r = Object.assign({}, res[0], { epg: res[1] || [] });
      if (t !== token) return;
      root.classList.remove('is-searching');
      const total = (r.live || []).length + r.epg.length + (r.vod || []).length + (r.series || []).length;
      if (!total) { render(null); state('none', query); return; }
      state(null);
      render(r);
    }, (err) => {
      if (t !== token) return;
      root.classList.remove('is-searching');
      render(null);
      state('error', err.message);
    });
  }

  function channelCard(ch, i) {
    const nn = IPTV.epg.peek(ch);
    return '<button class="card sr-ch" data-focusable data-i="' + i + '">' +
      '<div class="lift-shadow"></div>' +
      '<div class="card-face"><span class="sr-ch-logo">' + u.logo(ch, '', 320) + '</span><i class="shine"></i></div>' +
      '<span class="card-label"><b>' + esc(ch.name) + (IPTV.isFavorite(ch.id) ? ' <em>' + u.icon('star-fill') + '</em>' : '') + '</b>' +
        '<small>' + (nn && nn.now ? esc(nn.now.title) : '&nbsp;') + '</small></span>' +
    '</button>';
  }

  // A programme in the guide: the channel's logo, when, title.
  function programCard(h, i) {
    const p = h.program;
    const ch = h.channel;
    const now = Date.now();
    const live = p.start <= now && p.end > now;
    const past = p.end <= now;
    const day = IPTV.reminders ? IPTV.reminders.day(p.start) : '';
    const when = live ? tr('common.now') + ' · ' + u.minutesLeft(p)
      : past ? (IPTV.catchup.available(ch, p) ? '↺ ' : '') + day + ' ' + u.time(p.start)
        : (IPTV.reminders && IPTV.reminders.has(ch, p) ? tr('search.reminderSet') + ' · ' : '') + day + ' ' + u.time(p.start);
    return '<button class="card sr-ch sr-prog' + (live ? ' is-live' : past ? ' is-past' : '') + '" data-focusable data-i="' + i + '">' +
      '<div class="lift-shadow"></div>' +
      '<div class="card-face"><span class="sr-ch-logo">' + u.logo(ch, '', 320) + '</span>' +
        '<span class="sr-prog-when">' + esc(when) + '</span><i class="shine"></i></div>' +
      '<span class="card-label"><b>' + esc(p.title) + '</b><small>' + esc(ch.name) + '</small></span>' +
    '</button>';
  }

  function openProgram(h) {
    const p = h.program;
    const ch = h.channel;
    const now = Date.now();
    if (p.end <= now) {
      if (IPTV.catchup.available(ch, p)) IPTV.catchup.play(ch, p);
      else UI.toast(tr('search.noCatchup', { name: ch.name }), 3500);
    } else if (p.start > now) {
      IPTV.reminders.toggle(ch, p);
      setTimeout(search, 50);
    } else {
      IPTV.live.tune(ch, { list: [ch] });
    }
  }

  function posterCard(it, i) {
    return '<button class="poster sr-poster" data-focusable data-i="' + i + '">' +
      '<div class="lift-shadow"></div>' +
      '<div class="poster-face"><span class="poster-fallback">' + esc(it.title) + '</span>' +
        (it.poster ? '<img src="' + esc(IPTV.source.img(it.poster, 320)) + '" data-orig="' + esc(it.poster) + '" alt="" loading="lazy" decoding="async" data-hide-broken>' : '') +
        '<i class="shine"></i></div>' +
      '<span class="poster-label">' + esc(it.title) + (it.year ? ' <small>' + it.year + '</small>' : '') + '</span>' +
    '</button>';
  }

  function render(r) {
    const prev = shelves[shelfIndex] && shelves[shelfIndex].kind;
    shelves = [];
    if (r) {
      if (r.live && r.live.length) shelves.push({ kind: 'live', title: tr('search.shelf.channels'), items: r.live });
      if (r.epg && r.epg.length) shelves.push({ kind: 'epg', title: tr('search.shelf.programmes'), items: r.epg });
      if (r.vod && r.vod.length) shelves.push({ kind: 'vod', title: tr('search.shelf.movies'), items: r.vod });
      if (r.series && r.series.length) shelves.push({ kind: 'series', title: tr('search.shelf.series'), items: r.series });
    }
    track.innerHTML = shelves.map((s, i) =>
      '<section class="sr-shelf is-' + s.kind + '" data-si="' + i + '">' +
        '<h2 class="shelf-title">' + s.title + ' <span>' + s.items.length + '</span></h2>' +
        '<div class="shelf-viewport"><div class="shelf-track" data-scroll-track data-scroll-edge="100">' +
          s.items.map((it, n) => (s.kind === 'live' ? channelCard(it, n) : s.kind === 'epg' ? programCard(it, n) : posterCard(it, n))).join('') +
        '</div></div>' +
      '</section>'
    ).join('');
    shelves.forEach((s, i) => { s.el = track.children[i]; });
    const keep = shelves.findIndex((s) => s.kind === prev);
    shelfIndex = keep >= 0 ? keep : 0;
    scrollTo(shelfIndex, true);
    const live = shelves.find((s) => s.kind === 'live');
    if (live) IPTV.epg.want(live.items.slice(0, 12));
  }

  function scrollTo(i, instant) {
    const s = shelves[i];
    const y = s ? Math.max(0, s.el.offsetTop - FOCUS_Y) : 0;
    track.style.transition = instant ? 'none' : '';
    track.style.transform = 'translate3d(0,' + -y + 'px,0)';
    if (instant) void track.offsetHeight;
  }

  IPTV.on('epg', () => {
    const s = shelves.find((x) => x.kind === 'live');
    if (!s || IPTV.ui.tab() !== 'search') return;
    s.el.querySelectorAll('.sr-ch').forEach((b) => {
      const ch = s.items[+b.getAttribute('data-i')];
      const nn = ch && IPTV.epg.peek(ch);
      const small = b.querySelector('small');
      if (small && nn && nn.now) small.textContent = nn.now.title;
    });
  });

  function itemOf(el) {
    const sh = el.closest('.sr-shelf');
    if (!sh) return null;
    const s = shelves[+sh.getAttribute('data-si')];
    return s ? { kind: s.kind, item: s.items[+el.getAttribute('data-i')], shelf: s } : null;
  }

  root.addEventListener('nav:focus', (e) => {
    const sh = e.target.closest('.sr-shelf');
    if (!sh) return;
    const i = +sh.getAttribute('data-si');
    if (i !== shelfIndex) {
      shelfIndex = i;
      scrollTo(i);
    }
  });

  root.addEventListener('nav:activate', (e) => {
    const t = e.target;
    if (t.getAttribute('data-act') === 'scope') {
      allScope = !allScope;
      scopeLabel();
      if (kb.value().trim()) search();
      return;
    }
    const hit = itemOf(t);
    if (!hit || !hit.item) return;
    if (hit.kind === 'live') {
      IPTV.live.S.zapList = hit.shelf.items;
      IPTV.live.tune(hit.item, { list: hit.shelf.items });
    } else if (hit.kind === 'epg') {
      openProgram(hit.item);
    } else {
      IPTV.media.openDetail(hit.kind, hit.item);
    }
  });

  root.addEventListener('nav:longpress', (e) => {
    const hit = itemOf(e.target);
    if (hit && hit.kind === 'epg') {
      const h = hit.item;
      const now = Date.now();
      const items = [{ label: tr('search.menu.watchChannel', { name: h.channel.name }), detail: tr('search.menu.live'), action: () => IPTV.live.tune(h.channel, { list: [h.channel] }) }];
      if (h.program.start < now && IPTV.catchup.available(h.channel, h.program)) {
        items.push({ label: h.program.end <= now ? tr('search.menu.watchCatchup') : tr('search.menu.watchFromStart'), action: () => IPTV.catchup.play(h.channel, h.program) });
      }
      if (h.program.start > now) {
        items.push({ label: IPTV.reminders.has(h.channel, h.program) ? tr('search.menu.removeReminder') : tr('search.menu.remindMe'), action: () => { IPTV.reminders.toggle(h.channel, h.program); setTimeout(search, 50); } });
      }
      UI.menu({ title: h.program.title, subtitle: h.channel.name + ' · ' + u.time(h.program.start) + '–' + u.time(h.program.end), items });
      return;
    }
    if (!hit || hit.kind !== 'live') return;
    const ch = hit.item;
    const fav = IPTV.isFavorite(ch.id);
    UI.menu({
      title: ch.name,
      items: [
        { label: tr('search.menu.watch'), action: () => IPTV.live.tune(ch, { list: hit.shelf.items }) },
        fav
          ? { label: tr('search.menu.removeFavourite'), danger: true, action: () => { IPTV.toggleFavorite(ch); UI.toast(tr('search.favRemoved', { name: ch.name })); setTimeout(search, 50); } }
          : { label: tr('search.menu.addFavourite'), action: () => { IPTV.toggleFavorite(ch); UI.toast(tr('search.favAdded', { name: ch.name })); setTimeout(search, 50); } }
      ]
    });
  });

  // Type with the computer's keyboard in the preview (the browser).
  function browserTyping(name, e) {
    if (TV.isTV || !e || e.ctrlKey || e.metaKey || e.altKey) return false;
    const cur = Nav.current();
    if (!cur || !root.contains(cur) || !cur.classList.contains('kb-key')) return false;
    if (e.key === 'Backspace' && kb.value()) { kb.backspace(); return true; }
    if (e.key && e.key.length === 1 && /[\wåäöÅÄÖ .&-]/.test(e.key)) {
      kb.type(e.key.toLowerCase());
      return true;
    }
    return false;
  }

  function onKey(name, e) {
    if (browserTyping(name, e)) return true;
    const cur = Nav.current();
    if (!cur || !root.contains(cur)) return false;
    if (name === 'yellow') {
      const hit = itemOf(cur);
      if (hit && hit.kind === 'live') {
        const was = IPTV.isFavorite(hit.item.id);
        IPTV.toggleFavorite(hit.item);
        UI.toast(was ? tr('search.favRemoved', { name: hit.item.name }) : tr('search.favAdded', { name: hit.item.name }));
        return true;
      }
    }
    const sh = cur.closest('.sr-shelf');
    if (sh) {
      const i = +sh.getAttribute('data-si');
      if (name === 'up' || name === 'down') {
        const j = i + (name === 'up' ? -1 : 1);
        if (j < 0) { IPTV.ui.focusTabs(); return true; }
        if (j >= shelves.length) return true;
        const t = shelves[j].el.querySelector('.shelf-track');
        const f = t.querySelector('[data-last-focus]') || t.querySelector('[data-focusable]');
        if (f) Nav.focus(f, { force: true });
        return true;
      }
      if (name === 'back') {
        Nav.focus(q('.kb-key'), { force: true });
        return true;
      }
      return false;
    }
    if (cur.classList.contains('kb-key')) {
      // Top key row -> the tab bar.
      if (name === 'up' && cur.getBoundingClientRect().top < q('.sr-kb').getBoundingClientRect().top + 30) {
        IPTV.ui.focusTabs();
        return true;
      }
      // The edges: right goes to the results (never up to the tab bar), left stays.
      const r = cur.getBoundingClientRect();
      const k = q('.sr-kb').getBoundingClientRect();
      if (name === 'right' && r.right > k.right - 8) return focusResults();
      if (name === 'left' && r.left < k.left + 8) return true;
    }
    return false;
  }

  function focusResults() {
    const s = shelves[shelfIndex] || shelves[0];
    if (!s) return true;
    const f = s.el.querySelector('[data-last-focus]') || s.el.querySelector('[data-focusable]');
    if (f) Nav.focus(f, { force: true });
    return true;
  }

  scopeLabel();
  state('hint');

  IPTV.ui.registerTab('search', {
    el: root,
    show() {
      if (!IPTV.configured()) state('setup');
      else if (!kb.value()) state('hint');
    },
    resume() {},
    hide() {},
    enter: () => root.querySelector('.kb-key[data-last-focus]') || kb.first(),
    onKey
  });

  IPTV.search = { set: (v) => kb.set(v), value: () => kb.value(), last: () => lastQuery };
})(window);
