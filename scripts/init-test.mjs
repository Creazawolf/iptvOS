#!/usr/bin/env node
// Test of the watcher (apps/launcher/service/g3custom-init.sh) against a fake TV: our own "luna-send"
// that logs the calls and emits the foreground apps that the test writes to a file.
//   node scripts/init-test.mjs
// Covers: the Home button (LG home screen → the launcher), the "LG webOS" tile (the home screen may stay
// until another app opens), Screen off (toggling, and the guard against repeated presses) and starting LG Input Hook.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPS } from './lib.mjs';

const INIT = join(APPS, 'launcher', 'service', 'g3custom-init.sh');
const dir = mkdtempSync(join(tmpdir(), 'g3init-'));
const f = (name) => join(dir, name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
let passed = 0;
function ok(name, cond, detail) {
  if (cond) passed++; else failed++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

// Fake luna-send: logs "<uri> <payload>" and replies like the TV.
writeFileSync(f('luna-send'), `#!/bin/sh
sub=0
while [ $# -gt 2 ]; do
  case "$1" in -i) sub=1; shift ;; -n|-w) shift 2 ;; *) shift ;; esac
done
uri=$1; payload=$2
echo "$uri $payload" >> "${f('calls.log')}"
case "$uri" in
  *getForegroundAppInfo)
    if [ $sub = 1 ]; then exec tail -n +1 -f "${f('foreground.feed')}"; fi
    echo '{"returnValue":true,"appId":"com.g3custom.launcher"}' ;;
  *applicationManager/running)
    if [ -f "${f('launcher.running')}" ]; then echo '{"returnValue":true,"running":[{"id":"youtube.leanback.v4"},{"id":"com.g3custom.launcher"}]}'
    else echo '{"returnValue":true,"running":[{"id":"youtube.leanback.v4"}]}'; fi ;;
  *getPowerState)
    if [ $sub = 1 ]; then exec sleep 600; fi
    echo "{ \\"state\\": \\"$(cat "${f('power.state')}")\\", \\"returnValue\\": true }" ;;
  *) echo '{ "returnValue": true }' ;;
esac
`);
chmodSync(f('luna-send'), 0o755);
writeFileSync(f('foreground.feed'), '');
writeFileSync(f('power.state'), 'Active');
writeFileSync(f('calls.log'), '');
writeFileSync(f('svc'), 'Exec=/x/org.webosbrew.hbchannel.service/run-js-service -n /y\n');
writeFileSync(f('ih'), 'Exec=/x/org.webosbrew.hbchannel.service/run-js-service -n /z\n');

const env = Object.assign({}, process.env, {
  G3_LUNA_SEND: f('luna-send'), G3_SVCFILE: f('svc'), G3_IHFILE: f('ih'), G3_PIDFILE: f('pid'), G3_NOLAUNCH: f('nolaunch'),
  G3_NOHOME: f('nohome'), G3_HWFIFO: f('home.fifo'), G3_FIFO: f('power.fifo'), G3_LOG: f('log'), G3_GUARD_S: '1',
  G3_LGHOME: f('lghome'), G3_SCREENTS: f('screen.ts'), G3_IHMARK: f('inputhook'), G3_HB: f('no-hb'), G3_PRELOAD_EVERY: '3'
});
const run = (...args) => spawnSync('sh', [INIT, ...args], { env, encoding: 'utf8' });
const calls = () => readFileSync(f('calls.log'), 'utf8').split('\n').filter(Boolean);
const count = (re) => calls().filter((c) => re.test(c)).length;
const feed = (appId) => appendFileSync(f('foreground.feed'), `{"appId": "${appId}", "returnValue": true}\n`);
const LAUNCH = /applicationManager\/launch \{"id":"com\.g3custom\.launcher","keepAlive":true\}/;
const PRELOAD = /applicationManager\/launch \{"id":"com\.g3custom\.launcher","preload":"full","keepAlive":true\}/;

console.log('\n  The watcher (g3custom-init.sh) against a fake TV\n');
writeFileSync(f('launcher.running'), '');
const watcher = spawn('sh', [INIT, 'watch', 'nolaunch'], { env, stdio: 'ignore' });

try {
  await sleep(1200);
  ok('the watcher is running', run('status').stdout.includes('running'), run('status').stdout.trim().replace(/\n/g, ' · '));
  ok('LG Input Hook is started when it is not running', count(/inputhook\.service\/start/) >= 1);
  ok('status shows that the hook is not in place yet', /input hook off/.test(run('status').stdout));

  // --- The Home button
  feed('youtube.leanback.v4');
  await sleep(500);
  ok('an ordinary app in the foreground: the launcher is not launched', count(LAUNCH) === 0);
  feed('com.webos.app.home');
  await sleep(700);
  ok('LG home screen (Home button): the launcher is launched', count(LAUNCH) === 1);

  // --- The "LG webOS" tile
  ok('lghome: opens the LG home screen and sets the flag', run('lghome').status === 0 && existsSync(f('lghome')) && count(/launch .*com\.webos\.app\.home/) === 1);
  feed('com.webos.app.home');
  await sleep(700);
  ok('opened on purpose: the launcher does not take over', count(LAUNCH) === 1);
  feed('netflix');
  await sleep(700);
  ok('another app opens: the flag is removed', !existsSync(f('lghome')));
  feed('com.webos.app.home');
  await sleep(700);
  ok('the next time the LG home screen appears: the launcher is launched again', count(LAUNCH) === 2);

  // --- Screen off
  run('screen', 'toggle');
  ok('screen off: turns the screen off when the TV is active', count(/turnOffScreen/) === 1 && count(/turnOnScreen/) === 0);
  writeFileSync(f('power.state'), 'Screen Off');
  run('screen', 'toggle');
  ok('a repeated press within two seconds does nothing', count(/turnOnScreen/) === 0 && count(/turnOffScreen/) === 1);
  await sleep(2100);
  run('screen', 'toggle');
  ok('screen off: turns the screen on when it is off', count(/turnOnScreen/) === 1 && count(/turnOffScreen/) === 1);
  run('screen', 'off');
  run('screen', 'on');
  ok('screen off / on directly', count(/turnOffScreen/) === 2 && count(/turnOnScreen/) === 2);

  // --- The launcher in the background
  ok('launcher running: no background start', count(PRELOAD) === 0);
  rmSync(f('launcher.running'));
  await sleep(3600);
  ok('launcher not running (e.g. after a reinstall): started in the background', count(PRELOAD) >= 1 && count(LAUNCH) === 2, count(PRELOAD) + ' background starts');
  writeFileSync(f('nolaunch'), '1');
  const pre = count(PRELOAD);
  await sleep(3600);
  ok('autostart off: no background start', count(PRELOAD) === pre);
  rmSync(f('nolaunch'));
  writeFileSync(f('launcher.running'), '');

  // --- Hook running: no more start attempts
  writeFileSync(f('inputhook'), '');
  await sleep(300);
  const starts = count(/inputhook\.service\/start/);
  await sleep(2300);
  ok('once the hook is running, no more start attempts are made', count(/inputhook\.service\/start/) === starts && /input hook on/.test(run('status').stdout));
} catch (e) {
  failed++;
  console.error('\n  ✗ ' + e.message);
} finally {
  run('stop');
  watcher.kill();
  spawnSync('pkill', ['-f', dir]);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`);
process.exit(failed ? 1 : 0);
