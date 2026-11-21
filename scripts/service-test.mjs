#!/usr/bin/env node
// Test of the new parts of the TV service (apps/launcher/service/service.js) without a TV: screen off,
// LG's home screen and the shortcut button (learning + LG Input Hook's keybinds.json).
//   node scripts/service-test.mjs
// The service is loaded with a fake "webos-service" and its paths pointed at a temporary folder.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPS } from './lib.mjs';

const dir = mkdtempSync(join(tmpdir(), 'g3svc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let passed = 0;
function ok(name, cond, detail) {
  if (cond) passed++; else failed++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

// Fake webos-service: stores the registered methods and logs Luna calls.
mkdirSync(join(dir, 'node_modules', 'webos-service'), { recursive: true });
writeFileSync(join(dir, 'node_modules', 'webos-service', 'index.js'), `
  const g = globalThis.__svc = { methods: {}, calls: [], power: 'Active' };
  module.exports = class Service {
    register(name, fn) { g.methods[name] = fn; }
    call(uri, params, cb) {
      g.calls.push({ uri, params });
      setTimeout(() => cb({ payload: /getPowerState/.test(uri) ? { returnValue: true, state: g.power } : { returnValue: true } }), 5);
    }
  };`);
mkdirSync(join(dir, 'input'));
mkdirSync(join(dir, 'lginputhook'));
writeFileSync(join(dir, 'ih.service'), 'x');
const HOME_BIND = { 773: { action: 'exec', command: "luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"com.g3custom.launcher\",\"keepAlive\":true}'" } };
writeFileSync(join(dir, 'lginputhook', 'keybinds.json'), JSON.stringify(HOME_BIND));
execFileSync('mkfifo', [join(dir, 'input', 'event0')]);
execFileSync('mkfifo', [join(dir, 'input', 'event3')]);

process.env.G3_TEST_DIR = dir;
process.env.NODE_PATH = join(dir, 'node_modules');
createRequire(import.meta.url)('node:module').Module._initPaths();
createRequire(import.meta.url)(join(APPS, 'launcher', 'service', 'service.js'));
const svc = globalThis.__svc;
const call = (name, payload) => new Promise((resolve) => svc.methods[name]({ payload, respond: resolve }));
const binds = () => JSON.parse(readFileSync(join(dir, 'lginputhook', 'keybinds.json'), 'utf8'));
const uris = () => svc.calls.map((c) => c.uri.replace(/^luna:\/\//, ''));

// A key event as the TV writes it (struct input_event: 16 bytes in 32-bit userland, otherwise 24).
const SIZE = process.arch === 'arm64' || process.arch === 'x64' ? 24 : 16;
function event(type, code, value) {
  const b = Buffer.alloc(SIZE);
  b.writeUInt16LE(type, SIZE - 8);
  b.writeUInt16LE(code, SIZE - 6);
  b.writeInt32LE(value, SIZE - 4);
  return b;
}
const press = (dev, events) => spawnSync('sh', ['-c', `cat > "${join(dir, 'input', dev)}"`], { input: Buffer.concat(events) });

console.log('\n  The TV service: screen off, LG home screen and shortcut button\n');
try {
  // --- Screen off
  let r = await call('screen', { op: 'off' });
  ok('screen off → turnOffScreen', r.returnValue && uris().includes('com.webos.service.tvpower/power/turnOffScreen'));
  svc.power = 'Screen Off';
  r = await call('screen', { op: 'toggle' });
  ok('screen toggle when the screen is off → turnOnScreen', r.state === 'on' && uris().includes('com.webos.service.tvpower/power/turnOnScreen'));
  r = await call('screen', { op: 'state' });
  ok('screen state', r.state === 'off' && r.power === 'Screen Off');
  r = await call('screen', { op: 'bort' });
  ok('an unknown op is rejected', r.returnValue === false && r.errorCode === 'BAD_ARGS');

  // --- LG's home screen
  r = await call('lgHome', {});
  const launch = svc.calls.find((c) => /applicationManager\/launch/.test(c.uri));
  ok('lgHome: flag + launch of com.webos.app.home', r.returnValue && existsSync(join(dir, 'g3custom-lghome')) && launch && launch.params.id === 'com.webos.app.home');

  // --- The shortcut button
  r = await call('keys', { op: 'get' });
  ok('keys get: no button chosen, hook installed but not running', r.screenoff === null && r.hook.installed && !r.hook.active);

  // Learning: releasing OK (value 0) and key repeat (2) do not count, the first press does.
  let learn = call('keys', { op: 'learn', timeout: 4000 });
  await sleep(300);
  press('event3', [event(1, 28, 0), event(0, 0, 0), event(1, 1037, 2), event(4, 4, 99), event(1, 1037, 1), event(0, 0, 0)]);
  r = await learn;
  ok('keys learn: reads the key code', r.returnValue && r.code === 1037 && r.reserved === false, JSON.stringify(r));
  learn = call('keys', { op: 'learn', timeout: 2000 });
  await sleep(300);
  press('event0', [event(1, 773, 1)]);
  r = await learn;
  ok('keys learn: the Home button is marked as reserved', r.code === 773 && r.reserved === true);
  r = await call('keys', { op: 'learn', timeout: 2000 });
  ok('keys learn: no button → TIMEOUT', r.returnValue === false && r.errorCode === 'TIMEOUT');

  r = await call('keys', { op: 'set', action: 'screenoff', code: 1037 });
  ok('keys set: the button is added, the Home button is left alone', r.screenoff === 1037 && binds()['1037'].action === 'exec' &&
    /90-g3custom screen toggle$/.test(binds()['1037'].command) && binds()['773'].command === HOME_BIND[773].command, binds()['1037'].command);
  ok('keys set: LG Input Hook is started', uris().includes('org.webosbrew.inputhook.service/start'));
  r = await call('keys', { op: 'set', action: 'screenoff', code: 1042 });
  ok('keys set again: the old button is replaced', r.screenoff === 1042 && !binds()['1037'] && !!binds()['1042'] && Object.keys(binds()).length === 2);
  r = await call('keys', { op: 'set', action: 'screenoff', code: 773 });
  ok('the Home button cannot be chosen', r.returnValue === false && r.errorCode === 'RESERVED' && binds()['773'].command === HOME_BIND[773].command);
  r = await call('keys', { op: 'set', action: 'screenoff', code: 28 });
  ok('the OK button cannot be chosen', r.returnValue === false && r.errorCode === 'RESERVED');
  writeFileSync(join(dir, 'lginputhook', 'keybinds.json'), JSON.stringify(Object.assign({ 400: { action: 'launch', id: 'netflix' } }, binds())));
  r = await call('keys', { op: 'set', action: 'screenoff', code: 400 });
  ok('a button with another shortcut is not overwritten', r.returnValue === false && r.errorCode === 'IN_USE' && binds()['400'].id === 'netflix');
  r = await call('keys', { op: 'clear', action: 'screenoff' });
  ok('keys clear: only our entry is removed', r.screenoff === null && !!binds()['773'] && !!binds()['400'] && Object.keys(binds()).length === 2);
} catch (e) {
  failed++;
  console.error('\n  ✗ ' + (e.stack || e.message));
} finally {
  spawnSync('pkill', ['-f', dir]);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`);
process.exit(failed ? 1 : 0);
