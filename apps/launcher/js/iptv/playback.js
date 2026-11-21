/*
 * IPTV.playback — full-screen player for movies and episodes. Inspired by the Apple TV app,
 * Infuse and Netflix: a calm picture, glass controls that appear when you need them.
 *
 *   IPTV.playback.play(media, { start, ask, next })
 *     media = { id, kind:'vod'|'episode', url, title, seriesId?, seriesTitle?, season?, episode?,
 *               poster, backdrop, still?, duration?, plot?, year? }
 *     start = seconds to start at · ask = ask "Resume / Start over" if start > 0
 *     next  = () => media   (next episode)
 *
 * Keys (controls hidden):
 *   OK / Play / Pause  play/pause           ◀ ▶   seek 10 s (hold = faster)
 *   ⏪ ⏩               30 s                  ▲     show the timeline    ▼  the button row
 *   0–9                jump to 0–90 %        Back  exit (the position is saved)
 * With the controls showing: ◀ ▶ on the timeline previews the seek – OK or a short pause jumps there.
 * Button row: −10 · Play/Pause · +10 · Audio and subtitles · Speed · Next episode · From the start.
 *
 * Audio and subtitle tracks: see tracks.js (the lists come from the TV, the subtitles are drawn by the TV).
 * The panel also has the subtitle size, position and sync. The chosen language is remembered for next time.
 * Top left shows what the TV is playing: 4K · Dolby Vision · Dolby Atmos (when the TV reports it).
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const P = IPTV.player;
  const u = IPTV.u;
  const esc = u.esc;
  const video = document.getElementById('video');

  const HIDE_MS = 5000;
  const SAVE_MS = 10000;
  const COMMIT_MS = 650;
  const NEXT_COUNT = 5;      // seconds of countdown to the next episode
  const NEXT_BEFORE = 20;    // show "Next episode" this many seconds before the end
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const dec = new Intl.NumberFormat(I18n.locale, { maximumFractionDigits: 2 }); // 0,5 / 0.5

  // --- DOM -----------------------------------------------------------------------------------

  const ARIA = { back: tr('playback.back10'), toggle: tr('playback.playPause'), fwd: tr('playback.forward10') };
  const btn = (act, icon, label, cls) => '<button class="btn pb-btn ' + (cls || '') + '" data-focusable data-act="' + act + '"' +
    (label ? '' : ' aria-label="' + (ARIA[act] || act) + '"') + '>' + u.icon(icon) + (label ? '<span>' + label + '</span>' : '') + '</button>';

  const root = document.createElement('div');
  root.className = 'pb';
  root.hidden = true;
  root.innerHTML =
    '<div class="pb-shade"></div>' +
    '<div class="pb-state"></div>' +
    '<header class="pb-top"><p class="pb-kicker"></p><h1 class="pb-title"></h1><p class="pb-badges"></p><p class="pb-plot"></p></header>' +
    '<div class="pb-dock glass">' +
      '<div class="pb-track" data-focusable>' +
        '<i class="pb-rail"></i><i class="pb-buffer"></i><i class="pb-fill"></i><i class="pb-knob"></i>' +
        '<span class="pb-bubble tabular"></span>' +
      '</div>' +
      '<div class="pb-times"><span class="pb-time tabular"></span><span class="pb-end"></span><span class="pb-left tabular"></span></div>' +
      '<div class="pb-buttons">' +
        '<div class="pb-group">' + btn('back', 'back10', '', 'btn-icon') + btn('toggle', 'pause', '', 'btn-icon pb-toggle') + btn('fwd', 'fwd10', '', 'btn-icon') + '</div>' +
        '<div class="pb-group">' +
          btn('tracks', 'captions', tr('playback.audioAndSubtitles')) +
          btn('speed', 'speed', tr('playback.normalSpeed')) +
          btn('next', 'next', tr('playback.nextEpisode'), 'pb-only-ep') +
          btn('restart', 'restart', tr('playback.fromStart')) +
        '</div>' +
      '</div>' +
    '</div>' +
    '<aside class="pb-panel glass" hidden></aside>' +
    '<div class="pb-next glass" hidden>' +
      '<div class="pb-next-pic"><svg class="pb-ring" viewBox="0 0 48 48"><circle class="pb-ring-bg" cx="24" cy="24" r="21"/><circle class="pb-ring-fg" cx="24" cy="24" r="21"/></svg>' +
        '<span class="pb-ring-icon">' + u.icon('play') + '</span></div>' +
      '<div class="pb-next-text"><small>' + tr('playback.nextEpisode') + '</small><b class="pb-next-title"></b><span class="pb-next-sub"></span></div>' +
      '<div class="pb-next-actions">' +
        '<button class="btn pb-next-play" data-focusable data-act="next-now">' + u.icon('play') + '<span>' + tr('playback.playNow') + '</span></button>' +
        '<button class="btn pb-next-stay" data-focusable data-act="next-cancel"><span>' + tr('playback.keepWatching') + '</span></button>' +
      '</div>' +
    '</div>' +
    '<div class="pb-resume" hidden>' +
      '<div class="pb-resume-bg"></div>' +
      '<div class="pb-resume-box">' +
        '<p class="pb-kicker"></p><h1 class="pb-title"></h1>' +
        '<div class="pb-resume-actions">' +
          '<button class="btn btn-primary" data-focusable data-act="resume">' + u.icon('play') + '<span></span></button>' +
          '<button class="btn" data-focusable data-act="from-start">' + u.icon('restart') + '<span>' + tr('playback.startOver') + '</span></button>' +
        '</div>' +
      '</div>' +
    '</div>';

  const q = (sel) => root.querySelector(sel);
  const track = q('.pb-track');
  // The launcher's own subtitles (subs.js) sit above the video but below the controls.
  if (IPTV.subs) root.insertBefore(IPTV.subs.el, q('.pb-top'));

  const S = {
    media: null,
    open: false,
    next: null,
    target: null,       // pending seek position (s)
    holdCount: 0,
    lastKeyAt: 0,
    rate: 1,
    nextShown: false,
    nextDismissed: false,
    nextTimer: null,
    pending: null       // pending start (Resume/Start over)
  };

  let hideTimer = null;
  let saveTimer = null;
  let commitTimer = null;
  let drawTimer = null;
  let stateTimer = null;
  let trackW = 0;

  const autoNext = () => Store.get('player.autoNext') !== false;
  // One press of ◀ ▶ (Settings › IPTV › Movies and series).
  const skipStep = () => { const n = Number(Store.get('player.skip')); return n === 5 || n === 15 || n === 30 ? n : 10; };

  // The timeline's width is measured once (no layout read in every frame).
  function trackWidth() {
    if (!trackW) trackW = track.offsetWidth || 1600;
    return trackW;
  }

  // --- Show/hide ------------------------------------------------------------------------------

  const uiShown = () => root.classList.contains('show-ui');
  const panelOpen = () => !q('.pb-panel').hidden;
  const nextOpen = () => !q('.pb-next').hidden;
  const resumeOpen = () => !q('.pb-resume').hidden;

  function armHide() {
    clearTimeout(hideTimer);
    if (P.state() === 'playing' && S.target == null && !panelOpen()) hideTimer = setTimeout(hideUi, HIDE_MS);
  }

  function showUi(focus) {
    const was = uiShown();
    root.classList.add('show-ui');
    if (focus === 'track' || (!was && !focus)) Nav.focus(track, { force: true });
    else if (focus === 'buttons') Nav.focus(q('[data-act="toggle"]'), { force: true });
    // The subtitles are moved up so that they do not end up behind the controls.
    IPTV.tracks.lift(true);
    armHide();
    loop();
  }

  function hideUi() {
    clearTimeout(hideTimer);
    if (P.state() !== 'playing' || S.target != null || panelOpen()) return;
    root.classList.remove('show-ui');
    IPTV.tracks.lift(false);
    if (!nextOpen()) Nav.focus(track, { force: true });
  }

  // --- Draw progress --------------------------------------------------------------------------

  function duration() {
    const d = P.position().duration;
    return isFinite(d) && d > 0 ? d : (S.media && S.media.duration) || 0;
  }

  function draw() {
    const pos = P.position();
    const d = duration();
    const t = S.target != null ? S.target : pos.time;
    const pct = d ? Math.min(1, t / d) : 0;
    const w = trackWidth();
    q('.pb-fill').style.transform = 'scaleX(' + (d ? Math.min(1, pos.time / d) : 0) + ')';
    q('.pb-buffer').style.transform = 'scaleX(' + (d ? Math.min(1, (pos.buffered || 0) / d) : 0) + ')';
    q('.pb-knob').style.transform = 'translate3d(' + pct * w + 'px,0,0)';
    q('.pb-time').textContent = u.clock(t);
    q('.pb-left').textContent = d ? '−' + u.clock(Math.max(0, d - t)) : '';
    q('.pb-end').textContent = d ? tr('playback.endsAt', { time: u.time(Date.now() + ((d - pos.time) / (S.rate || 1)) * 1000) }) : '';
    const bubble = q('.pb-bubble');
    if (S.target != null) {
      const diff = Math.round(S.target - pos.time);
      bubble.innerHTML = u.clock(S.target) + '<small>' + (diff >= 0 ? '+' : '−') + u.clock(Math.abs(diff)) + '</small>';
      bubble.style.transform = 'translate3d(' + Math.max(70, Math.min(w - 70, pct * w)) + 'px,0,0)';
      root.classList.add('is-scrubbing');
    } else {
      root.classList.remove('is-scrubbing');
    }
  }

  // About four times a second while the controls are showing – that is enough and spares the TV.
  function loop() {
    clearTimeout(drawTimer);
    if (!S.open) return;
    draw();
    if (uiShown()) drawTimer = setTimeout(loop, 250);
  }

  // --- Seeking --------------------------------------------------------------------------------

  function step() {
    const now = Date.now();
    S.holdCount = now - S.lastKeyAt < 420 ? S.holdCount + 1 : 0;
    S.lastKeyAt = now;
    const c = S.holdCount;
    const base = skipStep();
    return c < 4 ? base : c < 10 ? Math.max(30, base) : c < 18 ? 60 : c < 28 ? 120 : 300;
  }

  function scrub(delta) {
    const d = duration();
    const base = S.target != null ? S.target : P.position().time;
    S.target = Math.max(0, d ? Math.min(d - 1, base + delta) : base + delta);
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, COMMIT_MS);
    if (!uiShown()) showUi('track');
    clearTimeout(hideTimer);
    draw();
  }

  function commit() {
    clearTimeout(commitTimer);
    if (S.target == null) return;
    P.seek(S.target);
    S.target = null;
    S.holdCount = 0;
    draw();
    armHide();
  }

  function cancelScrub() {
    clearTimeout(commitTimer);
    S.target = null;
    S.holdCount = 0;
    draw();
    armHide();
  }

  // --- Save the position ----------------------------------------------------------------------

  function snapshot() {
    const m = S.media;
    if (!m) return null;
    const pos = P.position();
    return Object.assign({}, m, { position: pos.time, duration: duration(), url: undefined, plot: undefined });
  }

  function save(final) {
    // Catch-up (TV after broadcast) does not go into Continue watching.
    if (S.media && S.media.kind === 'catchup') return;
    const p = snapshot();
    if (!p || (p.position < 5 && !final)) return;
    IPTV.saveProgress(p, { final });
  }

  // --- State ----------------------------------------------------------------------------------

  function stateUi(s) {
    const box = q('.pb-state');
    clearTimeout(stateTimer);
    const playing = s === 'playing' || s === 'buffering' || s === 'loading';
    q('.pb-toggle').innerHTML = u.icon(playing ? 'pause' : 'play');
    root.classList.toggle('is-paused', s === 'paused');
    if (s === 'loading' || s === 'buffering') {
      box.innerHTML = '';
      stateTimer = setTimeout(() => {
        if (P.state() === 'loading' || P.state() === 'buffering') box.innerHTML = '<div class="spinner spinner-lg"></div>';
      }, 400);
    } else if (s === 'error') {
      box.innerHTML = '<div class="tv-nosignal tv-nosignal-lg">' + u.icon('signal') + '<span>' + tr('playback.playFailed') + '</span><span class="tv-dim">' + tr('playback.pressOkToRetry') + '</span></div>';
      showUi('buttons');
    } else if (s === 'paused') {
      box.innerHTML = '';
      showUi();
      clearTimeout(hideTimer);
    } else {
      box.innerHTML = '';
      if (s === 'playing' && uiShown()) armHide();
    }
  }

  P.onState((s) => {
    if (!S.open || P.kind() !== 'vod') return;
    stateUi(s);
    if (s === 'paused') save(false);
    if (s === 'playing') applySpeed();
    if (s === 'ended') ended();
  });

  // Next episode appears near the end, even when the controls are hidden.
  video.addEventListener('timeupdate', () => {
    if (!S.open || P.kind() !== 'vod' || !S.next || S.nextShown || S.nextDismissed || S.target != null) return;
    const d = duration();
    if (d > 120 && d - video.currentTime <= NEXT_BEFORE && P.state() === 'playing') showNext(autoNext());
  });

  // --- Audio and subtitles (shared with live, see tracks.js) ----------------------------------------

  const TR = IPTV.tracks;
  const T = TR.state();
  const selectAudio = TR.selectAudio;
  const selectText = TR.selectText;

  function renderBadges() {
    q('.pb-badges').innerHTML = (T.badges || []).map((b) => '<span>' + esc(b) + '</span>').join('');
  }

  TR.onChange(() => {
    if (!S.open) return;
    renderBadges();
    if (panelOpen() && q('.pb-panel').getAttribute('data-kind') === 'tracks') {
      const cur = Nav.current();
      const key = cur && q('.pb-panel').contains(cur) ? [cur.getAttribute('data-type'), cur.getAttribute('data-i')] : null;
      renderTracks();
      const again = key && q('.pb-panel .pb-opt[data-type="' + key[0] + '"][data-i="' + key[1] + '"]');
      const f = again || q('.pb-panel .pb-opt.is-on') || q('.pb-panel .pb-opt');
      if (f) Nav.focus(f, { force: true });
    }
  });

  // --- Panels (Audio and subtitles · Speed) ----------------------------------------------------------

  function optHtml(type, i, label, detail, on) {
    return '<button class="pb-opt' + (on ? ' is-on' : '') + '" data-focusable data-type="' + type + '" data-i="' + i + '">' +
      '<span class="pb-opt-check">' + (on ? u.icon('check') : '') + '</span>' +
      '<span class="pb-opt-text"><b>' + esc(label) + '</b>' + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</span>' +
    '</button>';
  }

  // Long lists (movies with 20 subtitle tracks) scroll within the column.
  const col = (title, opts, after) => '<div class="pb-col"><h3>' + title + '</h3>' +
    '<div class="pb-opts" data-vscroll-viewport><div class="pb-opts-track" data-vscroll-track data-scroll-edge="90">' + opts + '</div></div>' +
    (after || '') + '</div>';

  const syncText = (v) => (v === 0 ? tr('playback.syncNone') : (v > 0 ? tr('playback.syncLater', { s: dec.format(v) }) : tr('playback.syncEarlier', { s: dec.format(-v) })));

  function renderTracks() {
    const panel = q('.pb-panel');
    const audio = T.audio.length
      ? T.audio.map((t, i) => optHtml('audio', i, t.name, t.detail, i === T.audioSel)).join('')
      : '';
    const text = optHtml('text', -1, tr('common.off'), '', T.textSel < 0) +
      T.text.map((t, i) => optHtml('text', i, t.name, t.detail, i === T.textSel)).join('');
    const waiting = P.state() === 'loading' || (!T.source && P.state() !== 'error');
    const st = TR.style();
    const label = (list, v) => (list.find((x) => x.v === v) || {}).label || '';
    // The appearance controls the TV's own subtitle rendering – only available when the tracks come from the TV.
    const look = T.text.length && T.source === 'webos'
      ? col(tr('playback.subtitleLook'),
        optHtml('style', 0, tr('playback.size'), label(TR.sizes, st.size), false) +
        optHtml('style', 1, tr('playback.height'), label(TR.positions, st.position), false) +
        optHtml('style', 4, tr('playback.background'), st.box ? tr('playback.darkBox') : tr('common.none'), false) +
        optHtml('style', 2, tr('playback.showEarlier'), '−' + tr('playback.seconds', { s: dec.format(0.5) }), false) +
        optHtml('style', 3, tr('playback.showLater'), '+' + tr('playback.seconds', { s: dec.format(0.5) }), false),
        '<p class="pb-none">' + syncText(T.sync || 0) + '</p>')
      : '';
    panel.innerHTML =
      col(tr('playback.audio'), audio, T.audio.length ? '' : '<p class="pb-none">' + (waiting ? tr('common.loading') : tr('playback.oneAudioTrack')) + '</p>') +
      col(tr('playback.subtitles'), text, T.text.length ? '' : '<p class="pb-none">' + (waiting ? tr('common.loading') : tr('playback.noSubtitles')) + '</p>') +
      look;
    panel.classList.toggle('is-wide', !!look);
  }

  function cycleStyle(i) {
    const st = TR.style();
    const next = (list, v) => list[(Math.max(0, list.findIndex((x) => x.v === v)) + 1) % list.length].v;
    if (i === 0) TR.setStyle({ size: next(TR.sizes, st.size) });
    else if (i === 1) TR.setStyle({ position: next(TR.positions, st.position) });
    else if (i === 4) TR.setStyle({ box: !st.box });
    else TR.setSync((T.sync || 0) + (i === 2 ? -0.5 : 0.5));
  }

  function renderSpeed() {
    q('.pb-panel').classList.remove('is-wide');
    q('.pb-panel').innerHTML = col(tr('playback.speed'),
      SPEEDS.map((r, i) => optHtml('speed', i, r === 1 ? tr('playback.normalSpeed') : dec.format(r) + '×', '', r === S.rate)).join(''));
  }

  function openPanel(kind) {
    const panel = q('.pb-panel');
    panel.setAttribute('data-kind', kind);
    if (kind === 'tracks') renderTracks(); else renderSpeed();
    panel.hidden = false;
    root.classList.add('has-panel');
    clearTimeout(hideTimer);
    Nav.pushScope(panel, { focus: panel.querySelector('.pb-opt.is-on') || panel.querySelector('.pb-opt') });
  }

  function closePanel() {
    if (!panelOpen()) return;
    q('.pb-panel').hidden = true;
    root.classList.remove('has-panel');
    Nav.popScope();
    armHide();
  }

  function applySpeed() {
    try { video.playbackRate = S.rate; } catch (e) { /* not supported */ }
  }

  function setSpeed(r) {
    S.rate = r;
    applySpeed();
    q('[data-act="speed"] span').textContent = r === 1 ? tr('playback.normalSpeed') : dec.format(r) + '×';
  }

  q('.pb-panel').addEventListener('nav:activate', (e) => {
    const o = e.target.closest('.pb-opt');
    if (!o) return;
    const type = o.getAttribute('data-type');
    const i = +o.getAttribute('data-i');
    if (type === 'audio') selectAudio(i, true).then(renderTracks).then(refocus);
    else if (type === 'text') selectText(i, true).then(renderTracks).then(refocus);
    else if (type === 'style') cycleStyle(i); // redrawn via TR.onChange (focus stays put)
    else if (type === 'speed') { setSpeed(SPEEDS[i]); closePanel(); }

    function refocus() {
      const again = q('.pb-panel .pb-opt[data-type="' + type + '"][data-i="' + i + '"]');
      if (again) Nav.focus(again, { force: true });
    }
  });

  // --- Next episode ------------------------------------------------------------------------------

  function nextMedia() {
    return S.next ? S.next() : null;
  }

  function showNext(countdown) {
    const nm = nextMedia();
    if (!nm) return false;
    S.nextShown = true;
    const card = q('.pb-next');
    q('.pb-next-title').textContent = nm.title || '';
    q('.pb-next-sub').textContent = nm.season ? tr('playback.seasonEpisode', { season: nm.season, episode: nm.episode }) : '';
    const pic = nm.still || nm.backdrop || nm.poster;
    q('.pb-next-pic').style.backgroundImage = pic ? 'url("' + IPTV.source.img(pic, 480).replace(/"/g, '%22') + '")' : 'none';
    card.classList.remove('is-counting');
    card.hidden = false;
    void card.offsetWidth;
    card.classList.add('is-on');
    if (countdown) {
      card.style.setProperty('--count', NEXT_COUNT + 's');
      card.classList.add('is-counting');
      clearTimeout(S.nextTimer);
      S.nextTimer = setTimeout(playNext, NEXT_COUNT * 1000);
    }
    if (!panelOpen()) Nav.focus(q('[data-act="next-now"]'), { force: true });
    return true;
  }

  function hideNext(dismissed) {
    clearTimeout(S.nextTimer);
    const card = q('.pb-next');
    card.classList.remove('is-on', 'is-counting');
    card.hidden = true;
    if (dismissed) S.nextDismissed = true;
    if (S.open && !panelOpen()) Nav.focus(uiShown() ? q('[data-act="toggle"]') : track, { force: true });
  }

  function ended() {
    const m = S.media;
    if (m) {
      const d = duration() || 1;
      IPTV.saveProgress(Object.assign({}, m, { position: d, duration: d, url: undefined }), { final: true });
    }
    if (nextMedia() && !S.nextDismissed) {
      // Already counting down? Let it finish. Otherwise start one (or wait for a key press).
      if (!nextOpen()) showNext(autoNext());
      else if (!q('.pb-next').classList.contains('is-counting') && autoNext()) playNext();
      return;
    }
    close();
  }

  function playNext() {
    clearTimeout(S.nextTimer);
    const nm = nextMedia();
    if (!nm) { close(); return; }
    // The episode we are leaving counts as watched.
    if (S.media && P.state() !== 'ended') {
      const d = duration() || 1;
      IPTV.saveProgress(Object.assign({}, S.media, { position: d, duration: d, url: undefined }), { final: true });
    }
    hideNext(false);
    const prog = IPTV.progressFor(nm.id);
    start(nm, { start: prog ? prog.position : 0, next: nextAfter(nm) });
  }

  // Continue the chain: the episode after next from the series info.
  function nextAfter(m) {
    let chain = null;
    if (m.seriesId) {
      IPTV.source.seriesInfo(m.seriesId).then((full) => {
        const all = [];
        (full.seasons || []).forEach((s) => { if (s.season !== 0) s.episodes.forEach((e) => all.push(e)); });
        const i = all.findIndex((e) => String(e.id) === String(m.id));
        const e = all[i + 1];
        if (e) {
          chain = () => ({
            id: e.id, kind: 'episode', url: e.url, title: e.title, seriesId: full.id || m.seriesId, seriesTitle: full.title || m.seriesTitle,
            season: e.season, episode: e.episode, poster: full.poster, backdrop: full.backdrop, still: e.still, duration: e.duration, plot: e.plot || ''
          });
        }
      }, () => {});
    }
    return () => (chain ? chain() : null);
  }

  // --- Resume or start over ----------------------------------------------------------------------

  function askResume(media, opts) {
    S.pending = { media, opts };
    const box = q('.pb-resume');
    box.querySelector('.pb-kicker').textContent = kicker(media);
    box.querySelector('.pb-title').textContent = media.title || '';
    box.querySelector('[data-act="resume"] span').textContent = tr('playback.resumeFrom', { time: u.clock(opts.start) });
    const pic = media.backdrop || media.still || media.poster;
    box.querySelector('.pb-resume-bg').style.backgroundImage = pic ? 'url("' + IPTV.source.img(pic, 1280).replace(/"/g, '%22') + '")' : 'none';
    box.hidden = false;
    Nav.focus(box.querySelector('[data-act="resume"]'), { force: true });
  }

  function answerResume(fromStart) {
    const p = S.pending;
    S.pending = null;
    q('.pb-resume').hidden = true;
    if (!p) return;
    start(p.media, Object.assign({}, p.opts, { start: fromStart ? 0 : p.opts.start, ask: false }));
  }

  // --- Open / close ----------------------------------------------------------------------------

  function kicker(m) {
    if (m.kicker) return m.kicker;
    if (m.kind === 'episode') return (m.seriesTitle || '') + (m.season ? ' · ' + tr('playback.seasonEpisodeShort', { season: m.season, episode: m.episode }) : '');
    return [m.year, m.genre].filter(Boolean).join(' · ');
  }

  function start(media, opts) {
    opts = opts || {};
    S.media = media;
    S.next = opts.next || null;
    S.target = null;
    S.nextShown = false;
    S.nextDismissed = false;
    hideNext(false);
    closePanel();
    setSpeed(1);
    root.classList.toggle('is-episode', media.kind === 'episode');
    q('.pb-top .pb-kicker').textContent = kicker(media);
    q('.pb-top .pb-title').textContent = media.title || '';
    q('.pb-plot').textContent = media.plot || '';
    q('.pb-badges').innerHTML = '';
    q('[data-act="next"]').hidden = !(media.kind === 'episode' && S.next);
    showUi('track');
    P.playMedia(media, { start: opts.start || 0 });
    stateUi(P.state());
    clearInterval(saveTimer);
    saveTimer = setInterval(() => { if (P.state() === 'playing') save(false); }, SAVE_MS);
    loop();
  }

  function play(media, opts) {
    opts = opts || {};
    if (!media || !media.url) {
      UI.toast(tr('playback.cannotPlay'));
      return;
    }
    if (!S.open) {
      S.open = true;
      trackW = 0;
      IPTV.ui.pushScreen({
        name: 'vod',
        el: root,
        onKey,
        focus: track,
        onClose() {
          S.open = false;
          clearInterval(saveTimer);
          clearTimeout(hideTimer);
          clearTimeout(commitTimer);
          clearTimeout(drawTimer);
          clearTimeout(S.nextTimer);
          if (panelOpen()) { q('.pb-panel').hidden = true; root.classList.remove('has-panel'); Nav.popScope(); }
          q('.pb-next').hidden = true;
          q('.pb-resume').hidden = true;
          root.classList.remove('show-ui', 'has-panel');
        }
      });
    }
    if (opts.ask && opts.start > 10) askResume(media, opts);
    else start(media, opts);
  }

  function close() {
    if (!S.open) return;
    if (S.media) {
      commit();
      save(true);
    }
    P.stop();
    S.media = null;
    S.pending = null;
    IPTV.ui.popScreen();
  }

  // --- Keys ------------------------------------------------------------------------------------

  function onKey(name, e) {
    if (resumeOpen()) {
      if (name === 'back' || name === 'stop') { S.pending = null; q('.pb-resume').hidden = true; close(); return true; }
      return false; // arrows/OK are handled by focus on the buttons
    }
    if (panelOpen()) {
      if (name === 'back') { closePanel(); return true; }
      armHide();
      return false;
    }
    if (nextOpen()) {
      if (name === 'back') { hideNext(true); return true; }
      if (name === 'stop') { close(); return true; }
      if (name === 'left' || name === 'right' || name === 'enter') return false;
      if (name === 'up' || name === 'down') return true;
    }
    if (/^digit\d$/.test(name || '')) {
      const d = duration();
      if (d) { S.target = (Number(name.slice(5)) / 10) * d; commit(); showUi('track'); }
      return true;
    }

    const cur = Nav.current();
    const onTrack = cur === track;
    const shown = uiShown();
    armHide();

    switch (name) {
      case 'play': P.resume(); showUi(); return true;
      case 'pause': P.pause(); showUi(); return true;
      case 'stop': close(); return true;
      case 'rewind': scrub(-30); return true;
      case 'forward': scrub(30); return true;
      case 'info': showUi('track'); return true;
      case 'enter':
        if (P.state() === 'error') { P.retry(); return true; }
        if (!shown) { P.toggle(); showUi('track'); return true; }
        if (onTrack) {
          if (S.target != null) commit(); else P.toggle();
          return true;
        }
        return false; // buttons are activated by focus
      case 'left':
      case 'right':
        if (!shown || onTrack) { scrub((name === 'left' ? -1 : 1) * step()); return true; }
        return false;
      case 'up':
        if (!shown) { showUi('track'); return true; }
        if (onTrack) return true;
        return false;
      case 'down':
        if (!shown) { showUi('buttons'); return true; }
        if (onTrack) { Nav.focus(q('[data-act="toggle"]'), { force: true }); return true; }
        return true;
      case 'back':
        if (S.target != null) { cancelScrub(); return true; }
        if (shown && P.state() === 'playing') {
          root.classList.remove('show-ui');
          IPTV.tracks.lift(false);
          Nav.focus(track, { force: true });
          return true;
        }
        close();
        return true;
      case 'green':
        showUi('buttons');
        openPanel('tracks');
        return true;
      case 'red':
        IPTV.options.menu({ title: S.media ? S.media.title : tr('playback.options') });
        return true;
      default:
        return name === 'channelUp' || name === 'channelDown' || name === 'blue' || name === 'yellow';
    }
  }

  root.addEventListener('nav:activate', (e) => {
    const act = e.target.getAttribute && e.target.getAttribute('data-act');
    switch (act) {
      case 'toggle': if (P.state() === 'error') P.retry(); else P.toggle(); armHide(); break;
      case 'back': scrub(-10); commit(); break;
      case 'fwd': scrub(10); commit(); break;
      case 'tracks': openPanel('tracks'); break;
      case 'speed': openPanel('speed'); break;
      case 'next': if (!showNext(false)) UI.toast(tr('playback.lastEpisode')); break;
      case 'restart': P.seek(0); if (P.state() === 'paused') P.resume(); armHide(); break;
      case 'next-now': playNext(); break;
      case 'next-cancel': hideNext(true); break;
      case 'resume': answerResume(false); break;
      case 'from-start': answerResume(true); break;
    }
  });

  // Magic Remote: a click on the picture = play/pause.
  root.addEventListener('click', (e) => {
    if (e.target.closest('.pb-dock, .pb-next, .pb-panel, .pb-resume')) return;
    if (P.state() === 'error') P.retry(); else P.toggle();
    showUi();
  });

  IPTV.on('player-resumed', (r) => {
    if (S.open && r.kind === 'vod') showUi();
  });

  IPTV.playback = { play, close, isOpen: () => S.open, tracks: () => T };
})(window);
