#!/usr/bin/env node
// Turns apps/<app>/icon.svg into icon.png (80×80) and largeIcon.png (130×130)
// with headless Chrome.   npm run icons [-- app]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDir, listApps } from './lib.mjs';

const CHROME_PATHS = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

const chrome = CHROME_PATHS.find((p) => existsSync(p));
if (!chrome) {
  console.error('Chrome not found. Set CHROME=/path/to/chrome');
  process.exit(1);
}

function render(svgFile, size, outFile) {
  const tmp = mkdtempSync(join(tmpdir(), 'icon-'));
  const html = join(tmp, 'icon.html');
  const svg = readFileSync(svgFile, 'utf8');
  writeFileSync(
    html,
    `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`
  );
  const r = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    `--window-size=${size},${size}`,
    `--screenshot=${outFile}`,
    pathToFileURL(html).href
  ], { stdio: 'pipe' });
  rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

const targets = process.argv[2] ? [process.argv[2]] : listApps();
for (const name of targets) {
  const dir = appDir(name);
  const svg = join(dir, 'icon.svg');
  if (!existsSync(svg)) {
    console.log(`  ${name}: no icon.svg, skipping`);
    continue;
  }
  render(svg, 80, join(dir, 'icon.png'));
  render(svg, 130, join(dir, 'largeIcon.png'));
  console.log(`  ✓ ${name}: icon.png + largeIcon.png`);
}
