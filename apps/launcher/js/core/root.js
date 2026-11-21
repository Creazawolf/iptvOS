/*
 * Root — everything that goes via the launcher's own service on the TV (com.g3custom.launcher.service).
 *
 * Developer apps only get public Luna permissions, so the service is elevated to root by the
 * Homebrew Channel (once with  npm run tv -- root , then automatically by the init script).
 *
 *   Root.status()            -> Promise<{ root, elevated, autostart:{ installed, running, launch }, version }>
 *   Root.apps()              -> Promise<{ apps, inputs }>   (error with code 'NOT_ROOT' without root)
 *   Root.image(path)         -> Promise<{ src: data-URI, size }>
 *   Root.autostart(opts)     -> Promise<status.autostart>   opts: { enable: bool } | { remove: true }
 *   Root.inputs()            -> Promise<[input]>            (directly via eim – works even without root)
 *   Root.screen('off')       -> Promise   turn off the screen, sound keeps playing ('on', 'toggle')
 *   Root.lgHome()            -> Promise   show LG's own home screen
 *   Root.keys({ op })        -> Promise<{ screenoff, hook:{ installed, active } }>   shortcut buttons
 *   Root.fixCommand / Root.homeCommand
 */
(function (global) {
  'use strict';

  const APP_ID = 'com.g3custom.launcher';
  const SERVICE = 'luna://com.g3custom.launcher.service';
  const HB = '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service';

  const call = (method, params) => TV.request(SERVICE, method, params || {});

  let statusCache = null;
  function status(force) {
    if (statusCache && !force) return statusCache;
    statusCache = call('status').catch((e) => ({
      root: false, elevated: false, missing: /not ?found|does not exist|Unknown service/i.test(e.message || ''),
      error: e.message, autostart: { installed: false, running: false, launch: false }
    }));
    // Forget the response after a while so that a later elevation is noticed.
    statusCache.then(() => setTimeout(() => { statusCache = null; }, 20000));
    return statusCache;
  }

  function apps() {
    return call('apps').catch((e) => {
      const code = (e.response && e.response.errorCode) || e.code;
      const err = new Error(e.message);
      err.code = code === 'NOT_ROOT' ? 'NOT_ROOT' : (code || 'ERROR');
      throw err;
    });
  }

  function image(path) {
    return call('image', { path }).then((r) => ({ src: 'data:' + r.mime + ';base64,' + r.data, size: r.size || 0 }));
  }

  function autostart(opts) {
    return call('autostart', opts || {}).then((r) => {
      statusCache = null;
      return r.autostart;
    });
  }

  // HDMI inputs directly from the TV (externalinput.query is a public group).
  function inputs() {
    return TV.request('luna://com.webos.service.eim', 'getAllInputStatus', {}).then((r) =>
      (r.devices || []).map((d) => {
        const sub = Array.isArray(d.subList) ? d.subList : [];
        const cec = sub.filter((s) => s && s.osdName)[0];
        const urcu = sub.filter((s) => s && (s.brandName || s.labelName))[0];
        return {
          id: d.id,
          appId: d.appId,
          label: d.label || d.id,
          port: d.port || null,
          connected: !!d.connected,
          signal: !!d.hdmiSignalExist,
          icon: d.icon ? (d.iconPrefix || '') + d.icon : '',
          deviceName: (cec && cec.osdName) || '',
          brand: (urcu && (urcu.brandName || urcu.labelName)) || '',
          type: (urcu && urcu.serviceType) || ''
        };
      })
    );
  }

  // Track selection in the player via the service (com.webos.media requires root). op: 'track' | 'subtitles' | 'subtitleSize'
  const media = (params) => call('media', params || {});
  // TV power (the sleep timer): op 'off' = turn off like the TV's own sleep timer.
  const power = (op) => call('power', { op });
  // Reminders: the whole list is sent (the service keeps time and shows the popup).
  const remind = (items) => call('remind', items ? { items } : {});
  // The screen: op 'off' = turn off the screen but let the sound keep playing, 'on' = turn on, 'toggle'.
  const screen = (op) => call('screen', { op: op || 'off' });
  // LG's own home screen (the watcher lets it through until another app is opened).
  const lgHome = () => call('lgHome', {});
  // Shortcut buttons via LG Input Hook: { op: 'get' | 'learn' | 'set' | 'clear', action, code, timeout }
  const keys = (params) => call('keys', params || { op: 'get' });

  global.Root = {
    APP_ID,
    status,
    apps,
    image,
    autostart,
    media,
    power,
    remind,
    screen,
    lgHome,
    keys,
    inputs,
    // Run as root on the TV (SSH/telnet) – or  npm run tv -- root  from the computer.
    fixCommand: HB + '/elevate-service ' + APP_ID + '.service',
    homeCommand: 'luna-send -n 1 luna://com.webos.applicationManager/launch \'{"id":"' + APP_ID + '","keepAlive":true}\''
  };
})(window);
