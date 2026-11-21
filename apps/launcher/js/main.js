/* Startup: wire together views, keys, background, ambient mode and visibility. */
(function () {
  'use strict';

  const body = document.body;
  document.title = tr('main.title');

  // In the browser: scale the 1920×1080 surface so it fits in the window.
  function fit() {
    if (TV.isTV) return;
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    body.style.transform = s < 1 ? 'scale(' + s + ')' : '';
  }
  if (!TV.isTV) body.classList.add('is-browser');
  fit();
  window.addEventListener('resize', fit);

  // Performance mode: no background blur behind glass, no shine.
  const applyLite = () => body.classList.toggle('lite', !!Store.get('layout.lite'));
  applyLite();
  Store.on((path) => { if (path === '*' || path === 'layout.lite') applyLite(); });

  // The background: the home screen controls it itself (sharp/blurred), other views get it dimmed.
  Wallpaper.init();
  Router.on((name) => { if (name !== 'home') Wallpaper.mode('dim'); });

  // Keys: ambient mode → open layers → active view → Back.
  Nav.onKey((name, e) => {
    Idle.reset();
    if (Idle.isActive()) {
      Idle.exit();
      return true; // the first press only wakes the screen
    }
    if (UI.handleKey(name, e)) return true;
    // An open layer (menu, dialog) owns the keys – arrows and OK are handled by the navigation in
    // the layer and must not pass through to the view below (e.g. zapping in full screen).
    if (UI.hasLayer()) return false;
    const view = Router.topView();
    if (view && view.onKey && view.onKey(name, e) === true) return true;
    if (name === 'back') {
      // On the home screen Back does nothing – this is the TV's home.
      Router.back();
      return true;
    }
    return false;
  });

  document.addEventListener('mousemove', (e) => {
    if (!(e.movementX || e.movementY)) return;
    if (Idle.isActive()) Idle.exit();
    Idle.reset();
  });

  // When the launcher comes back (e.g. via the Home button): go to the home screen and reload the apps
  // (something may have been installed in the meantime).
  let lastRefresh = Date.now();
  function cameBack() {
    Idle.exit();
    Idle.reset();
    if (Date.now() - lastRefresh > 60000) {
      lastRefresh = Date.now();
      Apps.refresh();
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    cameBack();
    const top = Router.top();
    if (top && top.name !== 'tv') Router.home();
  });
  // Launched again (the Home button, the watcher): switch to the home screen *before* the app is brought to the front, so that
  // the old view is never seen. appinfo.json has "handlesRelaunch": true, so the app only comes to the front
  // when we say so – hence activate() in finally, whatever happens.
  // Launched with parameters, e.g. "Watch now" in a reminder: { action: 'tune', channel }.
  function launchTarget() {
    const p = TV.launchParams();
    return p && p.action === 'tune' && p.channel && window.IPTV && IPTV.open ? p.channel : null;
  }

  document.addEventListener('webOSRelaunch', () => {
    try {
      cameBack();
      for (let i = 0; i < 5 && UI.hasLayer(); i++) UI.handleKey('back');
      Router.home();
      const ch = launchTarget();
      if (ch) IPTV.open({ tab: 'live', channel: ch, fullscreen: true });
    } catch (e) {
      console.error(e);
    } finally {
      TV.activate();
    }
  });

  Perf.mark('main');
  TV.started = true; // relaunch is handled below (see the safety net in lib/tv.js)
  Router.go('home');
  Nav.init();
  Idle.reset();
  Perf.mark('home');
  requestAnimationFrame(() => Perf.mark('homeFrame'));
  if (window.Apps && Apps.ready) Apps.ready.then(() => Perf.mark('appsReady'), () => Perf.mark('appsReady'));
  if (window.IPTV && IPTV.ready) IPTV.ready.then(() => Perf.mark('iptvReady'));
  const startCh = launchTarget();
  if (startCh) IPTV.ready.then(() => IPTV.open({ tab: 'live', channel: startCh, fullscreen: true }));

  const ready = () => body.classList.add('is-ready');
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(ready);
    setTimeout(ready, 1500);
  } else {
    ready();
  }
})();
