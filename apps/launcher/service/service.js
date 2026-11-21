/*
 * com.g3custom.launcher.service — Node service that runs on the TV (Node 20 on the LG G3).
 *
 * Developer apps only get public Luna permissions. This service is therefore elevated to root
 * by the Homebrew Channel (elevate-service, see g3custom-init.sh) and does what the app is not allowed to:
 *
 *   status    {}                   -> { root, elevated, node, version, autostart:{ installed, running, launch, homeButton } }
 *   apps      {}                   -> { apps:[…], inputs:[…] }            (requires root, otherwise errorCode NOT_ROOT)
 *   image     { path }             -> { mime, data (base64), size }       (image files under /usr, /media, /mnt)
 *   fetch     { url, timeout?, pick?, maxBytes? } -> { status, contentType, body }   (HTTP without CORS)
 *   autostart { enable?: bool, homeButton?: bool, remove?: bool }   -> like status.autostart
 *   power     { op: 'off' }        -> turns off the TV (the sleep timer)
 *   screen    { op: 'off'|'on'|'toggle'|'state' } -> { state }   turn off the screen, sound keeps playing
 *   lgHome    {}                   -> shows LG's own home screen (the watcher lets it through)
 *   keys      { op: 'get' }                        -> { screenoff: code|null, hook:{ installed, active } }
 *             { op: 'learn', timeout? }            -> { code, reserved }   the next button pressed on the remote
 *             { op: 'set', action:'screenoff', code } / { op: 'clear', action }   shortcut button via LG Input Hook
 *   remind    { items?: [{ id, at, title, message, params }] } -> { items }   (programme reminders;
 *             without items: read the list). At the time a webOS popup with "Watch now" is shown, which launches
 *             the launcher with params (e.g. { channel }). Saved in /var/luna/preferences.
 *   ping      {}                   -> { node, uid }
 *
 * When elevated, the service is run by the Homebrew Channel's run-js-service. Node then exits as soon as
 * the event loop is empty, so the service keeps itself alive with its own timer and shuts down by itself
 * after a quarter of an hour of silence (Luna starts it again on the next call).
 */
'use strict';

const Service = require('webos-service');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const childProcess = require('child_process');

const ID = 'com.g3custom.launcher.service';
const VERSION = require('./package.json').version;
const SERVICES_D = '/var/luna-service2-dev/services.d/' + ID + '.service';
const INIT_DIR = '/var/lib/webosbrew/init.d';
const INIT_SCRIPT = INIT_DIR + '/90-g3custom';
const OLD_INIT_SCRIPT = INIT_DIR + '/90-g3custom-launcher';
const OLD_PIDFILE = '/tmp/g3custom-watch.pid';
const PIDFILE = '/tmp/g3custom.pid';
const NOLAUNCH = '/var/luna/preferences/g3custom_nolaunch';
const NOHOME = '/var/luna/preferences/g3custom_nohome';
const BUNDLED_INIT = path.join(__dirname, 'g3custom-init.sh');
const MAX_FETCH = 40 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const IDLE_MS = 15 * 60 * 1000;

const service = new Service(ID);
// G3_TEST_*: only for scripts/service-test.mjs (never set on the TV).
const TEST = process.env.G3_TEST_DIR || '';
const isRoot = () => !!TEST || (typeof process.getuid === 'function' && process.getuid() === 0);

// --- Lifetime ------------------------------------------------------------------------

let lastCall = Date.now();
const touch = () => { lastCall = Date.now(); };
setInterval(() => {
  // Pending reminders keep the service alive (see remind below).
  if (Date.now() - lastCall > IDLE_MS && !reminders.length) process.exit(0);
}, 30 * 1000);
// webos-service has its own idle timer (5 s). Give it the same timeout as ours.
try {
  if (service.activityManager) service.activityManager.idleTimeout = IDLE_MS / 1000;
} catch (e) { /* older webos-service */ }

function register(name, fn) {
  service.register(name, (message) => {
    touch();
    const payload = message.payload || {};
    Promise.resolve()
      .then(() => fn(payload, message))
      .then((res) => message.respond(Object.assign({ returnValue: true }, res || {})))
      .catch((err) => message.respond({
        returnValue: false,
        errorCode: (err && err.code) || 'ERROR',
        errorText: String((err && err.message) || err)
      }));
  });
}

function fail(code, text) {
  const e = new Error(text);
  e.code = code;
  return e;
}

// Luna calls from the service (only fully work once the service is elevated).
function luna(uri, params) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(fail('TIMEOUT', 'No response from ' + uri)); }
    }, 8000);
    service.call(uri, params || {}, (msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const p = (msg && msg.payload) || {};
      if (p.returnValue === false) reject(fail(p.errorCode || 'LUNA', p.errorText || 'Luna error from ' + uri));
      else resolve(p);
    });
  });
}

// --- status ---------------------------------------------------------------------------

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

function pidAlive(file) {
  const pid = parseInt(readText(file), 10);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function autostartState() {
  return {
    installed: fs.existsSync(INIT_SCRIPT),
    running: pidAlive(PIDFILE),
    launch: !fs.existsSync(NOLAUNCH),
    homeButton: !fs.existsSync(NOHOME)
  };
}

register('status', () => ({
  root: isRoot(),
  elevated: /hbchannel\.service\/run-js-service/.test(readText(SERVICES_D)),
  node: process.version,
  version: VERSION,
  autostart: autostartState()
}));

register('ping', () => ({ node: process.version, uid: typeof process.getuid === 'function' ? process.getuid() : null }));

// --- apps -----------------------------------------------------------------------------

// Best icon first: 192 px > ~160 px > 130 px > 80 px.
function bestIcon(lp) {
  return lp.extraLargeIcon || lp.mediumLargeIcon || lp.largeIcon || lp.icon || '';
}

function mapLaunchPoint(lp) {
  return {
    id: lp.id,
    launchPointId: lp.launchPointId || '',
    title: lp.title || lp.id,
    icon: bestIcon(lp),
    smallIcon: lp.largeIcon || lp.icon || '',
    iconColor: lp.iconColor || '',
    bgColor: lp.bgColor || '',
    bgImage: lp.bgImage || '',
    systemApp: !!lp.systemApp,
    removable: !!lp.removable,
    lptype: lp.lptype || 'default',
    installTime: lp.installTime || 0,
    params: lp.params && Object.keys(lp.params).length ? lp.params : null
  };
}

function mapInput(d) {
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
}

register('apps', () => {
  if (!isRoot()) throw fail('NOT_ROOT', 'The service is not elevated to root');
  return Promise.all([
    luna('luna://com.webos.applicationManager/listLaunchPoints', {}),
    luna('luna://com.webos.service.eim/getAllInputStatus', {}).catch(() => ({ devices: [] }))
  ]).then((r) => ({
    apps: (r[0].launchPoints || []).map(mapLaunchPoint),
    inputs: (r[1].devices || []).map(mapInput)
  }));
});

// --- media (audio tracks and subtitles in the player) ---------------------------------------
// The web app gets the track lists itself (the "umsmediainfo" event on <video>), but switching tracks
// requires com.webos.media, which developer apps are not allowed to call. The service does it for the app.
//   { op: 'track', mediaId, type: 'audio'|'text', index }
//   { op: 'subtitles', mediaId, enable: bool }
//   { op: 'subtitleSize', mediaId, size: 0–4 }
// The media server sometimes answers returnValue:false with errorCode 0 / "No Error" when it succeeded
// (LG's own Media Player gets the same response) – count it as a success.
function mediaCall(uri, params) {
  return luna(uri, params).catch((e) => {
    if (e && (e.errorCode === 0 || /^no error$/i.test(e.errorText || e.message || ''))) return { returnValue: true, note: 'no-error' };
    throw e;
  });
}

const MEDIA_OPS = {
  track: (p) => mediaCall('luna://com.webos.media/selectTrack', { mediaId: p.mediaId, type: p.type === 'text' ? 'text' : 'audio', index: Number(p.index) || 0 }),
  subtitles: (p) => mediaCall('luna://com.webos.media/setSubtitleEnable', { mediaId: p.mediaId, enable: !!p.enable }),
  subtitleSize: (p) => mediaCall('luna://com.webos.media/setSubtitleFontSize', { mediaId: p.mediaId, fontSize: Math.max(0, Math.min(4, Number(p.size) || 0)) })
};

register('media', (p) => {
  if (!isRoot()) throw fail('NOT_ROOT', 'The service is not elevated to root');
  if (!p || typeof p.mediaId !== 'string' || !p.mediaId) throw fail('BAD_ARGS', 'mediaId is missing');
  const op = MEDIA_OPS[p.op];
  if (!op) throw fail('BAD_ARGS', 'Unknown operation');
  return op(p).then((r) => ({ result: r }));
});

// --- remind (programme reminders) -------------------------------------------------------------
// The service keeps the time (not the web app, which may be in the background or closed) and shows a popup
// on top of whatever is on the screen. The list is saved to disk and read back when the service starts.
const APP = 'com.g3custom.launcher';
const REMINDERS = '/var/luna/preferences/g3custom_reminders.json';
let reminders = [];
let remindTimer = null;
let remindActivity = null;
const fired = new Map(); // id -> when it was shown (so that a new sync does not show it again)

function loadReminders() {
  try { reminders = JSON.parse(fs.readFileSync(REMINDERS, 'utf8')) || []; } catch (e) { reminders = []; }
  if (!Array.isArray(reminders)) reminders = [];
}

function saveReminders() {
  try {
    fs.writeFileSync(REMINDERS + '.tmp', JSON.stringify(reminders));
    fs.renameSync(REMINDERS + '.tmp', REMINDERS);
  } catch (e) { /* not root (the browser/an older install) */ }
}

// webos-service shuts down a service without activity – an activity keeps it up while something is pending.
function holdAlive(on) {
  try {
    const am = service.activityManager;
    if (!am) return;
    if (on && !remindActivity) remindActivity = am.create('g3custom-reminders', () => {});
    if (!on && remindActivity) {
      am.complete(remindActivity, () => {});
      remindActivity = null;
    }
  } catch (e) { /* older webos-service */ }
}

function armReminders() {
  clearTimeout(remindTimer);
  const now = Date.now();
  // Missed (the TV was off): drop those that are more than ten minutes late.
  reminders = reminders.filter((r) => r.at > now - 10 * 60e3);
  holdAlive(reminders.length > 0);
  if (!reminders.length) return;
  const next = Math.min.apply(null, reminders.map((r) => r.at));
  remindTimer = setTimeout(fireReminders, Math.min(Math.max(0, next - now), 0x7fffffff));
}

function showReminder(r) {
  touch();
  const launch = { id: APP, params: r.params || {} };
  luna('luna://com.webos.notification/createAlert', {
    title: r.title || 'Reminder',
    message: r.message || '',
    buttons: [
      { label: r.watch || 'Watch now', onclick: 'luna://com.webos.applicationManager/launch', params: launch, focus: true },
      { label: r.close || 'Close' }
    ]
  }).catch(() => luna('luna://com.webos.notification/createToast', {
    sourceId: APP,
    message: (r.title ? r.title + ' – ' : '') + (r.message || ''),
    onclick: { appId: APP, params: r.params || {} },
    noaction: false
  })).catch((e) => console.error('[g3custom] the reminder could not be shown:', e.message));
}

function fireReminders() {
  const now = Date.now();
  const due = reminders.filter((r) => r.at <= now + 1000);
  due.forEach((r) => fired.set(r.id, now));
  for (const [id, at] of fired) if (now - at > 24 * 3600e3) fired.delete(id);
  reminders = reminders.filter((r) => r.at > now + 1000);
  saveReminders();
  due.forEach(showReminder);
  armReminders();
}

register('remind', (p) => {
  if (!Array.isArray(p.items)) return { items: reminders };
  const now = Date.now();
  reminders = p.items
    .filter((r) => r && Number(r.at) > now - 60e3 && !fired.has(String(r.id)))
    .slice(0, 100)
    .map((r) => ({
      id: String(r.id),
      at: Number(r.at),
      title: String(r.title || '').slice(0, 120),
      message: String(r.message || '').slice(0, 240),
      params: r.params && typeof r.params === 'object' ? r.params : {},
      watch: String(r.watch || '').slice(0, 40),
      close: String(r.close || '').slice(0, 40)
    }));
  saveReminders();
  armReminders();
  return { items: reminders };
});

loadReminders();
armReminders();

// --- power (the sleep timer) ----------------------------------------------------------------
// Turn off the TV the way its own sleep timer does (the reason "sleepTimer" is in tvpowerd's list).
register('power', (p) => {
  if (!isRoot()) throw fail('NOT_ROOT', 'The service is not elevated to root');
  if (!p || p.op !== 'off') throw fail('BAD_ARGS', 'Unknown operation');
  return luna('luna://com.webos.service.tvpower/power/powerOff', { reason: 'sleepTimer' }).then(() => ({}));
});

// --- screen (screen off, sound keeps playing) -----------------------------------------------
// The same call LG's own media player makes for "Screen off" when listening to music. The screen turns
// on again with any button on the remote. Works regardless of which app is in front.
const POWER = 'luna://com.webos.service.tvpower/power/';
const screenState = () => luna(POWER + 'getPowerState', {}).then((r) => String(r.state || ''));

function setScreen(on) {
  return luna(POWER + (on ? 'turnOnScreen' : 'turnOffScreen'), {}).then(() => ({ state: on ? 'on' : 'off' }));
}

register('screen', (p) => {
  if (!isRoot()) throw fail('NOT_ROOT', 'The service is not elevated to root');
  const op = p && p.op;
  if (op === 'off') return setScreen(false);
  if (op === 'on') return setScreen(true);
  if (op === 'toggle') return screenState().then((st) => setScreen(st === 'Screen Off'));
  if (op === 'state') return screenState().then((st) => ({ state: st === 'Screen Off' ? 'off' : 'on', power: st }));
  throw fail('BAD_ARGS', 'Unknown operation');
});

// --- lgHome (LG's own home screen) -----------------------------------------------------------
// Otherwise the watcher (g3custom-init.sh) immediately switches back to the launcher when LG's home screen comes
// to the foreground. The flag says it was opened on purpose; the watcher removes it when another app is opened.
const LG_HOME = 'com.webos.app.home';
const LGHOME_FLAG = TEST ? TEST + '/g3custom-lghome' : '/tmp/g3custom-lghome';

register('lgHome', () => {
  if (!isRoot()) throw fail('NOT_ROOT', 'The service is not elevated to root');
  fs.writeFileSync(LGHOME_FLAG, String(Date.now()));
  return luna('luna://com.webos.applicationManager/launch', { id: LG_HOME }).then(() => ({}), (e) => {
    try { fs.unlinkSync(LGHOME_FLAG); } catch (x) { /* did not exist */ }
    throw e;
  });
});

// --- keys (shortcut buttons via LG Input Hook) --------------------------------------------------
// LG Input Hook catches key presses before the apps get them and can run a command. We only add/remove
// our own entries in its keybinds.json (the Home button and anything else the user added are left alone).
const IH_ID = 'org.webosbrew.inputhook.service';
const IH_SVC = TEST ? TEST + '/ih.service' : '/var/luna-service2-dev/services.d/' + IH_ID + '.service';
const IH_CONF = TEST ? TEST + '/lginputhook/keybinds.json' : '/home/root/.config/lginputhook/keybinds.json';
const IH_MARK = TEST ? TEST + '/inputhook' : '/tmp/inputhook';
const INPUT_DIR = TEST ? TEST + '/input' : '/dev/input';
const KEY_COMMANDS = { screenoff: 'sh ' + INIT_SCRIPT + ' screen toggle' };
// Buttons that must not be rebound – otherwise the TV cannot be controlled: Home (773 on LG) and the Linux codes for
// Esc, OK, arrows, volume, power, Back and Select.
const RESERVED_KEYS = [773, 1, 28, 96, 103, 105, 106, 108, 113, 114, 115, 116, 158, 174, 352, 353];

function readBinds() {
  try {
    const j = JSON.parse(fs.readFileSync(IH_CONF, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch (e) { return {}; }
}

function keysState() {
  const binds = readBinds();
  const out = { hook: { installed: fs.existsSync(IH_SVC), active: fs.existsSync(IH_MARK) } };
  Object.keys(KEY_COMMANDS).forEach((a) => {
    const code = Object.keys(binds).filter((c) => binds[c] && binds[c].command === KEY_COMMANDS[a])[0];
    out[a] = code ? Number(code) : null;
  });
  return out;
}

function setKey(action, code) {
  const command = KEY_COMMANDS[action];
  if (!command) throw fail('BAD_ARGS', 'Unknown shortcut');
  if (!fs.existsSync(IH_SVC)) throw fail('NO_HOOK', 'LG Input Hook is not installed');
  const binds = readBinds();
  Object.keys(binds).forEach((c) => { if (binds[c] && binds[c].command === command) delete binds[c]; });
  if (code != null) {
    const n = Number(code);
    if (!(n > 0 && n < 65536) || n !== Math.floor(n)) throw fail('BAD_ARGS', 'Invalid key code');
    if (RESERVED_KEYS.indexOf(n) >= 0) throw fail('RESERVED', 'That button is needed to control the TV');
    if (binds[n]) throw fail('IN_USE', 'The button already has another shortcut in LG Input Hook');
    binds[n] = { action: 'exec', command };
  }
  fs.mkdirSync(path.dirname(IH_CONF), { recursive: true });
  fs.writeFileSync(IH_CONF + '.tmp', JSON.stringify(binds));
  fs.renameSync(IH_CONF + '.tmp', IH_CONF);
  // Make sure the hook is running (it does not start by itself after the TV restarts).
  return luna('luna://' + IH_ID + '/start', {}).catch(() => null).then(keysState);
}

// The next button pressed on any of the TV's input devices (remote, IR, network).
// Each device is read by its own "cat", which is closed afterwards – the read blocks, and in Node it would
// lock up the thread pool. The record is 16 bytes in 32-bit userland (as on the G3) and 24 bytes in 64-bit.
function learnKey(timeout) {
  return new Promise((resolve, reject) => {
    const size = process.arch === 'arm64' || process.arch === 'x64' ? 24 : 16;
    let devs;
    try { devs = fs.readdirSync(INPUT_DIR).filter((n) => /^event\d+$/.test(n)); } catch (e) { devs = []; }
    if (!devs.length) { reject(fail('NO_INPUT', 'No input devices found')); return; }
    const procs = [];
    let done = false;
    const finish = (err, res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      procs.forEach((c) => { try { c.kill(); } catch (e) { /* already gone */ } });
      if (err) reject(err); else resolve(res);
    };
    const timer = setTimeout(() => finish(fail('TIMEOUT', 'No button was pressed')), timeout);
    devs.forEach((name) => {
      let rest = Buffer.alloc(0);
      let child;
      try { child = childProcess.spawn('cat', [INPUT_DIR + '/' + name], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return; }
      child.on('error', () => {});
      child.stdout.on('data', (chunk) => {
        rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        while (rest.length >= size) {
          const type = rest.readUInt16LE(size - 8);
          const code = rest.readUInt16LE(size - 6);
          const value = rest.readInt32LE(size - 4);
          rest = rest.subarray(size);
          // EV_KEY, pressed (not released or repeat). Mouse buttons (0x110–0x11f) do not count.
          if (type === 1 && value === 1 && !(code >= 0x110 && code <= 0x11f)) {
            finish(null, { code, device: name, reserved: RESERVED_KEYS.indexOf(code) >= 0 });
            return;
          }
        }
      });
      procs.push(child);
    });
  });
}

register('keys', (p) => {
  if (!isRoot()) throw fail('NOT_ROOT', 'The service is not elevated to root');
  const op = (p && p.op) || 'get';
  if (op === 'get') return keysState();
  if (op === 'learn') return learnKey(Math.min(Math.max(Number(p.timeout) || 10000, 2000), 30000));
  if (op === 'set') return setKey(p.action, p.code);
  if (op === 'clear') return setKey(p.action, null);
  throw fail('BAD_ARGS', 'Unknown operation');
});

// --- image ----------------------------------------------------------------------------

const IMAGE_DIRS = ['/usr/', '/media/', '/mnt/', '/var/palm/', '/var/lib/'];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

register('image', (p) => {
  const file = typeof p.path === 'string' ? path.normalize(p.path) : '';
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!file || file !== p.path || !IMAGE_DIRS.some((d) => file.indexOf(d) === 0) || !mime) {
    throw fail('BAD_PATH', 'Invalid image path');
  }
  return new Promise((resolve, reject) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return reject(fail('NOT_FOUND', 'Image not found'));
      if (st.size > MAX_IMAGE) return reject(fail('TOO_BIG', 'Image is too large'));
      fs.readFile(file, (err2, buf) => {
        if (err2) return reject(fail('READ', err2.message));
        resolve({ mime, size: st.size, mtime: Math.round(st.mtimeMs), data: buf.toString('base64') });
      });
    });
  });
});

// --- autostart ------------------------------------------------------------------------

// Note: the watcher that the init script starts becomes a grandchild of this process and inherits its
// open connections (including the Luna bus's). The script closes them itself (close_inherited) – otherwise
// the bus thinks the service is still alive after it has exited, and calls to it go unanswered.
function runInit(arg) {
  return new Promise((resolve) => {
    childProcess.execFile('/bin/sh', [INIT_SCRIPT, arg], { timeout: 15000 }, (err, stdout) => resolve(String(stdout || '')));
  });
}

function stopOldWatcher() {
  const pid = parseInt(readText(OLD_PIDFILE), 10);
  if (pid) { try { process.kill(pid); } catch (e) { /* already gone */ } }
  try { fs.unlinkSync(OLD_PIDFILE); } catch (e) { /* did not exist */ }
  try { fs.unlinkSync(OLD_INIT_SCRIPT); } catch (e) { /* did not exist */ }
}

// Install (or update) the init script and make sure the watcher is running.
function installInit() {
  const wanted = fs.readFileSync(BUNDLED_INIT, 'utf8');
  const current = readText(INIT_SCRIPT);
  stopOldWatcher();
  if (current === wanted && pidAlive(PIDFILE)) return Promise.resolve(false);
  fs.mkdirSync(INIT_DIR, { recursive: true });
  fs.writeFileSync(INIT_SCRIPT + '.tmp', wanted, { mode: 0o755 });
  fs.renameSync(INIT_SCRIPT + '.tmp', INIT_SCRIPT);
  const restart = current && current !== wanted ? runInit('stop') : Promise.resolve();
  return restart.then(() => runInit('start')).then(() => true);
}

register('autostart', (p) => {
  if (!isRoot()) throw fail('NOT_ROOT', 'The service is not elevated to root');
  if (p.remove) {
    return runInit('stop').then(() => {
      try { fs.unlinkSync(INIT_SCRIPT); } catch (e) { /* did not exist */ }
      stopOldWatcher();
      return { autostart: autostartState() };
    });
  }
  return installInit().then(() => {
    if (p.enable === true) { try { fs.unlinkSync(NOLAUNCH); } catch (e) { /* did not exist */ } }
    if (p.enable === false) fs.writeFileSync(NOLAUNCH, '1');
    if (p.homeButton === true) { try { fs.unlinkSync(NOHOME); } catch (e) { /* did not exist */ } }
    if (p.homeButton === false) fs.writeFileSync(NOHOME, '1');
    return { autostart: autostartState() };
  });
});

// Do we have root and an older init script? Update it silently (e.g. after a new version of the app).
if (isRoot() && fs.existsSync(INIT_SCRIPT)) {
  setTimeout(() => { installInit().catch(() => {}); }, 3000);
}

// --- fetch ----------------------------------------------------------------------------

function request(target, timeout, redirects, maxBytes, cb) {
  let done = false;
  const finish = (err, res) => {
    if (done) return;
    done = true;
    cb(err, res);
  };

  let u;
  try {
    u = new URL(target);
  } catch (e) {
    return finish(new Error('Invalid address'));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return finish(new Error('Only http/https is supported'));

  const opts = {
    protocol: u.protocol,
    hostname: u.hostname.replace(/^\[|\]$/g, ''),
    port: u.port || undefined,
    path: u.pathname + u.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Web0S; Linux) G3Custom/3.0',
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate'
    }
  };
  if (u.username || u.password) opts.auth = decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password);
  if (u.protocol === 'https:') opts.rejectUnauthorized = false;

  const lib = opts.protocol === 'https:' ? https : http;
  const req = lib.request(opts, (res) => {
    const status = res.statusCode;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (redirects <= 0) return finish(new Error('Too many redirects'));
      let next;
      try { next = new URL(res.headers.location, target).toString(); } catch (e) { return finish(new Error('Invalid redirect')); }
      return request(next, timeout, redirects - 1, maxBytes, finish);
    }

    let stream = res;
    const enc = (res.headers['content-encoding'] || '').toLowerCase();
    if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        finish(new Error('Response too large (' + Math.round(size / 1048576) + ' MB)'));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => finish(null, {
      status,
      contentType: res.headers['content-type'] || '',
      body: Buffer.concat(chunks).toString('utf8')
    }));
    stream.on('error', (e) => finish(e));
  });

  req.on('error', (e) => finish(e));
  req.setTimeout(timeout, () => {
    req.destroy();
    finish(new Error('Timeout (' + Math.round(timeout / 1000) + ' s)'));
  });
  req.end();
}

// Keep only certain fields in a JSON array of objects (shrinks large channel lists).
function pickFields(body, fields) {
  let data;
  try { data = JSON.parse(body); } catch (e) { return body; }
  if (!Array.isArray(data)) return body;
  return JSON.stringify(data.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const o = {};
    fields.forEach((f) => { if (item[f] !== undefined) o[f] = item[f]; });
    return o;
  }));
}

register('fetch', (p) => {
  if (!p.url || typeof p.url !== 'string') throw fail('BAD_URL', 'url is missing');
  const timeout = Math.min(Math.max(+p.timeout || 15000, 1000), 120000);
  const maxBytes = Math.min(+p.maxBytes || MAX_FETCH, MAX_FETCH);
  return new Promise((resolve, reject) => {
    request(p.url, timeout, 5, maxBytes, (err, res) => {
      if (err) return reject(err);
      let body = res.body;
      if (Array.isArray(p.pick) && p.pick.length) body = pickFields(body, p.pick);
      resolve({ status: res.status, contentType: res.contentType, body });
    });
  });
});
