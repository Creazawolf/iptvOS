/*
 * Net — HTTP without CORS problems.
 *
 * webOS apps run from file:// and the TV enforces CORS strictly, so requests to e.g.
 * an Xtream server go via the app's own service (service/) on the TV and via
 * the dev server's /__proxy in the browser.
 *
 *   Net.text(url, { timeout, direct })   -> Promise<string>
 *   Net.json(url, { pick: ['name', …] })  -> Promise<any>
 *     pick: keep only these fields in objects in a JSON array (shrinks large lists).
 *     direct: skip the proxy/service (for APIs that already allow CORS).
 */
(function (global) {
  'use strict';

  const SERVICE = 'luna://com.g3custom.launcher.service';
  let serviceOk = TV.isTV;

  function viaFetch(url, opts) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeout || 15000) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then((r) => {
        if (!r.ok) throw httpError(r.status, url);
        return r.text();
      })
      .finally(() => clearTimeout(timer));
  }

  function httpError(status, url) {
    const e = new Error('HTTP ' + status);
    e.status = status;
    e.url = url;
    return e;
  }

  function viaService(url, opts) {
    return TV.request(SERVICE, 'fetch', { url, timeout: opts.timeout || 15000, pick: opts.pick || null }).then((r) => {
      if (r.status >= 400) throw httpError(r.status, url);
      return r.body;
    });
  }

  function text(url, opts) {
    opts = opts || {};
    if (opts.direct) return viaFetch(url, opts);

    if (TV.isTV && serviceOk) {
      return viaService(url, opts).catch((err) => {
        // Is the service missing (e.g. an older install)? Try directly instead.
        if (/not found|Unknown service|service does not exist/i.test(err.message || '')) {
          serviceOk = false;
          return viaFetch(url, opts);
        }
        throw err;
      });
    }
    if (!TV.isTV && /^https?:$/.test(location.protocol)) {
      let proxied = '/__proxy?url=' + encodeURIComponent(url);
      if (opts.pick) proxied += '&pick=' + encodeURIComponent(opts.pick.join(','));
      return viaFetch(proxied, opts);
    }
    return viaFetch(url, opts);
  }

  function json(url, opts) {
    return text(url, opts).then((body) => {
      try {
        return JSON.parse(body);
      } catch (e) {
        const err = new Error(tr('net.invalidJson'));
        err.body = String(body).slice(0, 200);
        throw err;
      }
    });
  }

  global.Net = { text, json };
})(window);
