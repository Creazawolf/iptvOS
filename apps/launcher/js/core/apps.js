/*
 * Apps — everything that can be launched: built-in views, the TV's installed apps and HDMI inputs.
 *
 * The list comes from the launcher's root service (listLaunchPoints + eim). Without root only
 * built-in views and the inputs are shown (they can be read anyway) – never made-up apps. The last
 * known list is saved, so the dock is there immediately at startup.
 *
 *   Apps.ready              Promise (first load done)
 *   Apps.state()            'loading' | 'ok' | 'cached' | 'noroot' | 'error'
 *   Apps.get(id)            app | null
 *   Apps.all()              visible apps + inputs (excluding hidden ones), in display order
 *   Apps.everything()       all, including hidden ones
 *   Apps.dock()             the favourites in the dock (only those that exist)
 *   Apps.launch(id)         Promise
 *   Apps.refresh()          load again
 *   Apps.onChange(fn)
 *
 * app = { id, title, kind: 'internal'|'app'|'input', icon, iconColor, bgImage, systemApp, params,
 *         subtitle?, input?: { id, port, connected, brand, deviceName, type, label } }
 */
(function (global) {
  'use strict';

  const CACHE_KEY = 'g3:apps:v3';
  const RETRY_MS = 30000;

  const INTERNAL = [
    { id: 'internal:tv', title: 'TV', kind: 'internal', view: 'tv' },
    { id: 'internal:settings', title: tr('common.settings'), kind: 'internal', view: 'settings' },
    // Actions that look like apps: turn off the screen (sound keeps playing) and LG's own home screen.
    { id: 'internal:screenoff', title: tr('apps.screenOff'), kind: 'internal', action: 'screenoff', subtitle: tr('apps.screenOffSub') },
    { id: 'internal:lghome', title: 'LG webOS', kind: 'internal', action: 'lghome', subtitle: tr('apps.lgHomeSub') }
  ];

  // LG appends the device type to the input's name ("PS5 Spelkonsol", Swedish for "PS5 Game console"),
  // so the pattern matches Swedish and English suffixes. Show only the device.
  const TYPE_SUFFIX = /\s+(spelkonsol|game ?console|konsol|set-?top-?box|digitalbox|tv-box|mediaspelare|media ?player|streaming(enhet)?|blu-?ray(-?spelare)?|dvd(-?spelare)?|soundbar|hemmabio(system)?|dator|pc|laptop|kamera|camera|stb|receiver|mottagare)$/i;

  let catalog = {};
  let order = [];
  let state = 'loading';
  let retryTimer = null;
  const listeners = [];

  function inputApp(d) {
    const port = d.port || (String(d.id).match(/\d+/) || [''])[0];
    let title = String(d.label || '').replace(TYPE_SUFFIX, '').trim();
    if (!title || /^hdmi\s*\d*$/i.test(title)) title = (d.deviceName || d.brand || '').trim() || 'HDMI ' + port;
    return {
      id: d.appId || 'com.webos.app.hdmi' + port,
      title,
      kind: 'input',
      subtitle: 'HDMI ' + port + (d.connected ? '' : ' · ' + tr('apps.notConnected')),
      input: d
    };
  }

  function appFrom(p) {
    return {
      id: p.id,
      title: p.title || p.id,
      kind: 'app',
      icon: p.icon || '',
      iconColor: p.iconColor || p.bgColor || '',
      bgImage: p.bgImage || '',
      systemApp: !!p.systemApp,
      removable: !!p.removable,
      installTime: p.installTime || 0,
      params: p.params || null
    };
  }

  function build(data) {
    catalog = {};
    order = [];
    const add = (a) => {
      if (!a || !a.id || a.id === Root.APP_ID) return;
      if (!catalog[a.id]) order.push(a.id);
      catalog[a.id] = a;
    };
    INTERNAL.forEach(add);
    const inputs = (data && data.inputs) || [];
    const inputIds = {};
    inputs.forEach((d) => { if (d.appId) inputIds[d.appId] = true; });
    ((data && data.apps) || []).forEach((p) => {
      // HDMI bookmarks are replaced by the input (with its real name and status).
      if (inputIds[p.id] || /^com\.webos\.app\.hdmi\d$/.test(p.id)) return;
      add(appFrom(p));
    });
    inputs.forEach((d) => add(inputApp(d)));
  }

  // Only notify when something has actually changed (state, apps, the inputs' status).
  let lastSig = '';
  function emit() {
    const sig = state + '|' + order.map((id) => {
      const a = catalog[id];
      return id + ':' + a.title + (a.input ? ':' + a.input.connected : '') + ':' + (a.installTime || '');
    }).join(',');
    if (sig === lastSig) return;
    lastSig = sig;
    listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) { return null; }
  }

  function saveCache(data) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), apps: data.apps, inputs: data.inputs })); } catch (e) { /* full */ }
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { refresh(); }, RETRY_MS);
  }

  function refresh() {
    return Root.apps().then((data) => {
      clearTimeout(retryTimer);
      state = 'ok';
      saveCache(data);
      build(data);
      emit();
    }, (err) => {
      // No root (yet): we can read the inputs anyway.
      const cached = loadCache();
      return Root.inputs().catch(() => []).then((inputs) => {
        if (cached && cached.apps && cached.apps.length) {
          state = 'cached';
          build({ apps: cached.apps, inputs: inputs.length ? inputs : cached.inputs });
        } else {
          state = err.code === 'NOT_ROOT' ? 'noroot' : 'error';
          build({ apps: [], inputs });
        }
        emit();
        scheduleRetry();
      });
    });
  }

  // Start immediately with the last known list.
  const first = loadCache();
  if (first && first.apps) { build(first); state = 'cached'; } else build(null);
  const ready = refresh();

  function launch(id) {
    const app = catalog[id];
    if (app && app.kind === 'internal' && app.action) {
      if (!TV.isTV) { UI.toast(tr('apps.tvOnly', { name: app.title })); return Promise.resolve(); }
      return app.action === 'screenoff' ? Root.screen('off') : Root.lgHome();
    }
    if (app && app.kind === 'internal') {
      // The TV view may not be loaded yet (see js/iptv/lazy.js) – go via IPTV.open.
      if (app.view === 'tv' && global.IPTV && IPTV.open) return Promise.resolve(IPTV.open({ tab: 'live' }));
      Router.go(app.view);
      return Promise.resolve();
    }
    return TV.launch(id, app && app.params ? app.params : undefined);
  }

  function rank(a) {
    if (a.kind === 'internal') return 0;
    if (a.kind === 'app' && !a.systemApp) return 1;
    if (a.kind === 'input') return 2;
    return 3;
  }

  function everything() {
    return order.map((id) => catalog[id]).sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r) return r;
      if (a.kind === 'input' && b.kind === 'input') {
        if (!!b.input.connected !== !!a.input.connected) return b.input.connected ? 1 : -1;
        return (a.input.port || 0) - (b.input.port || 0);
      }
      return a.title.localeCompare(b.title, I18n.locale);
    });
  }

  const hidden = () => Store.get('hiddenApps') || [];

  global.Apps = {
    ready,
    refresh,
    state: () => state,
    onChange: (fn) => listeners.push(fn),
    get: (id) => catalog[id] || null,
    everything,
    all: () => { const h = hidden(); return everything().filter((a) => h.indexOf(a.id) < 0); },
    dock: () => (Store.get('favorites.apps') || []).map((id) => catalog[id]).filter(Boolean),
    launch
  };
})(window);
