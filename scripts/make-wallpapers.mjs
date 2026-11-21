#!/usr/bin/env node
// Renders the launcher's built-in wallpapers ("Liquid Glass" abstractions on black, gentle
// on OLED) with headless Chrome:  npm run wallpapers
//
//   apps/launcher/assets/wallpapers/<name>.jpg       1920×1080
//   apps/launcher/assets/wallpapers/<name>-blur.jpg  128×72, pre-blurred (scaled up = free blur in the app)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPS } from './lib.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = join(APPS, 'launcher', 'assets', 'wallpapers');
const W = 1920;
const H = 1080;

// Glowing colour fields behind the glass: [cx, cy, rx, ry, colour, opacity]
// Bands of glass: cubic curves (upper edge, lower edge).
const SCENES = {
  aurora: {
    glows: [[1380, 260, 760, 420, '#19d3a2', 0.85], [1720, 520, 520, 360, '#1f6bff', 0.8], [980, 120, 520, 260, '#7cf7d4', 0.35]],
    band: 'M -100 690 C 420 520 760 300 1180 270 C 1560 240 1820 330 2040 250 L 2040 520 C 1800 600 1560 520 1200 560 C 820 600 460 840 -100 980 Z',
    band2: 'M 900 -60 C 1180 120 1460 160 2040 60 L 2040 -60 Z',
    tint: '#9ff5e1'
  },
  ember: {
    glows: [[1500, 300, 700, 420, '#ff5a1f', 0.85], [1120, 180, 520, 300, '#ff2d6f', 0.7], [1780, 620, 460, 320, '#ffb020', 0.55]],
    band: 'M 520 1180 C 760 760 1000 420 1420 300 C 1700 220 1880 260 2040 200 L 2040 470 C 1820 470 1640 470 1420 560 C 1120 690 940 960 860 1180 Z',
    tint: '#ffd2b8'
  },
  indigo: {
    glows: [[1260, 300, 820, 460, '#4b3cff', 0.9], [1700, 180, 460, 300, '#b04bff', 0.6], [880, 420, 520, 360, '#1d4dff', 0.55]],
    band: 'M -100 520 C 360 330 760 470 1100 380 C 1460 290 1640 80 2040 120 L 2040 330 C 1700 300 1520 480 1160 600 C 780 720 380 600 -100 760 Z',
    tint: '#c9c2ff'
  },
  lagoon: {
    glows: [[600, 260, 760, 420, '#00b7ff', 0.8], [1060, 120, 520, 260, '#38ffe0', 0.45], [300, 600, 520, 300, '#2b5bff', 0.6]],
    band: 'M -100 300 C 260 180 560 380 880 360 C 1240 340 1420 120 1760 -60 L 2040 -60 L 2040 40 C 1660 220 1380 520 960 600 C 560 680 240 520 -100 600 Z',
    tint: '#bdf3ff'
  },
  rose: {
    glows: [[1440, 360, 740, 440, '#ff3d9a', 0.8], [1720, 160, 480, 300, '#9b4dff', 0.65], [1080, 560, 520, 320, '#ff7a59', 0.4]],
    band: 'M 760 -60 C 900 260 1160 480 1500 520 C 1760 550 1900 500 2040 430 L 2040 700 C 1880 760 1700 800 1460 770 C 1060 720 760 420 560 -60 Z',
    tint: '#ffc6e2'
  },
  graphite: {
    glows: [[1380, 280, 760, 420, '#8e9bb0', 0.55], [1700, 520, 500, 320, '#5c6b84', 0.5], [1000, 160, 500, 260, '#cfd8e6', 0.25]],
    band: 'M -100 760 C 380 600 820 380 1240 330 C 1600 290 1820 360 2040 300 L 2040 560 C 1800 620 1580 560 1240 600 C 840 650 420 900 -100 1060 Z',
    band2: 'M 1200 -60 C 1400 80 1700 120 2040 40 L 2040 -60 Z',
    tint: '#ffffff'
  }
};

function svg(name, s) {
  const grad = (id, c, o) => `<radialGradient id="${id}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${c}" stop-opacity="${o}"/><stop offset="0.5" stop-color="${c}" stop-opacity="${o * 0.4}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`;
  const defsGlow = s.glows.map(([, , , , c, o], i) => grad('g' + i, c, o) + grad('w' + i, '#fff', Math.min(1, o * 1.2))).join('');
  const blobs = (dx, dy, k, pre) => s.glows.map(([cx, cy, rx, ry], i) =>
    `<ellipse cx="${cx + dx}" cy="${cy + dy}" rx="${rx * k}" ry="${ry * k}" fill="url(#${pre}${i})"/>`).join('');
  const bands = [s.band].concat(s.band2 ? [s.band2] : []);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    ${defsGlow}
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="50"/></filter>
    <filter id="mid" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="rim" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="0.9"/></filter>
    <filter id="caustic" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 0"/></filter>
    <linearGradient id="sheen" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0.10"/><stop offset="0.35" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.62" stop-color="#000" stop-opacity="0.1"/><stop offset="1" stop-color="#000" stop-opacity="0.8"/>
    </linearGradient>
    <clipPath id="clip">${bands.map((d) => `<path d="${d}"/>`).join('')}</clipPath>
    <!-- Light reaching the glass: the edges only glow where there is colour behind them. -->
    <mask id="lit" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
      <rect width="100%" height="100%" fill="#000"/>
      <g filter="url(#soft)">${blobs(0, 0, 1.25, 'w')}</g>
      <rect width="100%" height="100%" fill="#fff" opacity="0.1"/>
    </mask>
  </defs>
  <rect width="100%" height="100%" fill="#000"/>
  <g filter="url(#soft)">${blobs(0, 0, 1, 'g')}</g>
  <!-- The glass: enlarged, offset glow inside the band = lens/refraction. -->
  <g clip-path="url(#clip)">
    <rect width="100%" height="100%" fill="#000" opacity="0.5"/>
    <g filter="url(#mid)" opacity="1">${blobs(-70, 50, 1.18, 'g')}${blobs(-70, 50, 0.7, 'g')}</g>
    <rect width="100%" height="100%" fill="url(#sheen)"/>
    <g mask="url(#lit)">${bands.map((d) => `<path d="${d}" fill="none" stroke="${s.tint}" stroke-opacity="0.55" stroke-width="26" filter="url(#caustic)"/>`).join('')}</g>
  </g>
  <g fill="none" mask="url(#lit)">
    ${bands.map((d) => `<path d="${d}" stroke="#fff" stroke-opacity="0.9" stroke-width="2.2" filter="url(#rim)"/>`).join('')}
  </g>
  <rect width="100%" height="100%" fill="url(#fade)"/>
  <rect width="100%" height="100%" filter="url(#grain)" opacity="0.04"/>
</svg>`;
}

function render(name, scene, dir) {
  const html = join(dir, name + '.html');
  const png = join(dir, name + '.png');
  writeFileSync(html, `<!doctype html><html><body style="margin:0;background:#000">${svg(name, scene)}</body></html>`);
  const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`, `--screenshot=${png}`, 'file://' + html], { stdio: 'ignore' });
  if (r.status !== 0 || !existsSync(png)) throw new Error('Chrome could not render ' + name);
  const jpg = join(OUT, name + '.jpg');
  const blur = join(OUT, name + '-blur.jpg');
  spawnSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '84', png, '--out', jpg], { stdio: 'ignore' });
  // Blurred variant: heavy blur already here, then scaled down to 128×72 (scaled up in the app).
  const bhtml = join(dir, name + '-b.html');
  const bpng = join(dir, name + '-b.png');
  writeFileSync(bhtml, `<!doctype html><html><body style="margin:0;background:#000;overflow:hidden"><img src="file://${png}" style="width:${W}px;height:${H}px;display:block;filter:blur(56px) saturate(1.25);transform:scale(1.12)"></body></html>`);
  spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', `--window-size=${W},${H}`, `--screenshot=${bpng}`, 'file://' + bhtml], { stdio: 'ignore' });
  spawnSync('sips', ['-z', '72', '128', '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', existsSync(bpng) ? bpng : png, '--out', blur], { stdio: 'ignore' });
  console.log(`  ${name.padEnd(10)} ${Math.round(statSync(jpg).size / 1024)} kB`);
}

if (!existsSync(CHROME)) {
  console.error('Chrome not found. Set its path with CHROME=/path/to/chrome');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'g3wp-'));
const only = process.argv.slice(2);
try {
  for (const [name, scene] of Object.entries(SCENES)) {
    if (only.length && !only.includes(name)) continue;
    render(name, scene, tmp);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log('✓ ' + OUT);
