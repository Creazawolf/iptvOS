/*
 * IPTV.xtream — low-level client for Xtream Codes (direct mode, without the hub).
 *
 *   IPTV.xtream.creds()                    { server, username, password, format }
 *   IPTV.xtream.login(creds?)              -> { user_info, server_info }  (translated error messages)
 *   IPTV.xtream.call(action, params, opts) -> JSON from player_api.php
 *   IPTV.xtream.liveUrl(id) / vodUrl(id, ext) / episodeUrl(id, ext)
 *
 * The requests go via Net: the app's service on the TV (Xtream servers rarely send CORS headers),
 * the dev server's /__proxy in the browser.
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const DEMO_HOST = 'demo.g3custom.test';
  const DEMO = { server: 'http://' + DEMO_HOST, username: 'demo', password: 'demo' };

  function normalizeServer(s) {
    s = String(s || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    // Pasted addresses sometimes contain player_api.php or get.php – keep only the base.
    s = s.replace(/\/(player_api|get|xmltv|panel_api)\.php.*$/i, '');
    return s.replace(/\/+$/, '');
  }

  // Login details. In the browser without an account of your own (and without a dev hub): the demo provider.
  function creds(c) {
    const d = Store.get('iptv.direct') || {};
    c = c || {};
    const pick = (k) => (c[k] != null ? c[k] : d[k]);
    let out = {
      server: normalizeServer(pick('server')),
      username: String(pick('username') || '').trim(),
      password: String(pick('password') || ''),
      format: pick('format') === 'ts' ? 'ts' : 'm3u8'
    };
    if (!TV.isTV && !out.server && !c.server) out = Object.assign({}, DEMO, { format: out.format });
    return out;
  }

  const configured = () => {
    const c = creds();
    return !!(c.server && c.username && c.password);
  };

  const isDemo = () => creds().server.indexOf('://' + DEMO_HOST) > 0;

  function apiUrl(params, c) {
    c = c || creds();
    let url = c.server + '/player_api.php?username=' + encodeURIComponent(c.username) +
      '&password=' + encodeURIComponent(c.password);
    Object.keys(params || {}).forEach((k) => {
      if (params[k] != null) url += '&' + k + '=' + encodeURIComponent(params[k]);
    });
    return url;
  }

  // Make network errors understandable.
  function friendly(err) {
    if (err && err.friendly) return err;
    const msg = (err && err.message) || String(err);
    const st = err && err.status;
    let text;
    if (st === 401 || st === 403) text = tr('xtream.loginDenied', { status: st });
    else if (st === 404) text = tr('xtream.notFound');
    else if (st === 502 || st === 504) text = tr('xtream.unreachableCheck');
    else if (st) text = tr('xtream.httpError', { status: st });
    else if (/tidsgräns|timeout|abort/i.test(msg)) text = tr('xtream.timeout');
    else if (/JSON/i.test(msg)) text = tr('xtream.notXtream');
    else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) text = tr('xtream.hostNotFound');
    else if (/ECONNREFUSED|ECONNRESET|Failed to fetch|NetworkError|Proxy-fel/i.test(msg)) text = tr('xtream.unreachable');
    else text = msg;
    const e = new Error(text);
    e.friendly = true;
    e.cause = err;
    return e;
  }

  const fail = (text) => Object.assign(new Error(text), { friendly: true });

  let loginCache = null; // { key, promise }
  const credKey = (c) => c.server + '|' + c.username + '|' + c.password;

  function login(c) {
    const cc = creds(c);
    if (!cc.server || !cc.username || !cc.password) return Promise.reject(fail(tr('xtream.fillIn')));
    const key = credKey(cc);
    const useCache = !c;
    if (useCache && loginCache && loginCache.key === key) return loginCache.promise;

    const p = Net.json(apiUrl({}, cc), { timeout: 15000 })
      .catch((err) => { throw friendly(err); })
      .then((data) => {
        const ui = data && data.user_info;
        if (!ui) throw friendly(new Error('JSON'));
        if (String(ui.auth) === '0') throw fail(tr('xtream.wrongLogin'));
        const status = String(ui.status || 'Active');
        if (status !== 'Active') {
          const map = { Expired: tr('xtream.expired'), Banned: tr('xtream.banned'), Disabled: tr('xtream.disabled') };
          throw fail(map[status] || tr('xtream.notActive', { status }));
        }
        const exp = Number(ui.exp_date);
        if (exp && exp * 1000 < Date.now()) throw fail(tr('xtream.expiredOn', { date: new Date(exp * 1000).toLocaleDateString(I18n.locale) }));
        return data;
      });

    if (useCache) {
      loginCache = { key, promise: p };
      p.catch(() => { if (loginCache && loginCache.promise === p) loginCache = null; });
    }
    return p;
  }

  function call(action, params, opts) {
    return login()
      .then(() => Net.json(apiUrl(Object.assign({ action }, params || {})), Object.assign({ timeout: 30000 }, opts || {})))
      .catch((err) => { throw friendly(err); });
  }

  const enc = encodeURIComponent;
  function base(kind) {
    const c = creds();
    return c.server + '/' + kind + '/' + enc(c.username) + '/' + enc(c.password) + '/';
  }
  const liveUrl = (id) => base('live') + id + '.' + creds().format;
  const vodUrl = (id, ext) => base('movie') + id + '.' + (ext || 'mp4');
  const episodeUrl = (id, ext) => base('series') + id + '.' + (ext || 'mp4');

  function clear() {
    loginCache = null;
  }

  Store.on((path) => {
    if (path === '*' || path === 'iptv' || /^iptv\.direct/.test(path)) clear();
  });

  IPTV.xtream = { creds, configured, isDemo, normalizeServer, login, call, liveUrl, vodUrl, episodeUrl, friendly, clear, DEMO_HOST };
})(window);
