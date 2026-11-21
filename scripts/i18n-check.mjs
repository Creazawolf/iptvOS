#!/usr/bin/env node
// Checks the translations:  npm run i18n:check   (part of npm test)
//
//  - every literal key in tr('…') / I18n.t('…') exists in every language
//  - all languages have the same keys, the same plural forms and the same {placeholders}
//
//   --extra a.json,b.json   also merge dictionary fragments { "en": {…}, "sv": {…} } (for work in progress)
//   --unused                list keys that no literal tr('…') refers to (dynamic keys show up here too)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const EXTRA = (arg('--extra') || '').split(',').filter(Boolean);
const UNUSED = process.argv.includes('--unused');

// Each target: where the dictionaries are, which code uses them.
const TARGETS = [
  { name: 'launcher', dicts: 'apps/launcher/js/i18n', src: ['apps/launcher/js', 'shared'], skip: ['apps/launcher/js/i18n'] },
  { name: 'hub web', dicts: 'hub/web/i18n', src: ['hub/web'], skip: ['hub/web/i18n'] },
  // The hub also stores messages and throws errors with a key: msg('…'), new LocalError('…'), new HttpError(404, '…').
  { name: 'hub server', dicts: 'hub/lib/locales', src: ['hub/lib', 'hub/server.mjs'], skip: ['hub/lib/locales'], calls: String.raw`msg\(|LocalError\(|HttpError\(\s*\d+\s*,` }
];

const isGroup = (x) => x && typeof x === 'object' && !Array.isArray(x) && !('other' in x);

function merge(into, from) {
  for (const k of Object.keys(from)) {
    if (isGroup(into[k]) && isGroup(from[k])) merge(into[k], from[k]);
    else into[k] = from[k];
  }
  return into;
}

function leaves(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (isGroup(v)) leaves(v, key, out);
    else out.set(key, v);
  }
  return out;
}

async function loadDicts(dir) {
  const dicts = {};
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return null;
  for (const f of readdirSync(abs).sort()) {
    const ext = extname(f);
    if (!['.js', '.mjs', '.json'].includes(ext)) continue;
    const file = join(abs, f);
    const text = readFileSync(file, 'utf8');
    if (ext === '.json') { dicts[basename(f, ext)] = merge(dicts[basename(f, ext)] || {}, JSON.parse(text)); continue; }
    if (/\bexport\s+default\b/.test(text)) {
      const mod = await import(pathToFileURL(file).href);
      dicts[basename(f, ext)] = merge(dicts[basename(f, ext)] || {}, mod.default);
      continue;
    }
    const sandbox = { I18n: { add: (id, d) => { dicts[id] = merge(dicts[id] || {}, d); } } };
    sandbox.window = sandbox;
    vm.runInNewContext(text, sandbox, { filename: file });
  }
  return dicts;
}

function walk(p, skip, out = []) {
  const abs = join(ROOT, p);
  if (!existsSync(abs) || skip.some((s) => abs.startsWith(join(ROOT, s)))) return out;
  if (statSync(abs).isDirectory()) {
    for (const f of readdirSync(abs)) walk(join(p, f), skip, out);
  } else if (/\.(m?js|html)$/.test(abs)) out.push(abs);
  return out;
}

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const forms = (v) => (typeof v === 'object' ? Object.keys(v).sort().join(',') : 'text');

let errors = 0;
const fail = (msg) => { errors++; console.log('  ✗ ' + msg); };

for (const t of TARGETS) {
  const dicts = await loadDicts(t.dicts);
  if (!dicts) continue;
  if (t.name === 'launcher') {
    for (const f of EXTRA) {
      const frag = JSON.parse(readFileSync(f, 'utf8'));
      for (const [id, d] of Object.entries(frag)) dicts[id] = merge(dicts[id] || {}, d);
    }
  }
  const langs = Object.keys(dicts);
  console.log(`\n  ${t.name}: ${langs.join(', ')}`);
  if (!dicts.en) { fail(`${t.name}: en is missing`); continue; }
  const ref = leaves(dicts.en);

  // Same keys, forms and placeholders in every language.
  for (const id of langs) {
    if (id === 'en') continue;
    const other = leaves(dicts[id]);
    for (const [k, v] of ref) {
      if (!other.has(k)) { fail(`${id}: missing ${k}`); continue; }
      const o = other.get(k);
      if (forms(v) !== forms(o)) fail(`${id}: ${k} has forms [${forms(o)}], en has [${forms(v)}]`);
      const pv = typeof v === 'object' ? Object.values(v).map(placeholders).join('|') : placeholders(v);
      const po = typeof o === 'object' ? Object.values(o).map(placeholders).join('|') : placeholders(o);
      const norm = (s) => [...new Set(s.split(/[|,]/).filter(Boolean))].sort().join(',');
      if (norm(pv) !== norm(po)) fail(`${id}: ${k} placeholders {${norm(po)}} ≠ en {${norm(pv)}}`);
    }
    for (const k of other.keys()) if (!ref.has(k)) fail(`${id}: ${k} is not in en`);
  }

  // Every literal key in the code exists.
  const used = new Set();
  let dynamic = 0;
  const re = t.calls
    ? new RegExp(String.raw`\b(?:tr\(|I18n\.t\(|${t.calls})\s*(?:'([^'\\]+)'|"([^"\\]+)"|` + '`([^`$\\\\]+)`' + String.raw`|([^)\s,]))`, 'g')
    : /\b(?:tr|I18n\.t)\(\s*(?:'([^'\\]+)'|"([^"\\]+)"|`([^`$\\]+)`|([^)\s,]))/g;
  for (const file of t.src.flatMap((s) => walk(s, t.skip))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      if (/^\s*(\*|\/\/|\/\*)/.test(text.slice(lineStart, m.index))) continue; // comment
      const key = m[1] || m[2] || m[3];
      if (!key) { dynamic++; continue; }
      used.add(key);
      if (!ref.has(key)) {
        const line = text.slice(0, m.index).split('\n').length;
        fail(`${relative(ROOT, file)}:${line} unknown key '${key}'`);
      }
    }
  }
  console.log(`  ${ref.size} keys, ${used.size} used literally, ${dynamic} dynamic tr() calls`);
  if (UNUSED) for (const k of ref.keys()) if (!used.has(k)) console.log('    unused? ' + k);
}

console.log(errors ? `\n  ${errors} errors\n` : '\n  Translations are complete.\n');
process.exit(errors ? 1 : 0);
