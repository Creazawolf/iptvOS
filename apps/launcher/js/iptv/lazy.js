/*
 * Lazy loading of the TV view's interface (tabs, full screen, movie player, guide, search).
 *
 * In the package installed on the TV (scripts/lib.mjs), the scripts with data-lazy="iptv-ui" are
 * in a separate file, iptv-ui.js, which loads when the TV view is opened for the first time – or when
 * the TV has been idle for a while after start-up, so that it is usually already there. The home screen
 * then starts without parsing and running ~5,000 lines it does not need. In the preview (npm run dev)
 * everything loads straight away and this file does nothing.
 *
 *   IPTV.loadUi() -> Promise   (resolves when IPTV.ui exists)
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const file = global.__LAZY_IPTV_UI; // set in the package: 'iptv-ui.js'
  let loading = null;

  IPTV.loadUi = function () {
    if (IPTV.ui) return Promise.resolve();
    if (!file) return Promise.reject(new Error(tr('lazy.missing')));
    if (!loading) {
      if (global.Perf) Perf.mark('uiLoadStart');
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = file;
        s.onload = () => {
          if (global.Perf) Perf.mark('uiLoaded');
          resolve();
        };
        s.onerror = () => {
          loading = null;
          reject(new Error(tr('lazy.loadFailed')));
        };
        document.body.appendChild(s);
      });
    }
    return loading;
  };

  if (IPTV.ui) return; // everything is already loaded (the preview)

  // Until the interface exists: the same call, but it is loaded first. If the file loaded but did not
  // replace the function (an error in it) – report that instead of calling ourselves again.
  const stubs = {};
  const later = (name) => function () {
    const args = arguments;
    return IPTV.loadUi().then(() => {
      if (IPTV[name] === stubs[name]) throw new Error(tr('lazy.startFailed'));
      return IPTV[name].apply(IPTV, args);
    }).catch((e) => UI.toast(e.message, 4000));
  };
  IPTV.open = stubs.open = later('open');
  IPTV.openItem = stubs.openItem = later('openItem');

  // Load in advance when the TV is idle after start-up.
  setTimeout(() => {
    const go = () => IPTV.loadUi().catch(() => {});
    if (global.requestIdleCallback) global.requestIdleCallback(go, { timeout: 4000 });
    else go();
  }, 1500);
})(window);
