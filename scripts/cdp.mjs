// Minimal Chrome DevTools Protocol client (Node ≥ 22 has WebSocket built in).
// Used by  npm run tv -- perf  (against the TV's web engine) and  npm run test:ui  (local Chrome).
//
//   const page = await connect(wsUrl)
//   await page.send('Runtime.enable')
//   const v = await page.eval('1 + 1')
//   page.on('Runtime.consoleAPICalled', (p) => …)
//   page.close()
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function connect(wsUrl) {
  if (typeof WebSocket === 'undefined') throw new Error('Requires Node 22 or newer (WebSocket is missing).');
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Could not connect to ' + wsUrl)), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of handlers.get(msg.method) || []) fn(msg.params);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    on(method, fn) {
      if (!handlers.has(method)) handlers.set(method, []);
      handlers.get(method).push(fn);
    },
    // Run an expression in the page and return the value (awaits promises).
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
      return r.result.value;
    },
    // A real key press (keydown + keyup), like the remote.
    async key(code, key, keyCode) {
      const base = { code, key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    close() { try { ws.close(); } catch { /* already closed */ } }
  };
}

// Pages (targets) that a DevTools port exposes.
export async function targets(base) {
  const r = await fetch(base + '/json/list');
  return r.json();
}

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

// Start a local headless Chrome with its own temporary profile. Returns { base, stop }.
export async function launchChrome({ port = 9333, width = 1920, height = 1080 } = {}) {
  const bin = process.env.CHROME_PATH || CHROME_PATHS.find((p) => existsSync(p));
  if (!bin) throw new Error('No Chrome found. Set its path with CHROME_PATH=…');
  const profile = mkdtempSync(join(tmpdir(), 'g3-chrome-'));
  const proc = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'
  ], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/json/version'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return {
    base,
    stop() {
      try { proc.kill(); } catch { /* already stopped */ }
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 300);
    }
  };
}
