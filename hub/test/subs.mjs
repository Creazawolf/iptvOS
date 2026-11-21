#!/usr/bin/env node
// Test of the stream proxy and subtitle extraction (hub/lib/stream.mjs, mkvsubs.mjs).
//   node hub/test/subs.mjs
// Builds a small .mkv with ffmpeg (skipped if ffmpeg is missing), reads out the text tracks in different ways
// and runs a mock provider (redirect + Range) behind the proxy.
import { spawnSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MkvFile, MkvSubParser, cueText } from '../lib/mkvsubs.mjs';
import { Streams } from '../lib/stream.mjs';

let failed = 0;
let passed = 0;
function ok(name, cond, detail) {
  if (cond) passed++; else failed++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n  Subtitles from the stream\n');

// --- Text parsing (without a file)
ok('ASS: the whole cue, including the text before the first comma', cueText('ass', '12,0,Default,,0,0,0,,And also in the box,\\Nwe have a vial of poison,\\n') === 'And also in the box,\nwe have a vial of poison,');
ok('ASS: a cue without a comma', cueText('ass', '3,0,Default,,0,0,0,,You have a cat in a sealed box.\\n') === 'You have a cat in a sealed box.');
ok('ASS: style codes are removed, drawing commands give no text', cueText('ass', '1,0,D,,0,0,0,,{\\an8\\i1}Hej{\\i0} du') === 'Hej du' && cueText('ass', '1,0,D,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}') === '');
ok('SRT: tags are removed', cueText('srt', '<i>Hej</i>\n<font color="#fff">du</font>') === 'Hej\ndu');

if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.log('\n  (ffmpeg is missing – the file tests are skipped)\n');
  console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`);
  process.exit(failed ? 1 : 0);
}

const dir = mkdtempSync(join(tmpdir(), 'g3subs-'));
const servers = [];
try {
  // --- A test file: 40 s of video + audio, Swedish SRT and English ASS (in the format the TV cannot handle)
  const srt = [[2, 4, 'Ni har en katt i en förseglad låda.'], [5, 8, 'I lådan har vi också en flaska gift,'], [12, 15, 'en enda radioaktiv atom\noch en geigermätare.'], [28, 31, 'Slutet är nära.'], [36, 38, 'Hej då.']];
  const f = (t) => `00:00:${String(Math.floor(t)).padStart(2, '0')},${String(Math.round((t % 1) * 1000)).padStart(3, '0')}`;
  writeFileSync(join(dir, 'sv.srt'), srt.map((c, i) => `${i + 1}\n${f(c[0])} --> ${f(c[1])}\n${c[2]}\n`).join('\n'));
  const a = (t) => `0:00:${String(Math.floor(t)).padStart(2, '0')}.${String(Math.round((t % 1) * 100)).padStart(2, '0')}`;
  const ass = [[2, 4, 'You have a cat in a sealed box.\\n'], [5, 8, 'And also in the box,\\Nwe have a vial of poison,\\n'], [12, 15, '{\\an8}a single radioactive atom and…\\n'], [28, 31, 'The end is near.\\n']];
  writeFileSync(join(dir, 'en.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 3840\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,80,&H00ffffff,&H00000000,&H00808080,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    ass.map((c) => `Dialogue: 0,${a(c[0])},${a(c[1])},Default,,0,0,0,,${c[2]}`).join('\n') + '\n');
  const mkv = join(dir, 'film.mkv');
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=40:s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=d=40:f=440',
    '-i', join(dir, 'sv.srt'), '-i', join(dir, 'en.ass'), '-map', '0', '-map', '1', '-map', '2', '-map', '3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '1500k', '-g', '25', '-c:a', 'aac', '-c:s:0', 'srt', '-c:s:1', 'ass',
    '-metadata:s:s:0', 'language=swe', '-metadata:s:s:0', 'title=Svenska', '-metadata:s:s:1', 'language=eng', '-disposition:s:0', 'default', mkv], { encoding: 'utf8' });
  if (ff.status !== 0) throw new Error('ffmpeg: ' + ff.stderr.slice(0, 300));
  const bytes = readFileSync(mkv);
  const size = bytes.length;

  // --- The whole file in arbitrarily sized chunks
  const texts = (file, i) => file.cuesOf(i).map((c) => c[2]);
  for (const chunk of [65536, 1, 7919]) {
    const file = new MkvFile();
    const p = new MkvSubParser(file, 0);
    if (chunk === 1) { for (let i = 0; i < Math.min(size, 400000); i++) p.push(bytes.subarray(i, i + 1)); p.push(bytes.subarray(Math.min(size, 400000))); }
    else for (let i = 0; i < size; i += chunk) p.push(bytes.subarray(i, i + chunk));
    const sv = file.cuesOf(0);
    const good = file.tracks.length === 2 && file.tracks[0].codec === 'srt' && file.tracks[0].lang === 'swe' && file.tracks[1].codec === 'ass' && file.tracks[1].text &&
      sv.length === srt.length && sv.every((c, i) => Math.abs(c[0] - srt[i][0]) < 0.05 && Math.abs(c[1] - srt[i][1]) < 0.05 && c[2] === srt[i][2]) &&
      JSON.stringify(texts(file, 1)) === JSON.stringify(['You have a cat in a sealed box.', 'And also in the box,\nwe have a vial of poison,', 'a single radioactive atom and…', 'The end is near.']);
    ok(`whole file in ${chunk}-byte chunks: two tracks and all cues`, good, good ? '' : JSON.stringify({ tracks: file.publicTracks(), sv, en: file.cuesOf(1) }).slice(0, 400));
  }

  // --- Start mid-file (as after a seek): the tracks already known, find the next cluster
  {
    const file = new MkvFile();
    const head = new MkvSubParser(file, 0, { headerOnly: true });
    head.push(bytes.subarray(0, 200000));
    const mid = Math.floor(size * 0.55) + 13; // not on an element boundary
    const p = new MkvSubParser(file, mid);
    for (let i = mid; i < size; i += 4096) p.push(bytes.subarray(i, i + 4096));
    const got = texts(file, 0);
    ok('only the start of the file: the tracks without reading the clusters', file.header && file.tracks.length === 2 && head.done);
    ok('mid-file: cues after that point, none before', got.includes('Hej då.') && got.includes('Slutet är nära.') && !got.includes('Ni har en katt i en förseglad låda.'), got.join(' | '));
  }

  // --- The proxy against a mock provider: the panel redirects to a file server with Range support
  let upstreamOpen = 0;
  let upstreamMax = 0;
  let panelHits = 0;
  const cdn = http.createServer((req, res) => {
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': 0 }).end(); return; } // like the provider's file server
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const s = m ? Number(m[1]) : 0;
    const e = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    upstreamOpen++;
    upstreamMax = Math.max(upstreamMax, upstreamOpen);
    res.on('close', () => { upstreamOpen--; });
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': e - s + 1, ...(m ? { 'Content-Range': `bytes ${s}-${e}/${size}` } : {}) });
    createReadStream(mkv, { start: s, end: e, highWaterMark: 16384 }).pipe(res);
  });
  await new Promise((r) => cdn.listen(0, '127.0.0.1', r));
  const panel = http.createServer((req, res) => { panelHits++; res.writeHead(302, { Location: `http://127.0.0.1:${cdn.address().port}/f/film.mkv` }).end(); });
  await new Promise((r) => panel.listen(0, '127.0.0.1', r));
  const src = `http://127.0.0.1:${panel.address().port}/movie/u/p/1.mkv`;
  const streams = new Streams({ allowedHosts: () => new Set([`127.0.0.1:${panel.address().port}`]) });
  const hub = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    streams.handle(req, res, url.searchParams.get('u') || '').catch((e) => { if (!res.headersSent) res.writeHead(e.status || 500).end(e.message); });
  });
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  servers.push(cdn, panel, hub);
  const via = `http://127.0.0.1:${hub.address().port}/api/stream?u=${encodeURIComponent(src)}`;

  let r = await fetch(via, { method: 'HEAD' });
  ok('HEAD: the file size and Accept-Ranges', r.status === 200 && Number(r.headers.get('content-length')) === size && r.headers.get('accept-ranges') === 'bytes' && /matroska/.test(r.headers.get('content-type')));

  r = await fetch(via, { headers: { Range: 'bytes=0-' } });
  const all = Buffer.from(await r.arrayBuffer());
  ok('whole file via the proxy: the same bytes, 206 and Content-Range', r.status === 206 && all.equals(bytes) && r.headers.get('content-range') === `bytes 0-${size - 1}/${size}`);
  let s = streams.subs(src, 0, 0);
  ok('the hub has the subtitles once the file has passed through', s.known && s.tracks.length === 2 && s.tracks[0].name === 'Svenska' && s.cues.length === srt.length && s.next === srt.length, JSON.stringify(s.tracks));
  ok('after: only new cues', streams.subs(src, 0, 3).cues.length === srt.length - 3 && streams.subs(src, 1, 0).cues[1][2] === 'And also in the box,\nwe have a vial of poison,');
  ok('the redirect is remembered: the panel got only one more request', panelHits <= 3, panelHits + ' requests');

  const midAt = Math.floor(size * 0.6);
  r = await fetch(via, { headers: { Range: `bytes=${midAt}-${midAt + 9999}` } });
  const part = Buffer.from(await r.arrayBuffer());
  ok('byte range mid-file: the right bytes', r.status === 206 && part.equals(bytes.subarray(midAt, midAt + 10000)));

  // A new hub (as after a restart) and the TV starts mid-file: the start is fetched first, one request at a time.
  const fresh = new Streams({ allowedHosts: () => new Set([`127.0.0.1:${panel.address().port}`]) });
  const hub2 = http.createServer((req, res) => { fresh.handle(req, res, new URL(req.url, 'http://x').searchParams.get('u') || '').catch(() => res.destroy()); });
  await new Promise((r2) => hub2.listen(0, '127.0.0.1', r2));
  servers.push(hub2);
  upstreamMax = 0;
  r = await fetch(`http://127.0.0.1:${hub2.address().port}/api/stream?u=${encodeURIComponent(src)}`, { headers: { Range: `bytes=${Math.floor(size * 0.5)}-` } });
  await r.arrayBuffer();
  s = fresh.subs(src, 0, 0);
  ok('start mid-file without a known start: the tracks are read first, then cues', s.known && s.tracks.length === 2 && s.cues.some((c) => c[2] === 'Hej då.'), JSON.stringify(s.cues.map((c) => c[2])));
  ok('never two simultaneous requests to the provider', upstreamMax === 1, 'max ' + upstreamMax);

  // The TV disconnects (seek): the request to the provider should be aborted too.
  const ac = new AbortController();
  const big = await fetch(via, { headers: { Range: 'bytes=0-' }, signal: ac.signal });
  const reader = big.body.getReader();
  await reader.read();
  ac.abort();
  await sleep(400);
  ok('aborted by the TV: the connection to the provider is closed', upstreamOpen === 0, upstreamOpen + ' open');

  r = await fetch(`http://127.0.0.1:${hub.address().port}/api/stream?u=${encodeURIComponent('http://192.168.1.1/x.mkv')}`);
  ok('a URL outside the playlists is rejected', r.status === 403);
} catch (e) {
  failed++;
  console.error('\n  ✗ ' + (e.stack || e.message));
} finally {
  for (const sv of servers) sv.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`);
process.exit(failed ? 1 : 0);
