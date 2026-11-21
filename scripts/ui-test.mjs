#!/usr/bin/env node
// UI test of the launcher in a local headless Chrome (the same engine as the TV, Chromium).
//   npm run test:ui              the source files (like npm run dev)
//   npm run test:ui -- --build   the package that gets installed on the TV (bundled, lazy loading)
// Starts its own dev server with a demo hub (never touches the hub in config.local.js) and presses
// the "remote" via the DevTools protocol. Prints the Perf report (js/core/perf.js) at the end.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { connect, launchChrome, targets } from './cdp.mjs';
import { ROOT } from './lib.mjs';

const BUILD = process.argv.includes('--build');
const LANG = process.argv.includes('--lang') ? process.argv[process.argv.indexOf('--lang') + 1] : 'sv';
// Text the test looks for in the UI (the launcher's own strings and the hub's collection names).
const TXT = {
  sv: { aspect: 'Bildformat', shortcutKey: 'Knapp för Skärm av', earth: 'Jorden från ovan', nature: 'Natur och landskap', glass: 'Glas', pics: (n) => n + ' bilder' },
  en: { aspect: 'Aspect ratio', shortcutKey: 'Screen off button', earth: 'Earth from above', nature: 'Nature and landscapes', glass: 'Glass', pics: (n) => n + ' pictures' }
}[LANG];
const PORT = BUILD ? 8193 : 8191;
const HUB = PORT + 707;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
let passed = 0;
function ok(name, cond, detail) {
  if (cond) passed++; else failed++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
}

const KEYS = {
  left: ['ArrowLeft', 37], right: ['ArrowRight', 39], up: ['ArrowUp', 38], down: ['ArrowDown', 40],
  enter: ['Enter', 13], back: ['Escape', 27], red: ['KeyR', 82], green: ['KeyG', 71], blue: ['KeyB', 66], yellow: ['KeyY', 89]
};

async function waitFor(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* the page is loading */ }
    await sleep(150);
  }
  return false;
}

console.log(`\n  UI test (${BUILD ? 'bundle' : 'source files'}, ${LANG}) at http://localhost:${PORT}\n`);
const server = spawn(process.execPath, [join(ROOT, 'scripts', 'dev.mjs'), '--port', String(PORT), '--demo-wallpapers'].concat(BUILD ? ['--build'] : []), { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (c) => { log += c; });
server.stderr.on('data', (c) => { log += c; });
const chrome = await launchChrome({ port: 20000 + Math.floor(Math.random() * 20000) });
let page = null;

try {
  if (!(await waitFor(async () => (await fetch(`http://localhost:${HUB}/api/health`)).ok, 30000))) throw new Error('the dev server/hub did not start');
  // Wait until the demo hub has its catalogue.
  await waitFor(async () => (await (await fetch(`http://localhost:${HUB}/api/tv/bootstrap`)).json()).live.favorites.length > 0, 30000);

  const t = (await targets(chrome.base)).find((x) => x.type === 'page');
  page = await connect(t.webSocketDebuggerUrl);
  const errors = [];
  page.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text));
  page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') errors.push(p.args.map((a) => a.value || a.description).join(' ')); });
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const settings = { version: 3, i18n: 1, language: LANG, iptv: { mode: 'hub', hub: { url: `http://localhost:${HUB}`, token: '' } } };
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `if (!sessionStorage.getItem('g3test')) { sessionStorage.setItem('g3test', '1'); localStorage.clear(); localStorage.setItem('g3:settings:v1', ${JSON.stringify(JSON.stringify(settings))}); }
      window.__full = 0; window.__part = 0;
      document.addEventListener('DOMContentLoaded', () => {
        const pg = document.getElementById('home-page');
        new MutationObserver((m) => { if (m.some((x) => x.target === pg)) __full++; else if (m.some((x) => x.target.parentElement === pg)) __part++; }).observe(pg, { childList: true, subtree: true });
      });`
  });
  await page.send('Page.navigate', { url: `http://localhost:${PORT}/` });
  const ev = (x) => page.eval(x);
  const press = async (name, wait = 150) => { const k = KEYS[name]; await page.key(k[0], k[0], k[1]); await sleep(wait); };

  // --- Startup and home screen
  ok('the home screen is shown', await waitFor(() => ev(`document.querySelectorAll('#home-page [data-focusable]').length > 5`)));
  ok('IPTV loaded (favourites)', await waitFor(() => ev('IPTV.favorites().length > 0')));
  if (BUILD) ok('bundle: one script, the TV view loads later', (await ev('document.scripts.length')) <= 3 && !(await ev('!!IPTV.ui && performance.now() < 1400')));
  await sleep(2500);
  await ev(`__full = 0; __part = 0; document.dispatchEvent(new Event('visibilitychange'))`);
  await sleep(1500);
  ok('returning without changes does not rebuild the home screen', (await ev('__full + __part')) === 0);

  // --- Navigation
  const focusId = () => ev(`(Nav.current() && Nav.current().getAttribute('data-id')) || ''`);
  const f0 = await focusId();
  await press('right');
  const f1 = await focusId();
  await press('down', 400);
  const mode = await ev(`document.querySelector('.view-home').getAttribute('data-mode')`);
  await press('back', 400);
  ok('◀▶▲▼ on the home screen', f0 && f1 && f0 !== f1 && mode === 'grid' && (await ev(`document.querySelector('.view-home').getAttribute('data-mode')`)) === 'shelf');

  // --- Live, fullscreen, zapping
  await ev(`IPTV.open({ tab: 'live' })`);
  ok('the TV view opens', await waitFor(() => ev(`(Router.top() || {}).name === 'tv' && !!document.querySelector('.tv-row')`)));

  // --- Tab row: the cursor does not switch tabs, OK does
  await sleep(500); // the TV view focuses the tab row itself on the next frame
  await ev('IPTV.ui.focusTabs()');
  await press('right', 600);
  ok('tab row: ◀▶ only moves the cursor', (await ev('IPTV.ui.tab()')) === 'live' && (await ev(`Nav.current().getAttribute('data-tab')`)) === 'guide',
    await ev(`IPTV.ui.tab() + ' / ' + Nav.current().className + ' ' + Nav.current().getAttribute('data-tab')`));
  await press('enter', 600);
  ok('tab row: OK switches tab', (await ev('IPTV.ui.tab()')) === 'guide');
  await ev(`IPTV.ui.setTab('live')`);
  await sleep(300);

  await waitFor(async () => {
    await ev('IPTV.ui.enterTab()');
    return ev(`!!(Nav.current() && Nav.current().classList.contains('tv-row'))`);
  });
  // --- Channel list: nothing plays until OK; OK = the pane, OK again = fullscreen
  await sleep(1600);
  ok('channel list: browsing does not start a channel', (await ev('IPTV.player.state()')) === 'stopped');
  await press('enter', 400);
  ok('channel list: OK plays the channel in the preview pane', await waitFor(() => ev(`IPTV.player.state() === 'playing' && IPTV.player.mode() === 'pane' && !IPTV.full.visible`), 8000));
  const paneCh = await ev('IPTV.player.current().id');
  await press('down', 1500);
  ok('channel list: the cursor on another channel does not switch', (await ev('IPTV.player.current().id')) === paneCh &&
    !(await ev(`document.querySelector('.tv-pane-playing').hidden`)), await ev(`document.querySelector('.tv-pane-playing').textContent`));
  await press('up', 300);
  await press('enter', 1200);
  const playing = await waitFor(() => ev(`IPTV.player.state() === 'playing' && IPTV.full.visible`));
  ok('fullscreen plays', playing, playing ? '' : await ev(`JSON.stringify({ state: IPTV.player.state(), mode: IPTV.player.mode(), cur: !!IPTV.player.current(), screen: document.querySelector('.view-tv').getAttribute('data-screen'), focus: Nav.current() && Nav.current().className, src: IPTV.player.video.getAttribute('src') })`));
  if (!playing) throw new Error('fullscreen did not start');
  const first = await ev('IPTV.player.current().id');
  await ev(`window.__src = 0; { const v = IPTV.player.video; const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src'); Object.defineProperty(v, 'src', { set(x) { __src++; d.set.call(this, x); }, get() { return d.get.call(this); }, configurable: true }); }`);
  for (let i = 0; i < 4; i++) await press('up', 60);
  await sleep(900);
  ok('▲ held down: only the first and last channels start', (await ev('__src')) === 2, `${await ev('__src')} streams`);
  await press('blue', 900);
  ok('blue = previous channel', (await ev('IPTV.player.current().id')) !== first);
  await press('red', 400);
  ok('red = Options', (await ev(`[...document.querySelectorAll('#overlays .layer.is-on .btn')].map((b) => b.textContent).join('|')`)).includes(TXT.aspect));
  await press('down');
  ok('a menu over fullscreen takes the arrow keys', (await ev(`!!document.querySelector('#overlays .layer.is-on .btn.is-focused:not([data-autofocus])')`)));
  await press('back', 400);

  // --- ▲▼ with "OK switches": browse without switching
  await ev(`Store.set('iptv.nav.zap', 'confirm')`);
  const before = await ev('IPTV.player.current().id');
  await press('up', 500);
  ok('▲ with OK to confirm: shows the channel without switching', (await ev('IPTV.player.current().id')) === before && (await ev(`document.querySelector('.tv-banner').classList.contains('is-browse')`)));
  await press('enter', 1200);
  ok('OK switches to the browsed channel', (await ev('IPTV.player.current().id')) !== before && !(await ev('IPTV.live.browsing()')));
  await press('down', 400);
  await press('back', 400);
  ok('Back cancels browsing (fullscreen stays)', (await ev('IPTV.full.visible')) && !(await ev('IPTV.live.browsing()')));
  await ev(`Store.set('iptv.nav.zap', 'direct')`);
  await press('back', 600);
  ok('Back from fullscreen: the channel keeps playing in the pane', (await ev(`IPTV.player.mode()`)) === 'pane' && !(await ev('IPTV.full.visible')));

  // --- The gear: the TV app's settings, Back leads home to the TV app again
  await ev(`Nav.focus(document.querySelector('.tv-tab-gear'), { force: true })`);
  await press('enter', 600);
  ok('the gear opens the IPTV settings', (await ev(`(Router.top() || {}).name`)) === 'settings' && (await ev(`document.querySelector('.set-title').textContent`)) === 'IPTV');
  await press('enter', 400);
  await press('down', 200);
  await press('back', 400);
  await press('back', 600);
  ok('Back from the settings: the TV app', (await ev(`(Router.top() || {}).name`)) === 'tv');

  // --- Started from the home screen: Back goes to the TV app, not to the home screen
  await ev('Router.home()');
  await sleep(400);
  await ev(`IPTV.open({ tab: 'live', channel: IPTV.favorites()[0], fullscreen: true })`);
  ok('channel from the home screen: fullscreen', await waitFor(() => ev('IPTV.full.visible'), 8000));
  await sleep(600);
  await press('back', 800);
  ok('Back from it: the channel list in the TV app', (await ev(`(Router.top() || {}).name`)) === 'tv' && !(await ev('IPTV.full.visible')) &&
    (await ev(`!!(Nav.current() && Nav.current().classList.contains('tv-row'))`)));
  await ev(`Store.set('iptv.nav.back', 'home')`);
  await ev('Router.home()');
  await sleep(400);
  await ev(`IPTV.open({ tab: 'live', channel: IPTV.favorites()[0], fullscreen: true })`);
  await waitFor(() => ev('IPTV.full.visible'), 8000);
  await sleep(600);
  await press('back', 800);
  ok('with "straight to the home screen": the home screen', (await ev(`(Router.top() || {}).name`)) === 'home');
  await ev(`Store.set('iptv.nav.back', 'app')`);
  await ev(`IPTV.open({ tab: 'live' })`);
  await sleep(500);

  // --- Guide: catch-up and reminder
  await ev(`IPTV.ui.setTab('guide')`);
  await sleep(400);
  await ev('IPTV.ui.enterTab()');
  await waitFor(() => ev(`!!document.querySelector('.gd-prog.is-cursor')`));
  for (let i = 0; i < 3; i++) await press('left', 200);
  const past = await ev(`document.querySelector('.gd-prog.is-cursor').className`);
  ok('guide: a past programme with catch-up is marked', /is-catchup/.test(past), past.replace('gd-prog ', ''));
  await press('enter', 2500);
  ok('catch-up plays in the movie player', (await ev(`document.querySelector('.view-tv').getAttribute('data-screen')`)) === 'vod' && /timeshift/.test(await ev('IPTV.player.video.getAttribute("src") || ""')));
  // Back (the first press hides the player controls, the second closes the player).
  await waitFor(async () => {
    await press('back', 400);
    return !(await ev(`document.querySelector('.view-tv').getAttribute('data-screen')`));
  }, 5000);
  for (let i = 0; i < 6; i++) await press('right', 150);
  await press('enter', 500);
  ok('a reminder is set on an upcoming programme', (await ev(`(Store.get('iptv.reminders') || []).length`)) === 1);

  // --- Search: programmes
  await ev(`IPTV.ui.setTab('search')`);
  await ev(`IPTV.search.set('rapport')`);
  ok('search finds programmes in the guide', await waitFor(() => ev(`!!document.querySelector('.sr-shelf.is-epg .sr-prog')`), 8000));

  // --- Movies
  await ev(`IPTV.ui.setTab('movies')`);
  ok('movies: shelves', await waitFor(() => ev(`document.querySelectorAll('[data-pane=movies] .md-shelf .poster[data-id]').length > 5`)));

  // --- Continue watching from the home screen: Back stays in the TV app (the details page, then Movies)
  const movie = JSON.parse(await ev(`IPTV.source.vodList({ category: 'recent', limit: 1 }).then((r) => JSON.stringify(r.items[0] || null))`));
  if (movie) {
    await ev('Router.home()');
    await sleep(400);
    await ev(`IPTV.openItem(${JSON.stringify({ id: movie.id, kind: 'vod', title: movie.title, poster: movie.poster, position: 20, duration: 600 })})`);
    ok('Continue watching: the movie starts', await waitFor(() => ev(`document.querySelector('.view-tv').getAttribute('data-screen') === 'vod'`), 10000));
    await waitFor(async () => {
      await press('back', 500);
      return (await ev(`document.querySelector('.view-tv').getAttribute('data-screen')`)) !== 'vod';
    }, 6000);
    await press('back', 700);
    ok('Back from there: the Movies tab in the TV app', (await ev(`(Router.top() || {}).name`)) === 'tv' && (await ev('IPTV.ui.tab()')) === 'movies' &&
      !(await ev(`document.querySelector('.view-tv').getAttribute('data-screen')`)), await ev(`(Router.top() || {}).name + ' ' + IPTV.ui.tab() + ' ' + document.querySelector('.view-tv').getAttribute('data-screen')`));
  }

  // --- The player as on the TV: mediaOption, track lists in "umsmediainfo", subtitles via video.send
  if (movie) {
    await ev(`TV.isTV = true; window.__sent = []; IPTV.player.video.send = (j) => { __sent.push(JSON.parse(j)); return true; };
      Store.set('player.subPref', 'swe'); Store.set('player.sub', { size: 4, position: 2 });`);
    await ev(`IPTV.openItem(${JSON.stringify({ id: movie.id, kind: 'vod', title: movie.title, poster: movie.poster, position: 0, duration: 600 })})`);
    const tvPlaying = await waitFor(() => ev(`document.querySelector('.view-tv').getAttribute('data-screen') === 'vod' && IPTV.player.state() === 'playing'`), 15000);
    const mode = await ev('IPTV.player.sourceMode()');
    ok('TV mode: the movie plays (with mediaOption, or without it if refused)', tvPlaying && (mode === 'option' || mode === 'plain'), 'source: ' + mode);
    await ev(`IPTV.player.video.dispatchEvent(new CustomEvent('umsmediainfo', { detail: JSON.stringify({ type: 'sourceInfo', mediaId: 'm1', info: { container: 'matroska', programInfo: [{
      audioTrackInfo: [{ language: 'eng', codec: 'eac3', channels: 6 }, { language: 'swe', codec: 'aac', channels: 2 }],
      subtitleTrackInfo: [{ language: 'eng' }, { language: 'swe' }, { language: 'fin' }],
      videoTrackInfo: { codec: 'hevc', width: 3840, height: 2160, hdrType: 'DolbyVision' } }] } }) }))`);
    await sleep(300);
    const tr = JSON.parse(await ev(`JSON.stringify({ t: IPTV.tracks.state(), sent: __sent })`));
    const cmd = (name) => tr.sent.filter((x) => x.command === name);
    ok('TV mode: the track list comes from the TV', tr.t.audio.length === 2 && tr.t.text.length === 3 && tr.t.source === 'webos', tr.t.audio.map((x) => x.name + ' ' + x.detail).join(', '));
    ok('TV mode: Swedish subtitles are chosen and turned on on the TV', tr.t.textSel === 1 && cmd('SetMediaSubtitleEnable').some((x) => x.parameter.enable === true) &&
      cmd('SetInternalSubtitle').some((x) => x.parameter.index === 1), JSON.stringify(tr.sent.map((x) => x.command)));
    ok('TV mode: subtitle size and position are sent (nearest step on the TV)', cmd('SetMediaSubtitleInfo').some((x) => x.parameter.fontSize === 2 && x.parameter.position >= 2));
    ok('TV mode: 4K and Dolby Vision are shown', tr.t.badges.includes('4K') && tr.t.badges.includes('Dolby Vision'), tr.t.badges.join(' · '));
    await press('green', 500);
    ok('audio and subtitles: three columns, including the subtitle style', (await ev(`document.querySelectorAll('.pb-panel .pb-col').length`)) === 3 &&
      (await ev(`!!document.querySelector('.pb-panel .pb-opt[data-type="style"]')`)));
    await ev(`Nav.focus(document.querySelector('.pb-panel .pb-opt[data-type="text"][data-i="-1"]'), { force: true })`);
    await press('enter', 400);
    ok('subtitles Off: turned off on the TV', (await ev('IPTV.tracks.state().textSel')) === -1 &&
      (await ev(`__sent.some((x) => x.command === 'SetMediaSubtitleEnable' && x.parameter.enable === false)`)));
    await ev(`TV.isTV = false; Store.set('player.subPref', 'last'); Store.set('player.subLang', ''); delete IPTV.player.video.send;`);
    await waitFor(async () => {
      await press('back', 500);
      return !(await ev(`document.querySelector('.view-tv').getAttribute('data-screen')`));
    }, 8000);
  }

  // --- The launcher's own subtitles: the file plays via the hub, which extracts the text from the stream
  if (movie && (await ev('!!(IPTV.boot().caps && IPTV.boot().caps.stream)'))) {
    const direct = await ev(`IPTV.source.vodInfo(${JSON.stringify(movie.id)}).then((i) => i.url)`);
    const mkv = direct.replace(/\.\w+$/, '.mkv');
    const sourceInfo = `IPTV.player.video.dispatchEvent(new CustomEvent('umsmediainfo', { detail: JSON.stringify({ type: 'sourceInfo', mediaId: 'm2', info: { programInfo: [{
      audioTrackInfo: [{ language: 'en', codec: 'aac', channels: 2 }], subtitleTrackInfo: [{ language: 'sv', type: 'text' }, { language: 'en', type: 'text' }] }] } }) }))`;
    const play = `IPTV.playback.play(${JSON.stringify({ id: movie.id, kind: 'vod', url: mkv, title: 'Undertexttest', duration: 180 })}, { start: 0 })`;
    const shown = () => ev(`document.querySelector('.subs-text').textContent`);
    await ev(`IPTV.open({ tab: 'movies' })`);
    await sleep(600);
    await ev(`TV.isTV = true; IPTV.player.video.send = () => true; Store.set('player.subPref', 'last'); Store.set('player.subLang', 'off'); Store.set('player.sub', { size: 3, position: 0 });`);
    await ev(play);
    const started = await waitFor(() => ev(`IPTV.player.kind() === 'vod' && IPTV.player.state() === 'playing'`), 15000);
    ok('mkv plays directly from the provider when no subtitles are preselected', started && !(await ev('IPTV.player.proxied()')), await ev('IPTV.player.video.currentSrc.slice(0, 60)'));
    await ev(sourceInfo);
    await sleep(200);
    await ev('IPTV.tracks.selectText(0, true)');
    const viaHub = await waitFor(() => ev(`IPTV.player.proxied() && IPTV.player.state() === 'playing' && IPTV.player.video.currentSrc.indexOf('/api/stream?u=') > 0`), 15000);
    ok('subtitle track chosen: the movie switches to the stream from the hub', viaHub, await ev(`JSON.stringify({ p: IPTV.player.proxied(), s: IPTV.player.state(), src: IPTV.player.video.currentSrc.slice(0, 70) })`));
    await ev(sourceInfo); // the TV sends the track list again once the stream has restarted
    ok('the hub delivers cues from the stream', await waitFor(() => ev('IPTV.subs.active() && IPTV.subs.debug().cues > 3'), 10000), await ev('JSON.stringify(IPTV.subs.debug())'));
    ok('the track list from the hub shows in the menu (SRT/ASS)', await waitFor(() => ev(`IPTV.tracks.state().text[0].detail === 'SRT' && IPTV.tracks.state().text[1].detail === 'ASS'`), 5000), await ev('JSON.stringify(IPTV.tracks.state().text)'));
    await ev('IPTV.player.seek(7)');
    ok('a Swedish two-line cue is shown', await waitFor(async () => (await shown()) === 'Replik 2 på svenska,\nmed en andra rad.', 8000), JSON.stringify(await shown()));
    await ev('IPTV.player.seek(3)');
    ok('a cue without a comma is shown', await waitFor(async () => (await shown()) === 'Replik 1 utan kommatecken', 8000), JSON.stringify(await shown()));
    await ev('IPTV.player.seek(20)');
    ok('no text is shown between two cues', await waitFor(async () => (await shown()) === '' && (await ev('IPTV.player.video.currentTime')) > 19.5, 8000), JSON.stringify(await shown()));
    await ev('IPTV.tracks.selectText(1, false)');
    await waitFor(() => ev('IPTV.subs.track() === 1 && IPTV.subs.debug().cues > 3'), 8000);
    await ev('IPTV.player.seek(7)');
    ok('ASS track: the whole cue, including the text before the comma', await waitFor(async () => (await shown()) === 'Line 2 in English,\nwith a second row.', 8000), JSON.stringify(await shown()));
    await ev('IPTV.tracks.setStyle({ size: 0 })');
    ok('smallest subtitle size: 28 px', (await ev(`getComputedStyle(document.querySelector('.subs-text')).fontSize`)) === '28px');
    await ev('IPTV.tracks.selectText(-1, true)');
    ok('subtitles Off: the text is hidden', (await ev(`document.querySelector('.subs').hidden`)) && !(await ev('IPTV.subs.active()')));
    // Next time, with subtitles preselected, the file plays via the hub from the start (no stream restart).
    await ev(`Store.set('player.subLang', 'sv'); Store.set('player.sub', { size: 3, position: 0 })`);
    await ev(play);
    await waitFor(() => ev(`IPTV.player.state() === 'playing'`), 15000);
    const direct2 = await ev('IPTV.player.proxied()');
    await ev(sourceInfo);
    ok('subtitles preselected: via the hub from the start, Swedish is chosen', direct2 && (await waitFor(() => ev('IPTV.subs.active() && IPTV.subs.track() === 0 && IPTV.tracks.state().textSel === 0'), 8000)));
    await ev(`IPTV.emit('proxy-failed', 'test')`);
    ok('error via the hub: own subtitles are turned off (the TV subtitles are used instead)', !(await ev('IPTV.subs.active()')) && !(await ev('IPTV.subs.usable()')));
    await ev(`TV.isTV = false; Store.set('player.subLang', ''); delete IPTV.player.video.send;`);
    await waitFor(async () => {
      await press('back', 500);
      return !(await ev(`document.querySelector('.view-tv').getAttribute('data-screen')`));
    }, 8000);
  }

  // --- Settings: Screen off and the shortcut button
  await ev(`Router.go('settings', { section: 'shortcuts' })`);
  ok('settings: Screen off and shortcuts', await waitFor(() => ev(`[...document.querySelectorAll('.set-list .row-label')].some((r) => r.textContent.indexOf(${JSON.stringify(TXT.shortcutKey)}) >= 0)`), 5000));
  ok('the Screen off and LG webOS tiles are among the apps', (await ev(`!!Apps.get('internal:screenoff') && !!Apps.get('internal:lghome') && Apps.dock().some((a) => a.id === 'internal:lghome')`)));
  await ev('Router.home()');

  // --- Wallpaper: collections from the hub, images via the image proxy
  await ev(`Router.go('settings', { section: 'wallpaper' })`);
  const rowText = (re) => ev(`(([...document.querySelectorAll('.set-list .row-label')].find((r) => ${re}.test(r.textContent)) || {}).textContent) || ''`);
  ok('wallpaper: the hub collections are listed with counts', await waitFor(async () => (await rowText(`/^${TXT.earth}/`)).includes(TXT.pics(3)), 6000) && (await rowText(`/^${TXT.nature}/`)).includes(TXT.pics(2)) && (await rowText(`/^${TXT.glass}/`)).indexOf(TXT.glass) === 0,
    await rowText(`/^${TXT.earth}/`));
  ok('wallpaper: the old choice applies until the user picks (Glass + Space)', (await ev('Wallpaper.sets().join()')) === 'glass,space');
  // The list can be redrawn while the hub's collections arrive: focus the row again until it sticks.
  await waitFor(async () => {
    await ev(`(() => { const r = [...document.querySelectorAll('.set-list .list-row')].find((x) => x.querySelector('.row-label').textContent.indexOf(${JSON.stringify(TXT.earth)}) === 0); if (r) Nav.focus(r, { force: true }); })()`);
    await sleep(200);
    return ev(`!!(Nav.current() && Nav.current().isConnected && (Nav.current().querySelector('.row-label') || {}).textContent && Nav.current().querySelector('.row-label').textContent.indexOf(${JSON.stringify(TXT.earth)}) === 0)`);
  }, 6000);
  await press('enter', 300);
  ok('wallpaper: OK on a collection turns it on', (await ev('Wallpaper.sets().join()')) === 'glass,space,earth', await ev('Wallpaper.sets().join()'));
  await ev(`Wallpaper.setSets(['earth'])`);
  const gotEarth = await waitFor(() => ev(`/^earth:/.test((Wallpaper.current() || {}).id || '')`), 8000);
  const layer = await ev(`(document.querySelector('.wallpaper .wp-layer.is-on') || { style: {} }).style.backgroundImage || ''`);
  ok('wallpaper: the image comes from the chosen collection, scaled down by the hub image proxy', gotEarth && layer.indexOf('/api/img?u=') > 0 && /[?&]w=1920/.test(layer),
    await ev(`JSON.stringify(Wallpaper.current())`) + ' ' + layer.slice(0, 90));
  ok('wallpaper: the location is shown as the caption', /^Demo.*, (Sverige|Chile|Kina)$/.test(await ev('Wallpaper.current().title')));
  const blurs = await ev(`Object.keys(JSON.parse(localStorage.getItem('g3:wpblur:v2') || '{}')).length`);
  ok('wallpaper: blurred thumbnails are saved (few and small)', blurs >= 1 && blurs <= 30, blurs + ' saved');

  // --- Idle with aerial videos: one video at a time in its own player, captions, any key ends it
  const hasVideo = await ev(`fetch('/__mock/vod/1.mp4', { method: 'HEAD' }).then((r) => r.ok, () => false)`);
  if (hasVideo) {
    await ev(`Store.set('ambient.mode', 'aerial'); Store.set('ambient.quality', 'hdr'); Idle.enter()`);
    const flying = await waitFor(() => ev(`Idle.aerial().on && document.getElementById('ambient').classList.contains('has-video') && !document.getElementById('ambient').classList.contains('is-veiled')`), 12000);
    ok('idle: an aerial video plays', flying, await ev('JSON.stringify(Idle.aerial())'));
    ok('idle: if the chosen quality is missing, the next lower one is used (4K HDR → 4K)', /(\/__mock\/vod\/\d\.mp4|sylvan\.apple\.com%2Fdemo%2F1\.mov)$/.test(await ev(`document.getElementById('ambient-video').getAttribute('src') || ''`)));
    ok('idle: only chosen sources (Amazon is off)', (await ev('Idle.aerial().playing.source')) !== 'amazon' && (await ev('Idle.aerial().list')) === 3);
    ok('idle: Apple videos play via the hub, others directly', (await ev(`Idle.aerial().viaHub === (Idle.aerial().playing.source === 'apple')`)), await ev('JSON.stringify(Idle.aerial())'));
    ok('idle: the video name and caption are shown', /^Demoflygning \d$/.test(await ev(`document.getElementById('ambient-place').textContent`)) &&
      (await ev(`document.getElementById('ambient-poi').textContent`)) === 'Start över demokusten', await ev(`document.getElementById('ambient-place').textContent + ' / ' + document.getElementById('ambient-poi').textContent`));
    ok('idle: the video is muted and the TV player untouched', (await ev(`document.getElementById('ambient-video').muted`)) === true && (await ev('IPTV.player.state()')) === 'stopped');
    await ev(`document.getElementById('ambient-video').currentTime = 6`);
    ok('idle: the caption follows the video', await waitFor(() => ev(`document.getElementById('ambient-poi').textContent === 'Vidare mot demobergen'`), 5000));
    const where = await ev(`(Router.top() || {}).name + ':' + document.querySelector('.set-title').textContent`);
    await press('enter', 500);
    ok('idle: the first key press only wakes the screen and releases the video', !(await ev('Idle.isActive()')) && !(await ev('Idle.aerial().on')) && !(await ev(`document.getElementById('ambient-video').getAttribute('src')`)) &&
      (await ev(`(Router.top() || {}).name + ':' + document.querySelector('.set-title').textContent`)) === where);
    // A video "hosted by Apple": the hub fetches it (the TV does not accept Apple's certificate), and
    // after the time limit the images take over.
    await ev(`Store.set('ambient.sources', { apple: true, community: false, amazon: false }); Store.set('ambient.maxMinutes', 0.001); Idle.enter()`);
    const viaHub = await waitFor(() => ev(`Idle.aerial().on && Idle.aerial().viaHub && document.getElementById('ambient').classList.contains('has-video') && document.getElementById('ambient-video').currentTime > 0`), 12000);
    ok('idle: a video from the Apple server plays via the hub', viaHub && (await ev(`Idle.aerial().url.indexOf('/api/wallpapers/video?u=https%3A%2F%2Fsylvan.apple.com%2F') > 0`)), await ev('JSON.stringify(Idle.aerial())'));
    await ev(`{ const v = document.getElementById('ambient-video'); v.currentTime = Math.max(0, v.duration - 0.4); }`);
    ok('idle: after the time limit the images take over', await waitFor(() => ev(`Idle.isActive() && !Idle.aerial().on && !document.getElementById('ambient').classList.contains('has-video') && !document.getElementById('ambient-video').getAttribute('src')`), 8000),
      await ev('JSON.stringify(Idle.aerial())'));
    await press('back', 500);
    await ev(`Store.set('ambient.maxMinutes', 60)`);
    // If the videos cannot be played: the images instead (idle mode continues).
    await ev(`Store.set('ambient.sources', { apple: false, community: false, amazon: false }); Idle.enter()`);
    ok('idle: without playable videos the images are shown instead', await waitFor(() => ev(`Idle.isActive() && !Idle.aerial().on && !document.getElementById('ambient').classList.contains('has-video')`), 6000));
    await press('back', 500);
    await ev(`Store.set('ambient.sources', { apple: true, community: true, amazon: false }); Store.set('ambient.mode', 'images')`);
  }
  await ev(`Idle.enter()`);
  ok('idle with images: clock and caption, no video', await waitFor(() => ev(`Idle.isActive() && !Idle.aerial().on && document.getElementById('ambient-time').textContent.length >= 4 && document.getElementById('ambient-credit').textContent.length > 3`), 4000),
    await ev(`document.getElementById('ambient-credit').textContent`));
  await press('back', 500);
  ok('idle: ended, the settings are still open', !(await ev('Idle.isActive()')) && (await ev(`(Router.top() || {}).name`)) === 'settings');
  await ev('Router.home()');

  // --- Report
  const r = await ev('JSON.stringify(Perf.report())');
  const rep = JSON.parse(r);
  console.log(`\n  Perf: start → home screen ${rep.boot.home} ms · key press median ${rep.keys && rep.keys.p50} ms (p90 ${rep.keys && rep.keys.p90}) · DOM ${rep.dom} · long tasks ${rep.longTasks.n}`);
  ok('no missing translations (' + LANG + ')', (await ev('I18n.lang')) === LANG && (await ev('I18n.missing.size')) === 0, await ev('[...I18n.missing].join(", ")'));
  ok('no errors in the console', !errors.length, errors.slice(0, 3).join(' | '));
} catch (e) {
  failed++;
  console.error('\n  ✗ ' + e.message);
  console.error(log.split('\n').slice(-10).join('\n'));
} finally {
  if (page) page.close();
  chrome.stop();
  server.kill();
}

console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`);
process.exit(failed ? 1 : 0);
