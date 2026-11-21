#!/usr/bin/env node
// Talk to the TV.  npm run tv -- <command> [app] [--dry-run]
//
// The TV is looked up in webOS Dev Manager's device list (~/.webos/ose/novacom-devices.json).
// Pick a device with TV_DEVICE=name if you have several. Passwords go through SSH_ASKPASS and are never printed.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { connect, targets } from './cdp.mjs';
import { APPS, BIN, DIST, appInfo, listApps, stage } from './lib.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const NO_LAUNCH = argv.includes('--no-launch');
const [cmd, ...rest] = argv.filter((a) => !a.startsWith('--'));

const INIT_SRC = join(APPS, 'launcher', 'service', 'g3custom-init.sh');
const INIT_DST = '/var/lib/webosbrew/init.d/90-g3custom';
const SERVICE_ID = 'com.g3custom.launcher.service';

// --- Device -------------------------------------------------------------------------

function readDevices() {
  const files = [join(homedir(), '.webos', 'ose', 'novacom-devices.json'), join(homedir(), '.webos', 'tv', 'novacom-devices.json')];
  const out = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      // Dev Manager can leave trailing commas – tolerate them.
      const list = JSON.parse(readFileSync(f, 'utf8').replace(/,\s*([}\]])/g, '$1'));
      for (const d of list) if (d && d.host) out.push(d);
    } catch (e) {
      console.warn(`(couldn't read ${f}: ${e.message})`);
    }
  }
  return out;
}

function device() {
  const all = readDevices().filter((d) => d.host !== '127.0.0.1' && d.host !== 'localhost');
  const want = process.env.TV_DEVICE;
  const hasAuth = (d) => d.password || d.privateKey;
  const d = want ? all.find((x) => x.name === want) : all.find(hasAuth) || all[0];
  if (!d) {
    throw new Error(want
      ? `No device named "${want}" in the webOS Dev Manager list.`
      : 'No TV found in the webOS Dev Manager list. Add the TV in Dev Manager (root, port 22) or run  npm run tv -- setup <ip> root');
  }
  // A name without a password but with the same host as one that has a password: borrow its credentials.
  if (!hasAuth(d)) {
    const twin = all.find((x) => x.host === d.host && hasAuth(x));
    if (twin) return Object.assign({}, d, { password: twin.password, privateKey: twin.privateKey, username: d.username || twin.username });
  }
  return d;
}

let askpassDir = null;
function sshEnv(d) {
  const env = Object.assign({}, process.env);
  if (d.password) {
    if (!askpassDir) {
      askpassDir = mkdtempSync(join(tmpdir(), 'g3tv-'));
      const file = join(askpassDir, 'askpass.sh');
      writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$G3_TV_PASS"\n');
      chmodSync(file, 0o700);
      process.on('exit', () => rmSync(askpassDir, { recursive: true, force: true }));
    }
    Object.assign(env, { SSH_ASKPASS: join(askpassDir, 'askpass.sh'), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: env.DISPLAY || ':0', G3_TV_PASS: d.password });
  }
  return env;
}

function sshArgs(d) {
  const args = ['-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'LogLevel=ERROR'];
  const key = d.privateKey && (d.privateKey.openSsh || d.privateKey.openSSH);
  if (key) args.push('-i', key.startsWith('/') ? key : join(homedir(), '.ssh', key));
  else if (d.password) args.push('-o', 'PubkeyAuthentication=no');
  return args;
}

const target = (d) => `${d.username || 'root'}@${d.host}`;

function show(tool, args) {
  console.log('  $ ' + [tool].concat(args).map((a) => (/[\s'"{}]/.test(a) ? JSON.stringify(a) : a)).join(' '));
}

function run(tool, args, opts = {}) {
  if (DRY) { show(tool, args); return { status: 0, stdout: '' }; }
  const r = spawnSync(tool, args, Object.assign({ encoding: 'utf8', stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' }, opts));
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`\n✗ ${basename(tool)} failed (exit code ${r.status}).`);
    process.exit(r.status || 1);
  }
  return r;
}

// Run a shell script on the TV (stdin from /dev/null – otherwise luna-send often does not reply).
function remote(d, script, opts = {}) {
  const wrapped = `sh -c ${shq(script)} </dev/null`;
  return run('ssh', sshArgs(d).concat(['-p', String(d.port || 22), target(d), wrapped]), Object.assign({ env: sshEnv(d) }, opts));
}

function upload(d, local, remotePath) {
  return run('scp', ['-O'].concat(sshArgs(d), ['-P', String(d.port || 22), local, `${target(d)}:${remotePath}`]), { env: sshEnv(d) });
}

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// --- ares (the Developer Mode route) ---------------------------------------------------

function ares(tool, args, opts = {}) {
  return run(join(BIN, tool), args, opts);
}

async function pkg(name) {
  const info = appInfo(name);
  // --no-bundle: leave the scripts unbundled (easier to debug with  npm run tv -- inspect).
  const dirs = DRY ? { app: `build/${name}`, service: `build/${name}.service` } : await stage(name, { bundle: !argv.includes('--no-bundle') });
  if (dirs.sizes) {
    const kb = (n) => (n / 1024).toFixed(0) + ' kB';
    for (const [f, s] of Object.entries(dirs.sizes)) console.log(`  ${f.padEnd(12)} ${String(s.files).padStart(2)} files  ${kb(s.before).padStart(7)} → ${kb(s.after)}`);
  }
  if (!DRY) mkdirSync(DIST, { recursive: true });
  ares('ares-package', [dirs.app].concat(dirs.service ? [dirs.service] : [], ['-o', DIST]));
  return { info, ipk: join(DIST, `${info.id}_${info.version}_all.ipk`) };
}

// Install over SSH + appInstallService (works with Homebrew Channel's SSH as root).
function installIpk(d, ipk, id) {
  const remotePath = '/tmp/' + basename(ipk);
  upload(d, ipk, remotePath);
  remote(d, [
    'rm -f /tmp/g3-install.out',
    `(luna-send -i -w 120000 luna://com.webos.appInstallService/dev/install '{"id":"${id}","ipkUrl":"${remotePath}","subscribe":true}' > /tmp/g3-install.out 2>&1) </dev/null >/dev/null 2>&1 &`,
    'P=$!; i=0',
    'while [ $i -lt 120 ]; do sleep 1; i=$((i+1)); grep -q -E \'"state": *"(installed|install failed|failed)"|errorCode\' /tmp/g3-install.out 2>/dev/null && break; done',
    'kill $P 2>/dev/null',
    `rm -f ${remotePath}`,
    'if grep -q \'"state": *"installed"\' /tmp/g3-install.out; then echo "✓ installed"; else echo "✗ installation failed:"; tail -c 400 /tmp/g3-install.out; exit 1; fi'
  ].join('\n'));
}

function launchApp(d, id) {
  remote(d, `luna-send -n 1 -w 5000 luna://com.webos.applicationManager/launch '{"id":"${id}","keepAlive":true}' >/dev/null 2>&1; echo "✓ launched"`);
}

// --- Commands -----------------------------------------------------------------------------

const commands = {
  // setup <ip>                    via the Developer Mode app (port 9922, ares)
  // setup <ip> root [password]     via Homebrew Channel's SSH server as root (port 22, ares)
  setup(ip, mode, password) {
    if (!ip) throw new Error('Give the IP address of the TV, e.g.  npm run tv -- setup 192.168.1.50 root');
    const name = process.env.TV_DEVICE || 'tv';
    ares('ares-setup-device', ['-r', name], { allowFail: true, stdio: 'ignore' });
    if (mode === 'root') {
      ares('ares-setup-device', ['-a', name, '-i', 'username=root', '-i', `host=${ip}`, '-i', 'port=22',
        '-i', `password=${password || 'alpine'}`, '-i', 'default=true']);
      console.log('\n✓ Done (root over SSH). SSH must be turned on in Homebrew Channel. Try:  npm run tv -- status');
      return;
    }
    ares('ares-setup-device', ['-a', name, '-i', 'username=prisoner', '-i', `host=${ip}`, '-i', 'port=9922', '-i', 'default=true']);
    console.log('\nEnter the "Passphrase" shown in the Developer Mode app on the TV:\n');
    ares('ares-novacom', ['--getkey', '-d', name]);
    console.log('\n✓ Done!');
  },

  // Package, install (over SSH) and launch.
  async deploy(name = 'launcher') {
    const d = device();
    const { info, ipk } = await pkg(name);
    console.log(`\n→ ${d.name || d.host} (${d.host})`);
    installIpk(d, ipk, info.id);
    if (!NO_LAUNCH) launchApp(d, info.id);
    console.log(`\n✓ ${info.title} ${info.version} is installed.` + (name === 'launcher' ? " If you haven't run  npm run tv -- root  yet, do it once." : ''));
  },

  // One-time step: init script + root for the launcher service. Run after the first install.
  root() {
    const d = device();
    console.log(`→ ${d.name || d.host} (${d.host}) as ${d.username || 'root'}`);
    upload(d, INIT_SRC, INIT_DST + '.new');
    remote(d, [
      'set -e',
      `mv -f ${INIT_DST}.new ${INIT_DST}`,
      `chmod 755 ${INIT_DST}`,
      // The old v2 script and its watcher.
      '[ -f /tmp/g3custom-watch.pid ] && kill "$(cat /tmp/g3custom-watch.pid)" 2>/dev/null || true',
      'rm -f /var/lib/webosbrew/init.d/90-g3custom-launcher /tmp/g3custom-watch.pid',
      `sh ${INIT_DST} stop >/dev/null 2>&1 || true`,
      `sh ${INIT_DST} elevate`,
      `sh ${INIT_DST} start`,
      'sleep 1',
      `sh ${INIT_DST} status`
    ].join('\n'));
    console.log('\n✓ Done. The launcher service now runs as root and is elevated again automatically after every boot and reinstall.');
    console.log('  Restart "Home" on the TV so it picks up your apps.');
  },

  status() {
    const d = device();
    console.log(`→ ${d.name || d.host} (${d.host})`);
    remote(d, [
      `if [ -f ${INIT_DST} ]; then sh ${INIT_DST} status; else echo "init script missing (run: npm run tv -- root)"; fi`,
      `rm -f /tmp/g3-status.out`,
      `(luna-send -n 1 -w 6000 luna://${SERVICE_ID}/status '{}' > /tmp/g3-status.out 2>&1) </dev/null >/dev/null 2>&1 &`,
      'sleep 3; echo "service: $(cat /tmp/g3-status.out 2>/dev/null)"',
      `(luna-send -n 1 -w 4000 luna://com.webos.applicationManager/getForegroundAppInfo '{}' > /tmp/g3-fg.out 2>&1) </dev/null >/dev/null 2>&1 &`,
      'sleep 1; echo "foreground app: $(sed -n \'s/.*"appId": *"\\([^"]*\\)".*/\\1/p\' /tmp/g3-fg.out)"'
    ].join('\n'), { allowFail: true });
  },

  async package(name = 'launcher') {
    const { ipk } = await pkg(name);
    console.log(`\n✓ Packaged: ${ipk}`);
  },

  launch(name = 'launcher') {
    launchApp(device(), appInfo(name).id);
  },

  close(name = 'launcher') {
    remote(device(), `luna-send -n 1 -w 5000 luna://com.webos.applicationManager/close '{"id":"${appInfo(name).id}"}'`);
  },

  uninstall(name = 'launcher') {
    const id = appInfo(name).id;
    remote(device(), `(luna-send -i -w 30000 luna://com.webos.appInstallService/dev/remove '{"id":"${id}","subscribe":true}' > /tmp/g3-rm.out 2>&1) </dev/null >/dev/null 2>&1 & sleep 6; grep -o '"state":"[a-z ]*"' /tmp/g3-rm.out | tail -1`);
  },

  // Opens Chrome DevTools for the app (ares-inspect, needs the device set up in ares).
  inspect(name = 'launcher') {
    const d = device();
    ares('ares-inspect', ['-d', d.name, '--app', appInfo(name).id, '--open']);
  },

  // Metrics from the launcher on the TV (js/core/perf.js), via the TV's remote debugger (port 9998)
  // through an SSH tunnel. --reload reloads the launcher first (visible on the TV) and measures startup.
  // --json prints the raw data, --clear resets the channel-change log.
  async perf() {
    await withPage(async (page) => {
      if (argv.includes('--clear')) await page.eval('Perf.clearZap()');
      if (argv.includes('--reload')) {
        console.log('→ reloading the launcher on the TV …');
        await page.send('Page.reload', { ignoreCache: false });
        for (let i = 0; i < 80; i++) {
          await sleep(250);
          try { if (await page.eval('!!(window.Perf && Perf.report().boot.iptvReady)')) break; } catch { /* the page is loading */ }
        }
      }
      const r = JSON.parse(await page.eval('JSON.stringify(window.Perf ? Perf.report() : null)'));
      if (!r) throw new Error('The launcher on the TV has no Perf module (older version?) – run npm run deploy first.');
      if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
      printPerf(r);
    });
  },

  // Run an expression in the launcher's page on the TV and print the result (debugging – not visible
  // on the TV if the expression only reads). No expression: player and track state, see IPTV.tracks.debug().
  //   npm run tv -- eval 'IPTV.player.state()'
  async eval(expr) {
    await withPage(async (page) => {
      const v = await page.eval(expr || 'JSON.stringify({ state: IPTV.player.state(), kind: IPTV.player.kind(), tracks: IPTV.tracks.debug() }, null, 1)');
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    });
  },

  // Screenshot of what the TV is showing right now (picture + graphics), saved on the computer.
  //   npm run tv -- shot [file.jpg]
  shot(file = join(DIST, 'tv-shot.jpg')) {
    const d = device();
    mkdirSync(DIST, { recursive: true });
    remote(d, `rm -f /tmp/g3-shot.jpg; luna-send -n 1 -w 8000 luna://com.webos.service.capture/executeOneShot '{"path":"/tmp/g3-shot.jpg","method":"DISPLAY","format":"JPEG","width":1920,"height":1080}' >/dev/null; [ -s /tmp/g3-shot.jpg ]`);
    run('scp', ['-O'].concat(sshArgs(d), ['-P', String(d.port || 22), `${target(d)}:/tmp/g3-shot.jpg`, file]), { env: sshEnv(d) });
    remote(d, 'rm -f /tmp/g3-shot.jpg');
    console.log(`✓ ${file}`);
  },

  // Turn the screen off/on (the sound keeps playing).  npm run tv -- screen off|on|toggle
  screen(op = 'toggle') {
    if (!['off', 'on', 'toggle'].includes(op)) throw new Error('Give off, on or toggle');
    remote(device(), `sh ${INIT_DST} screen ${op}; echo "✓ screen: ${op}"`);
  },

  // Show LG's own home screen (the Home button takes you back to the launcher).
  lghome() {
    remote(device(), `sh ${INIT_DST} lghome; echo "✓ LG home screen opened"`);
  },

  // Which code does a button on the remote send? Press it within ten seconds.
  // With a code:  npm run tv -- key 1037  binds the button to Screen off (via LG Input Hook),  key clear  removes it.
  key(code) {
    const d = device();
    const call = (payload, wait) => `luna-send -n 1 -w ${wait} luna://${SERVICE_ID}/keys '${JSON.stringify(payload)}'`;
    if (!code) {
      console.log('→ press the button on the remote now (10 s) …');
      remote(d, call({ op: 'learn', timeout: 10000 }, 14000), { allowFail: true });
    } else if (code === 'clear') {
      remote(d, call({ op: 'clear', action: 'screenoff' }, 8000), { allowFail: true });
    } else {
      if (!/^\d+$/.test(code)) throw new Error('Give the key code (digits), or clear');
      remote(d, call({ op: 'set', action: 'screenoff', code: Number(code) }, 8000), { allowFail: true });
    }
  },

  apps() {
    for (const a of listApps()) {
      const i = appInfo(a);
      console.log(`  ${a.padEnd(16)} ${i.id.padEnd(32)} ${i.title}`);
    }
  },

  device() {
    const d = device();
    console.log(`  name: ${d.name}\n  host: ${d.host}:${d.port || 22}\n  user: ${d.username || 'root'}\n  login: ${d.privateKey ? 'key' : d.password ? 'password (saved in Dev Manager)' : 'none'}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open the launcher's page on the TV via the remote debugger (port 9998) through an SSH tunnel.
async function withPage(fn) {
  const d = device();
  const local = 19998;
  const tunnelArgs = sshArgs(d).concat(['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${local}:127.0.0.1:9998`, '-p', String(d.port || 22), target(d)]);
  if (DRY) { show('ssh', tunnelArgs); return; }
  const tunnel = spawn('ssh', tunnelArgs, { env: sshEnv(d), stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    const base = `http://127.0.0.1:${local}`;
    let list = null;
    for (let i = 0; i < 60 && !list; i++) {
      try { list = await targets(base); } catch { await sleep(250); }
    }
    if (!list) throw new Error('Could not reach the remote debugger on the TV (port 9998) over SSH.');
    const t = list.find((x) => /com\.g3custom\.launcher/.test(x.url) && x.webSocketDebuggerUrl);
    if (!t) throw new Error('The launcher is not running on the TV right now – start it and try again.');
    const page = await connect(t.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${local}`));
    try {
      await fn(page);
    } finally {
      page.close();
    }
  } finally {
    tunnel.kill();
  }
}

function printPerf(r) {
  const b = r.boot || {};
  const order = ['perf', 'main', 'home', 'homeFrame', 'firstContentfulPaint', 'domContentLoaded', 'load', 'appsReady', 'iptvReady'];
  const names = { perf: 'first script', main: 'all scripts', home: 'home screen built', homeFrame: 'first frame', firstContentfulPaint: 'FCP', domContentLoaded: 'DOMContentLoaded', load: 'load', appsReady: 'apps', iptvReady: 'IPTV ready' };
  console.log('\n  Startup (ms since the page started loading)');
  console.log('    ' + order.filter((k) => b[k] != null).map((k) => `${names[k]} ${b[k]}`).join(' · '));
  const k = r.keys;
  console.log('\n  Key press → next frame');
  console.log(k ? `    ${k.n} presses · median ${k.p50} ms · p90 ${k.p90} ms · max ${k.max} ms` : '    (no presses yet)');
  console.log('\n  Channel change / movie start → first frame');
  const z = Object.entries(r.zap || {});
  if (!z.length) console.log('    (nothing measured yet – change channels a few times)');
  for (const [name, s] of z) console.log(`    ${name.padEnd(12)} ${String(s.n).padStart(3)} runs · median ${s.p50} ms · p90 ${s.p90} ms · max ${s.max} ms`);
  console.log(`\n  Long tasks ${r.longTasks.n} (${r.longTasks.ms} ms) · JS memory ${r.memory ? r.memory.usedMB + ' MB' : '?'} · DOM ${r.dom} elements · ${r.scripts} scripts\n`);
}

function help() {
  console.log(`
  npm run tv -- <command> [app] [--dry-run]     (app = folder name in apps/, default: launcher)

    deploy [app]   Package, install over SSH and launch   (--no-launch: don't launch, --no-bundle: unbundled)
    root           One-time step: give the launcher service root + autostart (run after the first deploy)
    status         Show the state of the TV (root, watcher, foreground app)
    package [app]  Only build the .ipk into dist/ (install it with e.g. webOS Dev Manager)
    launch [app]   Launch the app      close [app]   Close the app
    uninstall [app]
    device         Show which TV is used (from webOS Dev Manager)
    inspect [app]  Open DevTools for the app
    perf           Metrics from the launcher (startup, key presses, channel changes)  --reload --json --clear
    eval [expr]    Run an expression in the launcher on the TV (no expression: player and track state)
    shot [file]    Screenshot of what the TV shows (saved to dist/tv-shot.jpg)
    screen [off|on|toggle]   Turn the screen off/on – the sound keeps playing
    lghome         Show LG's own home screen
    key [code|clear]   No code: show the code of the next button you press. With a code: bind it to Screen off
    setup <ip> root [password]   Add the TV to ares (only needed for inspect)
    apps           List the apps in the project

  The TV is taken from the webOS Dev Manager list. Several TVs:  TV_DEVICE=name npm run tv -- deploy
`);
}

try {
  if (!cmd || !commands[cmd]) help();
  else {
    const r = commands[cmd](...rest);
    if (r && typeof r.then === 'function') {
      r.catch((e) => {
        console.error('\n✗ ' + e.message);
        process.exit(1);
      });
    }
  }
} catch (e) {
  console.error('\n✗ ' + e.message);
  process.exit(1);
}
