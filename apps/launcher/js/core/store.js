/*
 * Store — settings and favourites. Defaults (config.js) + config.local.js
 * + what has been saved on the TV (localStorage). Arrays are replaced, objects are merged.
 *
 *   Store.get('weather.name')
 *   Store.set('iptv.format', 'ts')
 *   Store.on((path) => …)      // called on every change
 */
(function (global) {
  'use strict';

  const KEY = 'g3:settings:v1';
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

  function merge(base, over) {
    if (!isObj(base) || !isObj(over)) return over === undefined ? base : clone(over);
    const out = clone(base);
    Object.keys(over).forEach((k) => {
      out[k] = isObj(out[k]) && isObj(over[k]) ? merge(out[k], over[k]) : clone(over[k]);
    });
    return out;
  }

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }

  // v2 → v3: the dock is no longer one row among others, top shelf always on, new defaults.
  const V2_FAVORITES = ['internal:tv', 'netflix', 'youtube.leanback.v4', 'com.disney.disneyplus-prod', 'spotify-beehive', 'com.webos.app.hdmi1', 'internal:settings'];
  function migrate(s) {
    if (!isObj(s) || s.version === 3) return s;
    const out = clone(s);
    out.version = 3;
    const fav = out.favorites || {};
    // Untouched default favourites from v2 (apps that do not even exist on the TV) → new defaults.
    if (Array.isArray(fav.apps)) {
      if (JSON.stringify(fav.apps) === JSON.stringify(V2_FAVORITES)) delete fav.apps;
      else fav.apps = fav.apps.filter((id) => id !== 'internal:apps');
    }
    const layout = out.layout || {};
    if (Array.isArray(layout.sections)) {
      const old = {};
      layout.sections.forEach((x) => { old[x.id] = x.visible; });
      layout.sections = [
        { id: 'channels', visible: old.channels !== false },
        { id: 'continue', visible: true },
        { id: 'apps', visible: true },
        { id: 'widgets', visible: false }
      ];
    }
    delete layout.topShelf;
    if (Array.isArray(out.hiddenApps) && !out.hiddenApps.length) delete out.hiddenApps;
    if (Array.isArray(out.widgets) && JSON.stringify(out.widgets) === '["weather","live","clock"]') delete out.widgets;
    try { localStorage.setItem(KEY, JSON.stringify(out)); } catch (e) { /* full */ }
    return out;
  }

  // 3.2: the "Screen off" and "LG webOS" tiles are added at the end of the dock once (if the user has changed the dock –
  // otherwise they come with the defaults). They can be removed like any other app.
  const NEW_TILES = ['internal:screenoff', 'internal:lghome'];
  function addNewTiles(s) {
    if (!isObj(s) || s.tiles32) return s;
    const out = clone(s);
    out.tiles32 = true;
    const fav = out.favorites && Array.isArray(out.favorites.apps) ? out.favorites.apps : null;
    if (fav) NEW_TILES.forEach((id) => { if (fav.indexOf(id) < 0) fav.push(id); });
    try { localStorage.setItem(KEY, JSON.stringify(out)); } catch (e) { /* full */ }
    return out;
  }

  const defaults = merge(global.LAUNCHER_DEFAULTS || {}, global.LAUNCHER_LOCAL || {});
  let saved = addNewTiles(migrate(read()));
  let state = merge(defaults, saved);
  const listeners = [];
  let saveTimer = null;

  function walk(obj, path, create) {
    const parts = path.split('.');
    const last = parts.pop();
    let o = obj;
    for (const p of parts) {
      if (!isObj(o[p])) {
        if (!create) return { parent: null, key: last };
        o[p] = {};
      }
      o = o[p];
    }
    return { parent: o, key: last };
  }

  function get(path) {
    if (!path) return state;
    const w = walk(state, path, false);
    return w.parent ? w.parent[w.key] : undefined;
  }

  // Write to localStorage when the TV is idle (not in the middle of a key press or a channel start),
  // after 2 s at the latest – and immediately if the app is hidden.
  function writeNow() {
    if (!saveTimer) return;
    if (global.cancelIdleCallback && saveTimer.idle) global.cancelIdleCallback(saveTimer.id);
    else clearTimeout(saveTimer.id);
    saveTimer = null;
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { console.warn('[store] could not save', e); }
  }

  function persist() {
    if (saveTimer) return;
    saveTimer = global.requestIdleCallback
      ? { idle: true, id: global.requestIdleCallback(() => writeNow(), { timeout: 2000 }) }
      : { idle: false, id: setTimeout(() => writeNow(), 250) };
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) writeNow(); });
  global.addEventListener('pagehide', writeNow);

  function set(path, value) {
    const v = clone(value);
    let w = walk(state, path, true);
    w.parent[w.key] = v;
    w = walk(saved, path, true);
    w.parent[w.key] = clone(v);
    persist();
    listeners.forEach((fn) => { try { fn(path, v); } catch (e) { console.error(e); } });
  }

  function reset() {
    saved = { version: 3, tiles32: true };
    state = merge(defaults, {});
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    listeners.forEach((fn) => fn('*'));
  }

  const on = (fn) => { listeners.push(fn); };

  // --- Favourites -----------------------------------------------------------

  const favApps = () => get('favorites.apps') || [];
  const favChannels = () => get('favorites.channels') || [];

  function toggleApp(id) {
    const list = favApps().slice();
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.push(id);
    set('favorites.apps', list);
    return i < 0;
  }

  function moveApp(id, delta) {
    const list = favApps().slice();
    const i = list.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return false;
    list.splice(j, 0, list.splice(i, 1)[0]);
    set('favorites.apps', list);
    return true;
  }

  // Channel: { id, name, logo, num, epgId, categoryId }
  function toggleChannel(ch) {
    const list = favChannels().slice();
    const i = list.findIndex((c) => String(c.id) === String(ch.id));
    if (i >= 0) list.splice(i, 1);
    else list.push({ id: ch.id, name: ch.name, logo: ch.logo || '', num: ch.num || null, epgId: ch.epgId || '', categoryId: ch.categoryId || null });
    set('favorites.channels', list);
    return i < 0;
  }

  function moveChannel(id, delta) {
    const list = favChannels().slice();
    const i = list.findIndex((c) => String(c.id) === String(id));
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return false;
    list.splice(j, 0, list.splice(i, 1)[0]);
    set('favorites.channels', list);
    return true;
  }

  const isFavApp = (id) => favApps().indexOf(id) >= 0;
  const isFavChannel = (id) => favChannels().some((c) => String(c.id) === String(id));

  global.Store = {
    get, set, on, reset, flush: writeNow,
    fav: { apps: favApps, channels: favChannels, toggleApp, moveApp, toggleChannel, moveChannel, isApp: isFavApp, isChannel: isFavChannel }
  };
})(window);
