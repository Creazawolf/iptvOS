/*
 * Settings — tvOS style: large icon on the left, list on the right.
 * Router.go('settings', { section: 'dock' }) opens directly on a subpage.
 * With { section, root: true } the subpage is the topmost (Back leaves settings) – this is how
 * the TV app opens its own settings.
 *
 * Other modules can add pages: window.SETTINGS_PAGES = { id: factory(h) } (see docs/ARCHITECTURE.md §4).
 * Rows with `move` are moved in place: hold OK, move with up/down, OK or Back when you are done.
 */
(function () {
  'use strict';

  const VERSION = '3.4.0';
  const el = document.querySelector('[data-view="settings"]');
  const esc = UI.esc;

  el.innerHTML =
    '<aside class="set-side"><div class="set-icon"></div><h1 class="set-title"></h1><p class="set-desc"></p></aside>' +
    '<div class="set-viewport" data-vscroll-viewport><div class="set-list" data-vscroll-track data-scroll-edge="160"></div></div>';

  const iconEl = el.querySelector('.set-icon');
  const titleEl = el.querySelector('.set-title');
  const descEl = el.querySelector('.set-desc');
  const listEl = el.querySelector('.set-list');

  let stack = ['main'];
  let rows = [];
  let visible = false;
  let moving = -1;          // index of the row being moved
  const asyncState = {};    // e.g. root status

  const SECTION_NAMES = {
    channels: tr('settings.sections.channels'),
    continue: tr('settings.sections.continue'),
    apps: tr('settings.sections.apps'),
    widgets: tr('settings.sections.widgets')
  };
  const IDLE_STEPS = [0, 2, 5, 10, 20, 30];
  const WP_STEPS = [0, 5, 10, 20, 30, 60];
  const FILM_STEPS = [15, 30, 60, 120, 0]; // minutes of aerial video per ambient session (0 = no limit)

  // --- Helpers ---------------------------------------------------------------------

  const toggle = (label, get, set, extra) => Object.assign({ type: 'toggle', label, get, set }, extra || {});
  const nav = (label, to, extra) => Object.assign({ type: 'nav', label, to }, extra || {});
  const action = (label, run, extra) => Object.assign({ type: 'action', label, run }, extra || {});
  const note = (text) => ({ type: 'note', text });
  const info = (label, value, extra) => Object.assign({ type: 'info', label, value }, extra || {});

  // Choice among several: the row shows the selected one, OK opens a menu. options = [{ v, label, detail? }]
  function pick(label, options, current, apply, extra) {
    const cur = options.find((o) => o.v === current) || options[0];
    return action(label, () => UI.menu({
      title: label,
      subtitle: (extra && extra.help) || '',
      stacked: true,
      items: options.map((o) => ({
        label: (o === cur ? '✓  ' : '') + o.label,
        detail: o.detail || '',
        action: () => { apply(o.v); render(); }
      }))
    }), Object.assign({ value: cur.short || cur.label }, extra || {}));
  }

  function moveInList(path, idOf, id, delta) {
    const list = (Store.get(path) || []).slice();
    const i = list.findIndex((x) => idOf(x) === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return false;
    list.splice(j, 0, list.splice(i, 1)[0]);
    Store.set(path, list);
    return true;
  }

  function editValue(opts, apply) {
    UI.prompt(opts).then((v) => {
      if (v == null) return;
      apply(v.trim());
      render();
    });
  }

  const cycle = (steps, cur) => steps[(Math.max(0, steps.indexOf(cur)) + 1) % steps.length];

  // Thumbnail of the app's tile (the dock picker, hidden apps).
  function thumb(a) {
    const art = Art.get(a);
    const f = Art.face(a, art);
    return '<span class="row-thumb' + (f.dim ? ' is-dim' : '') + (art ? '' : ' needs-art') + '" data-app="' + esc(a.id) + '" style="' + f.style + '">' + f.html + '</span>';
  }

  function hydrateThumbs() {
    listEl.querySelectorAll('.row-thumb.needs-art').forEach((t) => {
      const a = Apps.get(t.getAttribute('data-app'));
      if (!a) return;
      Art.load(a).then((art) => {
        const f = Art.face(a, art);
        t.classList.remove('needs-art');
        t.setAttribute('style', f.style);
        t.innerHTML = f.html;
      });
    });
  }

  // --- Pages --------------------------------------------------------------------------

  const PAGES = {
    main: () => {
      const iptvPage = !!(window.SETTINGS_PAGES && window.SETTINGS_PAGES.iptv);
      const st = asyncState.root;
      return {
        title: tr('common.settings'),
        icon: 'gear',
        desc: tr('settings.main.desc'),
        rows: [
          nav(tr('settings.home.title'), 'home', { icon: 'layout' }),
          nav(tr('settings.dock.title'), 'dock', { icon: 'dock', value: String(Apps.dock().length) }),
          nav(tr('settings.wallpaper.title'), 'wallpaper', { icon: 'image', value: wallpaperSummary() }),
          nav(tr('settings.weather.title'), 'weather', { icon: 'cloud-sun', value: Store.get('weather.name') || '' }),
          pick(tr('settings.language'),
            [{ v: 'auto', label: tr('settings.languageAuto') }].concat(I18n.langs.map((l) => ({ v: l.id, label: l.name }))),
            I18n.pref(), (v) => I18n.set(v), { icon: 'globe', help: tr('settings.languageHelp') }),
          iptvPage && nav('IPTV', 'iptv', { icon: 'tv', value: window.IPTV && IPTV.configured && IPTV.configured() ? tr('settings.main.iptvOn') : tr('settings.main.iptvOff') }),
          nav(tr('settings.shortcuts.title'), 'shortcuts', { icon: 'moon' }),
          nav(tr('settings.root.title'), 'root', { icon: 'power', value: st ? (st.root ? 'Root' : tr('settings.noRoot')) : '' }),
          nav(tr('settings.about.title'), 'about', { icon: 'info', value: VERSION })
        ]
      };
    },

    home: () => {
      const sections = Store.get('layout.sections') || [];
      const min = +Store.get('ambientAfterMinutes') || 0;
      const hidden = (Store.get('hiddenApps') || []).length;
      return {
        title: tr('settings.home.title'),
        icon: 'layout',
        desc: tr('settings.home.desc'),
        keep: true,
        rows: [note(tr('settings.home.rows'))]
          .concat(sections.map((s) => toggle(SECTION_NAMES[s.id] || s.id,
            () => s.visible,
            (v) => Store.set('layout.sections', sections.map((x) => (x.id === s.id ? Object.assign({}, x, { visible: v }) : x))),
            { move: (d) => moveInList('layout.sections', (x) => x.id, s.id, d) }
          )))
          .concat([
            note(tr('settings.home.look')),
            toggle(tr('settings.home.statusWeather'), () => Store.get('layout.statusWeather') !== false, (v) => Store.set('layout.statusWeather', v),
              { detail: tr('settings.home.statusWeatherDetail') }),
            toggle(tr('settings.home.lite'), () => !!Store.get('layout.lite'), (v) => Store.set('layout.lite', v),
              { detail: tr('settings.home.liteDetail') }),
            action(tr('settings.idle.after'), () => { Store.set('ambientAfterMinutes', cycle(IDLE_STEPS, min)); Idle.reset(); },
              { value: min ? tr('common.minutesShort', { n: min }) : tr('common.off') }),
            note(tr('settings.home.apps')),
            nav(tr('settings.hidden.title'), 'hidden', { value: String(hidden) }),
            action(tr('settings.reloadApps'), () => {
              UI.toast(tr('common.loading'));
              Apps.refresh().then(() => UI.toast(tr('settings.appsCount', { n: Apps.everything().length })));
            }, { icon: 'refresh' })
          ])
      };
    },

    dock: () => {
      const fav = Store.get('favorites.apps') || [];
      const inDock = fav.map((id) => Apps.get(id)).filter(Boolean);
      const rest = Apps.everything().filter((a) => fav.indexOf(a.id) < 0);
      const row = (a, on) => toggle(a.title,
        () => (Store.get('favorites.apps') || []).indexOf(a.id) >= 0,
        (v) => {
          const list = (Store.get('favorites.apps') || []).filter((x) => x !== a.id);
          if (v) list.push(a.id);
          Store.set('favorites.apps', list);
        },
        {
          thumb: thumb(a),
          detail: a.kind === 'input' ? a.subtitle : a.kind === 'internal' ? tr('settings.dock.builtIn') : '',
          move: on ? (d) => {
            // Move among the favourites that exist on the TV.
            const list = (Store.get('favorites.apps') || []).slice();
            const present = list.filter((x) => Apps.get(x));
            const pi = present.indexOf(a.id);
            const pj = pi + d;
            if (pi < 0 || pj < 0 || pj >= present.length) return false;
            const i = list.indexOf(a.id);
            const j = list.indexOf(present[pj]);
            list[i] = present[pj];
            list[j] = a.id;
            Store.set('favorites.apps', list);
            return true;
          } : null
        });
      return {
        title: tr('settings.dock.title'),
        icon: 'dock',
        desc: tr('settings.dock.desc'),
        keep: true,
        rows: [note(tr('settings.dock.inDock'))]
          .concat(inDock.length ? inDock.map((a) => row(a, true)) : [note(tr('settings.dock.none'))])
          .concat([note(tr('settings.dock.others'))])
          .concat(rest.map((a) => row(a, false)))
          .concat(Apps.state() === 'noroot' || Apps.state() === 'error'
            ? [note(tr('settings.dock.needRoot'))] : [])
      };
    },

    hidden: () => {
      const hidden = Store.get('hiddenApps') || [];
      return {
        title: tr('settings.hidden.title'),
        icon: 'eye-off',
        desc: tr('settings.hidden.desc'),
        rows: hidden.length
          ? hidden.map((id) => {
            const a = Apps.get(id);
            return action(a ? a.title : id, () => {
              Store.set('hiddenApps', (Store.get('hiddenApps') || []).filter((x) => x !== id));
              UI.toast(tr('settings.hidden.shown'));
            }, { thumb: a ? thumb(a) : '', value: tr('settings.hidden.show'), detail: a ? '' : tr('settings.hidden.missing') });
          })
          : [note(tr('settings.hidden.none'))]
      };
    },

    wallpaper: () => {
      const chosen = Wallpaper.sets();
      const min = +Store.get('layout.wallpaperMinutes') || 0;
      const idleMin = +Store.get('ambientAfterMinutes') || 0;
      const cur = Wallpaper.current();
      const list = asyncState.wpSets || Wallpaper.known();
      const hubOk = Wallpaper.hubReady();
      const amb = Store.get('ambient') || {};
      const aerial = hubOk && amb.mode === 'aerial';
      const filmMax = amb.maxMinutes == null ? 60 : +amb.maxMinutes || 0;
      const src = amb.sources || {};
      const setOn = (id) => (v) => {
        const now = Wallpaper.sets().filter((x) => x !== id);
        if (v) now.push(id);
        Wallpaper.setSets(now);
      };
      const srcOn = (id) => (v) => Store.set('ambient.sources', Object.assign({ apple: src.apple !== false, community: src.community !== false, amazon: src.amazon === true }, { [id]: v }));
      return {
        title: tr('settings.wallpaper.title'),
        icon: 'image',
        desc: tr('settings.wallpaper.desc'),
        rows: [note(tr('settings.wallpaper.collections'))]
          .concat(list.map((c) => toggle(c.title, () => chosen.indexOf(c.id) >= 0, setOn(c.id), {
            detail: c.detail + ' · ' + (c.count ? tr('settings.wallpaper.pictures', { n: c.count }) : c.error ? tr('settings.wallpaper.unavailable') : tr('settings.wallpaper.fetching'))
          })))
          .concat([
            !hubOk && note(tr('settings.wallpaper.moreFromHub')),
            note(tr('settings.wallpaper.rotation')),
            action(tr('settings.wallpaper.every'), () => Store.set('layout.wallpaperMinutes', cycle(WP_STEPS, min)), { value: min ? tr('common.minutesShort', { n: min }) : tr('settings.wallpaper.never') }),
            action(tr('settings.wallpaper.next'), () => Wallpaper.next().then(() => render()), { icon: 'refresh' }),
            cur ? note(tr('settings.wallpaper.now', { name: [cur.title, cur.credit].filter(Boolean).join(' — ') || tr('settings.wallpaper.untitled') })) : null,
            note(tr('settings.idle.title')),
            action(tr('settings.idle.after'), () => { Store.set('ambientAfterMinutes', cycle(IDLE_STEPS, idleMin)); Idle.reset(); },
              { value: idleMin ? tr('common.minutesShort', { n: idleMin }) : tr('common.off'), detail: tr('settings.idle.afterDetail') }),
            hubOk && pick(tr('settings.idle.shows'), [
              { v: 'images', label: tr('settings.idle.images'), detail: tr('settings.idle.imagesDetail') },
              { v: 'aerial', label: tr('settings.idle.aerial'), detail: tr('settings.idle.aerialDetail') }
            ], aerial ? 'aerial' : 'images', (v) => Store.set('ambient.mode', v)),
            aerial && pick(tr('settings.idle.quality'), [
              { v: 'hd', label: '1080p', detail: tr('settings.idle.qualityHd') },
              { v: 'uhd', label: '4K', detail: tr('settings.idle.qualityUhd') },
              { v: 'hdr', label: '4K Dolby Vision', detail: tr('settings.idle.qualityHdr') }
            ], amb.quality || 'uhd', (v) => Store.set('ambient.quality', v)),
            aerial && action(tr('settings.idle.maxTime'), () => Store.set('ambient.maxMinutes', cycle(FILM_STEPS, filmMax)),
              { value: filmMax ? (filmMax >= 60 ? tr('settings.idle.hoursShort', { n: filmMax / 60 }) : tr('common.minutesShort', { n: filmMax })) : tr('settings.idle.noLimit'), detail: tr('settings.idle.maxTimeDetail') }),
            aerial && toggle('Apple TV', () => src.apple !== false, srcOn('apple'), { detail: tr('settings.idle.appleDetail') }),
            aerial && toggle(tr('settings.idle.community'), () => src.community !== false, srcOn('community'), { detail: tr('settings.idle.communityDetail') }),
            aerial && toggle('Amazon Fire TV', () => src.amazon === true, srcOn('amazon'), { detail: tr('settings.idle.amazonDetail') }),
            action(tr('settings.idle.showNow'), () => Idle.enter(), { icon: 'play', detail: tr('settings.idle.showNowDetail') })
          ])
      };
    },

    weather: () => {
      const w = Store.get('weather') || {};
      const now = window.Weather && Weather.current();
      return {
        title: tr('settings.weather.title'),
        icon: 'cloud-sun',
        desc: tr('settings.weather.desc'),
        rows: [
          action(tr('settings.weather.place'), searchCity, { value: w.name || '—' }),
          note(now ? tr('settings.weather.now', { temp: now.temp, text: now.text.toLowerCase(), time: Clock.hhmm(now.at) }) : tr('settings.weather.noData')),
          action(tr('settings.weather.update'), () => Weather.refresh().then(() => { UI.toast(tr('settings.weather.updated')); render(); }), { icon: 'refresh' })
        ]
      };
    },

    root: () => {
      const st = asyncState.root;
      if (!st) return { title: tr('settings.root.title'), icon: 'power', desc: '', rows: [note(tr('settings.checking'))] };
      const a = st.autostart || {};
      const rows = [
        info(tr('settings.root.status'), st.root ? tr('settings.root.isRoot') : st.missing ? tr('settings.root.missing') : tr('settings.noRoot'), { icon: st.root ? 'check-circle' : 'lock' })
      ];
      if (st.root) {
        rows.push(
          toggle(tr('settings.root.autostart'), () => a.installed && a.launch !== false, setAutostart,
            { detail: a.installed ? (a.running ? tr('settings.root.watcherRunning') : tr('settings.root.nextBoot')) : tr('settings.root.autostartDetail') }),
          toggle(tr('settings.root.homeButton'), () => a.installed && a.homeButton !== false, setHomeButton,
            { detail: tr('settings.root.homeButtonDetail') }),
          action(tr('settings.reloadApps'), () => Apps.refresh().then(() => UI.toast(tr('settings.appsCount', { n: Apps.everything().length }))), { icon: 'refresh' }),
          note(tr('settings.root.restored'))
        );
      } else {
        rows.push(
          note(tr('settings.root.why')),
          note(tr('settings.root.fromComputer')),
          { type: 'code', text: 'npm run tv -- root' },
          note(tr('settings.root.onTv')),
          { type: 'code', text: Root.fixCommand },
          action(tr('settings.root.checkAgain'), () => { asyncState.root = null; render(); loadRoot(true).then(() => Apps.refresh()); }, { icon: 'refresh' })
        );
      }
      return {
        title: tr('settings.root.title'),
        icon: 'power',
        desc: tr('settings.root.desc'),
        rows
      };
    },

    // Screen off (sound keeps playing) – from here, and from any app with a dedicated button.
    shortcuts: () => {
      const k = asyncState.keys;
      const st = asyncState.root || {};
      const rows = [
        action(tr('settings.shortcuts.screenOffNow'), screenOff, { icon: 'moon', detail: tr('settings.shortcuts.screenOffDetail') }),
        note(tr('settings.shortcuts.fromAnyApp'))
      ];
      if (!st.root) {
        rows.push(note(tr('settings.shortcuts.needRoot')));
      } else if (!k) {
        rows.push(note(tr('settings.checking')));
      } else if (!k.hook || !k.hook.installed) {
        rows.push(note(tr('settings.shortcuts.needHook')));
      } else {
        rows.push(
          action(tr('settings.shortcuts.key'), learnScreenKey, {
            icon: 'power',
            value: k.screenoff ? tr('settings.shortcuts.keyCode', { code: k.screenoff }) : tr('settings.shortcuts.noKey'),
            detail: tr('settings.shortcuts.keyDetail')
          }),
          k.screenoff && action(tr('settings.shortcuts.removeKey'), () => setScreenKey(null), { danger: true }),
          note(k.hook.active
            ? tr('settings.shortcuts.keyNote')
            : tr('settings.shortcuts.hookInactive'))
        );
      }
      rows.push(
        note(tr('settings.shortcuts.lgHome')),
        action(tr('settings.shortcuts.openLgHome'), lgHome, { icon: 'home', detail: tr('settings.shortcuts.openLgHomeDetail') }),
        note(tr('settings.shortcuts.tilesNote'))
      );
      return {
        title: tr('settings.shortcuts.title'),
        icon: 'moon',
        desc: tr('settings.shortcuts.desc'),
        rows
      };
    },

    about: () => {
      const st = asyncState.root || {};
      const states = {
        ok: tr('settings.about.states.ok'),
        cached: tr('settings.about.states.cached'),
        noroot: tr('settings.about.states.noroot'),
        error: tr('settings.about.states.error'),
        loading: tr('settings.about.states.loading')
      };
      return {
        title: tr('settings.about.title'),
        icon: 'info',
        desc: tr('settings.about.desc'),
        rows: [
          info(tr('settings.about.version'), VERSION),
          info(tr('settings.about.platform'), TV.isTV ? 'webOS' : tr('settings.about.browser')),
          info(tr('settings.about.service'), st.root ? 'Root' + (st.version ? ' · ' + st.version : '') : tr('settings.noRoot')),
          info(tr('settings.about.apps'), tr('settings.about.appsValue', { n: Apps.everything().length, state: states[Apps.state()] || '' })),
          note(tr('settings.about.credits')),
          note(tr('settings.about.imageCredits')),
          action(tr('settings.about.reset'), () => UI.confirm({
            title: tr('settings.about.resetTitle'), message: tr('settings.about.resetMessage'), ok: tr('settings.about.resetOk'), danger: true
          }).then((ok) => { if (ok) { Store.reset(); stack = ['main']; render(); UI.toast(tr('settings.about.resetDone')); } }), { danger: true })
        ]
      };
    }
  };

  // --- Actions -----------------------------------------------------------------------

  // The service replies in English – known error codes are shown in the app's language.
  function errText(e) {
    const code = e && e.code;
    if (code === 'NOT_ROOT') return tr('settings.errors.notRoot');
    if (code === 'NO_HOOK') return tr('settings.errors.noHook');
    if (code === 'RESERVED') return tr('settings.errors.reserved');
    if (code === 'IN_USE') return tr('settings.errors.inUse');
    if (code === 'NO_INPUT') return tr('settings.errors.noInput');
    return (e && e.message) || tr('common.unknownError');
  }

  function searchCity() {
    UI.prompt({ title: tr('settings.weather.choose'), label: tr('settings.weather.search'), value: '', placeholder: tr('settings.weather.example') }).then((q) => {
      if (!q || !q.trim()) return;
      Weather.search(q.trim()).then((list) => {
        if (!list.length) { UI.toast(tr('settings.weather.notFound', { q })); return; }
        UI.menu({
          title: tr('settings.weather.choose'),
          items: list.slice(0, 6).map((r) => ({
            label: r.name,
            detail: r.detail,
            action: () => { Store.set('weather', { name: r.name, latitude: r.latitude, longitude: r.longitude }); UI.toast(tr('settings.weather.chosen', { name: r.name })); render(); }
          }))
        });
      }, (e) => UI.toast(tr('settings.weather.searchFailed', { error: e.message }), 5000));
    });
  }

  // Short description of the selected collections for the main page.
  function wallpaperSummary() {
    const chosen = Wallpaper.sets();
    const known = asyncState.wpSets || Wallpaper.known();
    if (chosen.length === 1) return (known.find((c) => c.id === chosen[0]) || {}).title || tr('settings.wallpaper.sets', { n: 1 });
    return tr('settings.wallpaper.sets', { n: chosen.length });
  }

  function loadWallpaperSets() {
    return Wallpaper.available().then((list) => {
      asyncState.wpSets = list;
      if (visible && !UI.hasLayer() && moving < 0) render();
    });
  }

  function screenOff() {
    if (!TV.isTV) { UI.toast(tr('settings.shortcuts.tvOnly')); return; }
    Root.screen('off').catch((e) => UI.toast(tr('settings.shortcuts.screenOffFailed', { error: errText(e) }), 6000));
  }

  function lgHome() {
    Root.lgHome().catch((e) => UI.toast(tr('settings.shortcuts.lgHomeFailed', { error: errText(e) }), 6000));
  }

  function loadKeys() {
    return Root.keys({ op: 'get' }).then((k) => { asyncState.keys = k; }, () => { asyncState.keys = { hook: { installed: false } }; })
      .then(() => { if (visible && !UI.hasLayer() && moving < 0) render(); });
  }

  function setScreenKey(code) {
    return Root.keys(code ? { op: 'set', action: 'screenoff', code } : { op: 'clear', action: 'screenoff' })
      .then((k) => {
        asyncState.keys = k;
        render();
        UI.toast(code ? tr('settings.shortcuts.keySet') : tr('settings.shortcuts.keyRemoved'), 5000);
      }, (e) => UI.toast(tr('settings.failed', { error: errText(e) }), 6000));
  }

  // Learn a button: the service reads the TV's key presses for ten seconds and replies with the button's code.
  // Buttons needed to control the TV (arrows, OK, Back, Home) cannot be chosen.
  const NAV_KEYS = { left: 1, right: 1, up: 1, down: 1, enter: 1, back: 1 };
  function learnScreenKey() {
    let domKey = null;
    let done = false;
    const layer = UI.menu({
      title: tr('settings.shortcuts.pressTitle'),
      subtitle: tr('settings.shortcuts.pressMessage'),
      items: [{ label: tr('common.cancel'), action: () => { done = true; } }]
    });
    layer.onCancel = () => { done = true; };
    // The key press also reaches the app: remember which one it was and do not let it do anything else here.
    layer.onKey = (name) => {
      if (name === 'enter' || name === 'back') { domKey = name; return false; }
      domKey = name || 'other';
      return true;
    };
    Root.keys({ op: 'learn', timeout: 10000 }).then((r) => new Promise((resolve) => setTimeout(() => resolve(r), 200))).then((r) => {
      if (done) return;
      if (!layer.closed) UI.close(layer);
      if (NAV_KEYS[domKey] || r.reserved) {
        UI.toast(tr('settings.shortcuts.reservedPickAnother'), 5000);
        return;
      }
      UI.confirm({
        title: tr('settings.shortcuts.useKeyTitle', { code: r.code }),
        message: tr('settings.shortcuts.useKeyMessage'),
        ok: tr('settings.shortcuts.useKey')
      }).then((ok) => { if (ok) setScreenKey(r.code); });
    }, (e) => {
      if (done) return;
      if (!layer.closed) UI.close(layer);
      UI.toast(/TIMEOUT/.test(e.code || '') || /timeout/i.test(e.message) ? tr('settings.shortcuts.noKeyPressed') : tr('settings.failed', { error: errText(e) }), 5000);
    });
  }

  function setHomeButton(on) {
    Root.autostart({ homeButton: on })
      .then(() => loadRoot(true))
      .then(() => UI.toast(on ? tr('settings.root.homeButton') : tr('settings.root.homeButtonOff')))
      .catch((e) => UI.toast(tr('settings.failed', { error: errText(e) }), 6000));
  }

  function setAutostart(on) {
    UI.toast(on ? tr('settings.root.autostartEnabling') : tr('settings.root.autostartDisabling'));
    Root.autostart({ enable: on })
      .then(() => loadRoot(true))
      .then(() => UI.toast(on ? tr('settings.root.autostartOn') : tr('settings.root.autostartOff')))
      .catch((e) => UI.toast(tr('settings.failed', { error: errText(e) }), 6000));
  }

  function loadRoot(force) {
    return Root.status(force).then((st) => {
      asyncState.root = st;
      if (visible && !UI.hasLayer() && moving < 0) render();
    });
  }

  // --- Rendering ------------------------------------------------------------------------

  const helpers = { toggle, nav, action, note, info, pick, edit: editValue, render: () => render(), moveInList };
  const extra = window.SETTINGS_PAGES || {};
  Object.keys(extra).forEach((id) => { PAGES[id] = () => extra[id](helpers); });

  function rowHtml(r, i) {
    if (r.type === 'note') return '<p class="set-note">' + esc(r.text) + '</p>';
    if (r.type === 'code') return '<pre class="set-code">' + esc(r.text) + '</pre>';
    const on = r.type === 'toggle' ? !!r.get() : false;
    const check = r.thumb
      ? '<span class="row-check' + (on ? ' is-on' : '') + '">' + Icons.svg(on ? 'check-circle' : 'circle') + '</span>'
      : '<span class="switch' + (on ? ' is-on' : '') + '"></span>';
    return (
      '<button class="list-row' + (r.danger ? ' is-danger' : '') + (r.type === 'info' ? ' is-info' : '') + (r.thumb ? ' has-thumb' : '') +
      (i === moving ? ' is-moving' : '') + '" data-focusable data-i="' + i + '">' +
      (r.thumb ? r.thumb : r.icon ? '<span class="row-icon">' + Icons.svg(r.icon) + '</span>' : '') +
      '<span class="row-label">' + esc(r.label) + (r.detail ? '<small>' + esc(r.detail) + '</small>' : '') + '</span>' +
      (r.value != null && r.value !== '' ? '<span class="row-value">' + esc(r.value) + '</span>' : '') +
      (r.type === 'toggle' ? check : '') +
      (r.type === 'nav' ? '<span class="row-chevron">' + Icons.svg('chevron') + '</span>' : '') +
      (i === moving ? '<span class="row-move">' + Icons.svg('move-v') + '</span>' : '') +
      '</button>'
    );
  }

  function render(focusIndex) {
    const id = stack[stack.length - 1];
    const page = PAGES[id]();
    const prev = Nav.current() && el.contains(Nav.current()) ? Nav.current() : null;
    const prevIdx = prev ? +prev.getAttribute('data-i') : null;
    const prevLabel = prev && rows[prevIdx] ? rows[prevIdx].label : null;
    rows = page.rows.filter(Boolean);

    iconEl.innerHTML = Icons.svg(page.icon);
    titleEl.textContent = page.title;
    descEl.textContent = page.desc || '';
    listEl.innerHTML = rows.map(rowHtml).join('');

    let want = focusIndex;
    // Lists that change order (the dock picker): follow the row, not the position.
    if (want == null && page.keep && prevLabel) {
      const j = rows.findIndex((r) => r.label === prevLabel && r.type !== 'note');
      if (j >= 0) want = j;
    }
    if (want == null) want = prevIdx;
    const target = (want != null && listEl.querySelector('[data-i="' + want + '"]')) || listEl.querySelector('[data-focusable]');
    if (visible && target) Nav.focus(target, { force: true });
    hydrateThumbs();
  }

  function resetScroll() {
    listEl.dataset.offset = '0';
    listEl.style.transform = '';
  }

  function open(id) {
    stack.push(id);
    if (id === 'root' || id === 'about' || id === 'shortcuts') loadRoot(true);
    if (id === 'shortcuts') loadKeys();
    if (id === 'wallpaper') loadWallpaperSets();
    resetScroll();
    render(0);
  }

  function back() {
    if (stack.length <= 1) return false;
    const from = stack.pop();
    const page = PAGES[stack[stack.length - 1]]();
    const idx = page.rows.filter(Boolean).findIndex((r) => r.to === from);
    resetScroll();
    render(idx >= 0 ? idx : 0);
    return true;
  }

  el.addEventListener('nav:activate', (e) => {
    if (moving >= 0) return;
    const r = rows[+e.target.getAttribute('data-i')];
    if (!r) return;
    if (r.type === 'nav') {
      open(r.to);
    } else if (r.type === 'toggle') {
      r.set(!r.get());
      render();
    } else if (r.type === 'action') {
      r.run();
      setTimeout(() => { if (!UI.hasLayer()) render(); }, 50);
    }
  });

  el.addEventListener('nav:longpress', (e) => {
    const i = +e.target.getAttribute('data-i');
    const r = rows[i];
    if (!r || !r.move) return;
    moving = i;
    render(i);
    UI.toast(tr('settings.moveHint'), 3500);
  });

  function moveRow(delta) {
    const r = rows[moving];
    if (!r || !r.move) return;
    const label = r.label;
    if (r.move(delta) === false) {
      Nav.bump(Nav.current(), 'left');
      return;
    }
    // The row has moved – find it again.
    const fresh = PAGES[stack[stack.length - 1]]().rows.filter(Boolean);
    moving = fresh.findIndex((x) => x.label === label && x.move);
    render(moving);
  }

  Store.on(() => { if (visible && !UI.hasLayer() && moving < 0) render(); });
  Apps.onChange(() => { if (visible && !UI.hasLayer() && moving < 0) render(); });

  Router.register('settings', {
    el,
    show(params) {
      visible = true;
      moving = -1;
      el.classList.remove('view-enter');
      void el.offsetWidth;
      el.classList.add('view-enter');
      stack = ['main'];
      if (params && params.section && PAGES[params.section]) {
        if (params.root) stack = [params.section];
        else stack.push(params.section);
        if (params.section === 'shortcuts') loadKeys();
        if (params.section === 'wallpaper') loadWallpaperSets();
      }
      resetScroll();
      loadRoot();
      render(0);
    },
    resume() { visible = true; render(); },
    hide() { visible = false; moving = -1; },
    onKey(name, e) {
      if (moving >= 0) {
        if (name === 'enter' && e && e.repeat) return true; // OK is still held down after the long press
        if (name === 'up' || name === 'down') moveRow(name === 'up' ? -1 : 1);
        else if (name === 'enter' || name === 'back') { moving = -1; render(); }
        return true;
      }
      if (name === 'back') return back();
      return false;
    }
  });
})();
