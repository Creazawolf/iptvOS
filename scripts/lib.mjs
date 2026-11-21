// Shared helpers for the scripts.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const APPS = join(ROOT, 'apps');
export const SHARED = join(ROOT, 'shared');
export const BUILD = join(ROOT, 'build');
export const DIST = join(ROOT, 'dist');
export const BIN = join(ROOT, 'node_modules', '.bin');

export function listApps() {
  return readdirSync(APPS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(APPS, d.name, 'appinfo.json')))
    .map((d) => d.name);
}

export function appDir(name) {
  const dir = join(APPS, name);
  if (!existsSync(join(dir, 'appinfo.json'))) {
    const known = listApps().join(', ') || '(none)';
    throw new Error(`No app named "${name}". Available: ${known}`);
  }
  return dir;
}

export function appInfo(name) {
  return JSON.parse(readFileSync(join(appDir(name), 'appinfo.json'), 'utf8'));
}

// Files that are left out of the package.
const SKIP = new Set(['service', 'icon.svg', 'config.local.example.js', '.DS_Store']);

// Copies the app + shared/ (as lib/) to build/<app>, and its service, if any
// (apps/<app>/service), to build/<app>.service – ready for ares-package.
//   opts.bundle (default true)   bundle scripts and CSS, see bundle()
//   opts.dev                     keep data-dev scripts (to try the package in the browser)
export async function stage(name, opts = {}) {
  const src = appDir(name);
  const out = join(BUILD, name);
  const svcSrc = join(src, 'service');
  const svcOut = join(BUILD, name + '.service');
  rmSync(out, { recursive: true, force: true });
  rmSync(svcOut, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(src, out, {
    recursive: true,
    filter: (path) => !SKIP.has(path.slice(src.length + 1).split(/[\\/]/)[0]) && !path.endsWith('.DS_Store')
  });
  cpSync(SHARED, join(out, 'lib'), { recursive: true });
  let service = null;
  if (existsSync(join(svcSrc, 'services.json'))) {
    cpSync(svcSrc, svcOut, { recursive: true });
    service = svcOut;
  }
  const sizes = opts.bundle !== false && existsSync(join(out, 'index.html')) ? await bundle(out, opts) : null;
  return { app: out, service, sizes };
}

// Bundle an app (in place in build/<app>): every <script src> in index.html goes into app.js (in the
// same order), those with data-lazy="x" go into x.js (loaded later by the app itself), data-dev
// scripts are removed and all stylesheets become css/app.css. Minified for the TV's Chromium 132.
// Why: the web engine on the TV has no code cache for apps from file:// – every cold start parses
// all the JavaScript again. Fewer and smaller files = faster startup.
export async function bundle(dir, { dev = false } = {}) {
  const esbuild = await import('esbuild');
  const htmlFile = join(dir, 'index.html');
  let html = readFileSync(htmlFile, 'utf8');
  const groups = new Map([['app', []]]);
  const used = new Set();

  html = html.replace(/[ \t]*<script\b([^>]*?)\bsrc="([^"]+)"([^>]*)><\/script>[ \t]*\n?/g, (tag, a, src, b) => {
    const attrs = a + ' ' + b;
    if (/\bdata-dev\b/.test(attrs) && !dev) {
      used.add(join(dir, src)); // development aid (fake TV) – not shipped to the TV
      return '';
    }
    const file = join(dir, src);
    if (!existsSync(file)) {
      if (/\bonerror=/.test(attrs)) return ''; // optional file (config.local.js) that does not exist
      throw new Error(`index.html points to ${src}, which is missing`);
    }
    const lazy = /\bdata-lazy="([^"]+)"/.exec(attrs);
    const group = lazy ? lazy[1] : 'app';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(src);
    used.add(file);
    return group === 'app' && groups.get('app').length === 1 ? '  <script src="app.js"></script>\n' : '';
  });

  const css = [];
  html = html.replace(/[ \t]*<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>[ \t]*\n?/g, (tag, href) => {
    css.push(href);
    used.add(join(dir, href));
    return css.length === 1 ? '  <link rel="stylesheet" href="css/app.css">\n' : '';
  });

  const lazyNames = [...groups.keys()].filter((g) => g !== 'app');
  const sizes = {};
  const sourceBytes = (list) => list.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  // Each file in its own try/catch: as with separate <script> tags, an error in one file does not stop
  // the rest (otherwise e.g. an error in config.local.js would block main.js – and keep the app from showing).
  const js = (list, prefix = '') => prefix + list.map((src) =>
    `/* ${src} */\ntry {\n${readFileSync(join(dir, src), 'utf8')}\n;} catch (e) { console.error(${JSON.stringify('[' + src + ']')}, e); }`
  ).join('\n');
  const minify = (code, loader = 'js') => esbuild.transformSync(code, { loader, minify: true, target: 'chrome132', legalComments: 'none', charset: 'utf8' }).code;

  for (const [group, list] of groups) {
    // The app needs to know where the lazy parts are (see js/iptv/lazy.js).
    const prefix = group === 'app' ? lazyNames.map((g) => `window.__LAZY_${g.replace(/\W/g, '_').toUpperCase()}=${JSON.stringify(g + '.js')};\n`).join('') : '';
    const out = minify(js(list, prefix));
    writeFileSync(join(dir, group + '.js'), out);
    sizes[group + '.js'] = { files: list.length, before: sourceBytes(list), after: Buffer.byteLength(out) };
  }
  if (css.length) {
    // All stylesheets live in css/, so relative url() references (the font) work unchanged.
    if (!css.every((h) => h.startsWith('css/'))) throw new Error('Stylesheets outside css/ are not supported by the bundler');
    const out = minify(css.map((h) => readFileSync(join(dir, h), 'utf8')).join('\n'), 'css');
    writeFileSync(join(dir, 'css', 'app.css'), out);
    sizes['css/app.css'] = { files: css.length, before: sourceBytes(css), after: Buffer.byteLength(out) };
  }
  writeFileSync(htmlFile, html);

  // The source files that are now in the bundles are not needed on the TV.
  for (const f of used) rmSync(f, { force: true });
  for (const d of ['js', 'lib', 'img']) removeEmptyDirs(join(dir, d));
  return sizes;
}

function removeEmptyDirs(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const e of readdirSync(dir)) removeEmptyDirs(join(dir, e));
  if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
}
