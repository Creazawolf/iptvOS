#!/usr/bin/env node
// Create a new app from the template:  npm run new -- <folder-name> ["Title"]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPS, ROOT } from './lib.mjs';

const [rawName, rawTitle] = process.argv.slice(2);
if (!rawName) {
  console.log('\n  Usage:    npm run new -- <folder-name> ["Title"]');
  console.log('  Example:  npm run new -- bus-times "Bus times"\n');
  process.exit(1);
}

const slug = rawName
  .toLowerCase()
  .replace(/[åä]/g, 'a')
  .replace(/ö/g, 'o')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
if (!slug) {
  console.error('✗ Invalid folder name.');
  process.exit(1);
}

const title = rawTitle || rawName;
const id = `com.g3custom.${slug}`;
const dir = join(APPS, slug);

if (existsSync(dir)) {
  console.error(`✗ apps/${slug} already exists.`);
  process.exit(1);
}

cpSync(join(APPS, '_template'), dir, { recursive: true });

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
for (const file of ['appinfo.json', 'index.html']) {
  const path = join(dir, file);
  const isJson = file.endsWith('.json');
  const t = isJson ? JSON.stringify(title).slice(1, -1) : escapeHtml(title);
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replaceAll('__ID__', id).replaceAll('__TITLE__', t).replaceAll('__SLUG__', slug)
  );
}

// Simple icon with the first letter – feel free to replace icon.svg and run  npm run icons -- <app>
const letter = escapeHtml(title.trim().charAt(0).toUpperCase() || '?');
writeFileSync(
  join(dir, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 130 130">
  <rect width="130" height="130" fill="#0b0907"/>
  <circle cx="65" cy="65" r="44" fill="#ffad66"/>
  <text x="65" y="65" dy=".35em" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-size="54" font-weight="600" fill="#15110c">${letter}</text>
</svg>
`
);
spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-icons.mjs'), slug], { stdio: 'inherit' });

console.log(`
  ✓ Created apps/${slug}  (${id})

    npm run dev -- ${slug}        preview in the browser
    npm run deploy -- ${slug}     install on the TV
`);
