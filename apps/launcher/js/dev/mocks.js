/*
 * Pretend TV for the browser (does not run on the TV).
 *
 * Answers like the launcher's root service with the TV's real app list, HDMI inputs and icons,
 * fetched from the user's TV to build/dev-fixtures/root (served by the dev server at
 * /__fixtures/…). The IPTV part has its own defaults for the browser.
 *
 *   ?noroot   in the address  → the service answers as if it were not elevated
 */
(function (global) {
  'use strict';
  if (global.TV.isTV) return;

  const SVC = 'luna://com.g3custom.launcher.service/';
  const ss = global.sessionStorage;
  if (/[?&]noroot\b/.test(location.search)) ss.setItem('mock:noroot', '1');
  if (/[?&]root\b/.test(location.search)) ss.removeItem('mock:noroot');
  const rooted = () => !ss.getItem('mock:noroot');

  const fixture = (path) => fetch('/__fixtures' + path).then((r) => {
    if (!r.ok) throw new Error('missing: ' + path);
    return r;
  });

  const bestIcon = (lp) => lp.extraLargeIcon || lp.mediumLargeIcon || lp.largeIcon || lp.icon || '';

  function mapInput(d) {
    const sub = Array.isArray(d.subList) ? d.subList : [];
    const cec = sub.filter((s) => s && s.osdName)[0];
    const urcu = sub.filter((s) => s && (s.brandName || s.labelName))[0];
    return {
      id: d.id, appId: d.appId, label: d.label || d.id, port: d.port || null,
      connected: !!d.connected, signal: !!d.hdmiSignalExist,
      icon: d.icon ? (d.iconPrefix || '') + d.icon : '',
      deviceName: (cec && cec.osdName) || '', brand: (urcu && (urcu.brandName || urcu.labelName)) || '',
      type: (urcu && urcu.serviceType) || ''
    };
  }

  const eim = () => fixture('/tmp/eim.json').then((r) => r.json()).catch(() => ({ devices: [] }));

  const M = global.TV.mocks;

  M[SVC + 'status'] = () => ({
    returnValue: true,
    root: rooted(),
    elevated: rooted(),
    node: 'v20 (webbläsare)',
    version: '3.4.0',
    autostart: { installed: rooted(), running: rooted(), launch: !ss.getItem('mock:nolaunch') }
  });

  M[SVC + 'apps'] = () => {
    if (!rooted()) return { returnValue: false, errorCode: 'NOT_ROOT', errorText: 'Tjänsten är inte upphöjd till root' };
    return Promise.all([
      fixture('/tmp/lp.json').then((r) => r.json()).catch(() => ({ launchPoints: [] })),
      eim()
    ]).then(([lp, e]) => ({
      returnValue: true,
      apps: (lp.launchPoints || []).map((p) => ({
        id: p.id, launchPointId: p.launchPointId || '', title: p.title || p.id,
        icon: bestIcon(p), smallIcon: p.largeIcon || p.icon || '', iconColor: p.iconColor || '', bgColor: p.bgColor || '',
        bgImage: p.bgImage || '', systemApp: !!p.systemApp, removable: !!p.removable, lptype: p.lptype || 'default',
        installTime: p.installTime || 0, params: p.params && Object.keys(p.params).length ? p.params : null
      })),
      inputs: (e.devices || []).map(mapInput)
    }));
  };

  M[SVC + 'image'] = (p) => fixture(p.path).then((r) => r.blob()).then((blob) => new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => {
      const uri = String(fr.result);
      resolve({ returnValue: true, mime: blob.type || 'image/png', size: blob.size, data: uri.slice(uri.indexOf(',') + 1) });
    };
    fr.readAsDataURL(blob);
  }), () => ({ returnValue: false, errorCode: 'NOT_FOUND', errorText: 'Bilden finns inte' }));

  // Track selection in the player (com.webos.media) – in the browser we only pretend.
  M[SVC + 'media'] = (p) => { console.info('[TV mock] media', p); return { returnValue: true, result: { returnValue: true } }; };
  M[SVC + 'autostart'] = (p) => {
    if (!rooted()) return { returnValue: false, errorCode: 'NOT_ROOT', errorText: 'Inte root' };
    if (p.enable === true) ss.removeItem('mock:nolaunch');
    if (p.enable === false) ss.setItem('mock:nolaunch', '1');
    return { returnValue: true, autostart: { installed: true, running: true, launch: !ss.getItem('mock:nolaunch') } };
  };

  // Screen off, LG's home screen and shortcut button – in the browser we only pretend.
  M[SVC + 'screen'] = (p) => { console.info('[TV mock] screen', p); return { returnValue: true, state: p.op === 'on' ? 'on' : 'off' }; };
  M[SVC + 'lgHome'] = () => { console.info('[TV mock] lgHome'); return { returnValue: true }; };
  const keyState = () => ({ returnValue: true, screenoff: Number(ss.getItem('mock:screenkey')) || null, hook: { installed: true, active: true } });
  M[SVC + 'keys'] = (p) => {
    if (p.op === 'learn') return new Promise((resolve) => setTimeout(() => resolve({ returnValue: true, code: 1037, reserved: false }), 1200));
    if (p.op === 'set') ss.setItem('mock:screenkey', String(p.code));
    if (p.op === 'clear') ss.removeItem('mock:screenkey');
    return keyState();
  };

  M['luna://com.webos.service.eim/getAllInputStatus'] = () => eim().then((e) => Object.assign({ returnValue: true }, e));
})(window);
