/*
 * IPTV.player — the one and only <video id="video"> (sits in #player-layer behind the views).
 *
 * Modes:  'off' · 'preview' (silent background behind the home screen's top shelf)
 *         'pane' (preview pane in the Live tab) · 'full' (full screen)
 * Kinds:  'live' (channel, reconnects if the stream drops) · 'vod' (movie/episode, seekable)
 *
 *   IPTV.player.play(channel, { mode })            live
 *   IPTV.player.playMedia(media, { start })        movie/episode: media = { id, url, title, … }
 *   .stop() .retry() .pause() .resume() .toggle() .seek(s) .seekBy(ds) .position()
 *   .setMode(mode) .mode() .kind() .current() .state() .paused() .onState(fn(state, detail, item))
 *   IPTV.preview.start(channel) / .stop()
 *
 * States: 'stopped' | 'loading' | 'playing' | 'buffering' | 'paused' | 'ended' | 'error'
 *
 * The source is set in one of two ways:
 *   'plain'   video.src = address (browsers, and live by default)
 *   'option'  <source type="video/mp4;mediaOption=…"> – which is what LG's own media player does. With
 *             htmlMediaOption.useUMSMediaInfo the TV sends track lists and picture info (the
 *             "umsmediainfo" event), which is needed for audio tracks and subtitles in the file (see tracks.js).
 *             If it does not work for a stream, the next attempt uses 'plain'; if that happens twice,
 *             'plain' is used for the rest of the session.
 *
 * Movies/episodes can be played via the hub (IPTV.subs.proxyUrl) – the hub then extracts the subtitles from
 * the stream and the launcher draws them itself (subs.js). If the stream via the hub cannot be played, the
 * player switches to direct playback on its own and says so ('proxy-failed').
 *   .viaProxy(address)  switch the current movie to the hub's stream, at the same position · .proxied()
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const video = document.getElementById('video');
  const layer = document.getElementById('player-layer');

  // Live: a dead channel should be reported quickly (two attempts of 10 s each). Movies get longer.
  const LOAD_TIMEOUT = 20000;
  const LIVE_LOAD_TIMEOUT = 10000;
  const RETRY_DELAY = 1500;
  const STALL_TIMEOUT = 12000;
  const PREVIEW_DELAY = 900;
  const PREVIEW_MAX = 120000;

  let mode = 'off';
  let kind = 'live';
  let item = null;        // channel or media
  let state = 'stopped';
  let release = null;     // idle block
  let retried = false;
  let startAt = 0;        // vod: start here
  let loadTimer = null;
  let stallTimer = null;
  let retryTimer = null;
  let previewTimer = null;
  let previewStop = null;
  let resumeAfterHide = null;
  let attached = '';      // '' | 'plain' | 'option' – how the source was last set
  let plainNext = false;  // next attempt without mediaOption
  let optionFails = 0;    // times 'option' failed but 'plain' worked
  let fellBack = false;
  let playUrl = '';       // the hub's stream address when the file plays via the hub, otherwise ''
  const listeners = [];

  const playingish = (s) => s === 'playing' || s === 'buffering' || s === 'paused';

  function emit(s, detail) {
    state = s;
    layer.classList.toggle('is-playing', playingish(s));
    listeners.forEach((fn) => {
      try { fn(s, detail || null, item); } catch (e) { console.error(e); }
    });
  }

  function setMode(m) {
    mode = m;
    layer.className = 'player-layer mode-' + m + ' kind-' + kind + (playingish(state) ? ' is-playing' : '');
    video.muted = m === 'preview';
    // Idle is only blocked while you are actually watching.
    if ((m === 'full' || m === 'pane') && item) {
      if (!release) release = Idle.block();
    } else if (release) {
      release();
      release = null;
    }
  }

  function clearTimers() {
    clearTimeout(loadTimer);
    clearTimeout(stallTimer);
    clearTimeout(retryTimer);
    loadTimer = stallTimer = retryTimer = null;
  }

  function detach() {
    try { video.pause(); } catch (e) { /* ignore */ }
    attached = '';
    video.removeAttribute('src');
    while (video.firstChild) video.removeChild(video.firstChild);
    try { video.load(); } catch (e) { /* ignore */ }
  }

  // Should the stream be started with mediaOption (track lists from the TV)? Movies/episodes: yes. Live: only if
  // you have turned it on (Settings › IPTV › Live TV) – channel changes must never be put at risk.
  function wantOption() {
    if (!TV.isTV || plainNext || optionFails >= 2) return false;
    if (kind === 'vod') return Store.get('player.mediaInfo') !== false;
    return Store.get('live.mediaInfo') === true;
  }

  function mimeOf(url) {
    const path = String(url).split(/[?#]/)[0].toLowerCase();
    if (/\.m3u8$/.test(path)) return 'application/x-mpegURL';
    if (/\.ts$/.test(path)) return 'video/mp2t';
    return 'video/mp4'; // LG's player gives video/mp4 for every file (even mkv) – the TV detects the format itself
  }

  function attach(url) {
    video.removeAttribute('src');
    while (video.firstChild) video.removeChild(video.firstChild);
    if (!wantOption()) {
      attached = 'plain';
      video.src = url;
      return;
    }
    const opt = { htmlMediaOption: { useUMSMediaInfo: true } };
    // Test flags (set via Store 'player.lab' when debugging on the TV, see docs/ARCHITECTURE.md §2).
    const lab = Store.get('player.lab') || {};
    if (lab.dass) opt.htmlMediaOption.useDassControl = true;
    if (lab.transport) opt.mediaTransportType = String(lab.transport);
    const src = document.createElement('source');
    src.src = url;
    src.type = mimeOf(url) + ';mediaOption=' + escape(JSON.stringify(opt));
    // Errors on a <source> do not reach <video> – listen here.
    src.addEventListener('error', () => { if (item && src.parentNode === video) retryOrFail('error'); });
    attached = 'option';
    video.appendChild(src);
    try { video.load(); } catch (e) { /* ignore */ }
  }

  function fail(reason) {
    if (global.Perf) Perf.zap.cancel();
    clearTimers();
    detach();
    emit('error', reason);
  }

  function load() {
    clearTimers();
    let url = playUrl || (item && item.url);
    // Preview: Chrome treats .m3u8 as HLS, but the demo provider serves mp4 behind the address.
    if (url && !TV.isTV && /\/__xtream\/live\/.+\.m3u8$/.test(url)) url = url.replace(/\.m3u8$/, '.ts');
    if (!url) {
      fail('nourl');
      return;
    }
    // The demo clips in the browser are short – loop them for live.
    video.loop = !TV.isTV && kind === 'live' && /\/__(mock|xtream)\//.test(url);
    attach(url);
    if (global.Perf) Perf.zap.start(url, kind);
    emit('loading');
    const p = video.play();
    if (p && p.catch) {
      p.catch((err) => {
        // Browsers may refuse sound without user interaction – play muted in that case.
        if (err && err.name === 'NotAllowedError' && !video.muted) {
          video.muted = true;
          video.play().catch(() => {});
        }
      });
    }
    loadTimer = setTimeout(() => {
      if (state === 'loading') retryOrFail('timeout');
    }, kind === 'live' ? LIVE_LOAD_TIMEOUT : LOAD_TIMEOUT);
  }

  function retryOrFail(reason) {
    if (!item) return;
    if (playUrl) {
      // It did not work via the hub: play directly from the provider (does not count as one of the attempts).
      playUrl = '';
      if (kind === 'vod' && video.currentTime > 5) startAt = video.currentTime;
      clearTimers();
      detach();
      emit('loading');
      IPTV.emit('proxy-failed', reason);
      retryTimer = setTimeout(() => { retryTimer = null; if (item) load(); }, 300);
      return;
    }
    if (!retried) {
      retried = true;
      if (kind === 'vod' && video.currentTime > 5) startAt = video.currentTime;
      // The first attempt was with mediaOption: try without it (as before) before we give up.
      if (attached === 'option') { plainNext = true; fellBack = true; }
      clearTimers();
      detach();
      emit('loading');
      // The timer is cleared by clearTimers(), so a zap during the pause does not reload the new channel.
      retryTimer = setTimeout(() => { retryTimer = null; if (item) load(); }, RETRY_DELAY);
    } else {
      fail(reason);
    }
  }

  video.addEventListener('loadedmetadata', () => {
    if (kind === 'vod' && startAt > 0) {
      const d = video.duration;
      if (!isFinite(d) || startAt < d - 10) {
        try { video.currentTime = startAt; } catch (e) { /* ignore */ }
      }
      startAt = 0;
    }
  });
  video.addEventListener('playing', () => {
    if (!item) return;
    if (global.Perf) Perf.zap.end();
    clearTimers();
    retried = false;
    if (fellBack && attached === 'plain') optionFails++;
    fellBack = false;
    emit('playing');
  });
  video.addEventListener('pause', () => {
    if (!item || state === 'loading' || state === 'ended' || state === 'error' || !attached) return;
    emit('paused');
  });
  video.addEventListener('waiting', () => {
    if (!item || state === 'loading' || video.paused) return;
    emit('buffering');
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => retryOrFail('stall'), STALL_TIMEOUT);
  });
  video.addEventListener('stalled', () => {
    if (!item || state !== 'playing' || kind === 'vod') return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (state !== 'playing' || video.paused) retryOrFail('stall');
    }, STALL_TIMEOUT);
  });
  video.addEventListener('error', () => {
    if (!item || !attached) return;
    retryOrFail('error');
  });
  video.addEventListener('ended', () => {
    if (!item || video.loop) return;
    // Live streams should not end – try to reconnect. Movies are done.
    if (kind === 'live') retryOrFail('ended');
    else {
      clearTimers();
      emit('ended');
    }
  });

  function play(ch, opts) {
    if (!ch) return;
    opts = opts || {};
    const m = opts.mode || 'full';
    if (m !== 'preview') cancelPreview();
    const same = kind === 'live' && item && String(item.id) === String(ch.id) && state !== 'error' && state !== 'stopped';
    kind = 'live';
    item = ch;
    playUrl = '';
    setMode(m);
    if (same) {
      video.muted = m === 'preview';
      if (video.paused) video.play().catch(() => {});
      return;
    }
    retried = false;
    plainNext = fellBack = false;
    startAt = 0;
    load();
  }

  function playMedia(media, opts) {
    if (!media) return;
    opts = opts || {};
    cancelPreview();
    kind = 'vod';
    item = media;
    // Via the hub from the start when subtitles are preselected (otherwise only once you choose a subtitle track).
    playUrl = IPTV.subs && IPTV.subs.wantedAtStart(media) ? IPTV.subs.proxyUrl(media) : '';
    retried = false;
    plainNext = fellBack = false;
    startAt = Math.max(0, Number(opts.start) || 0);
    setMode(opts.mode || 'full');
    load();
  }

  // Switch the current movie to the hub's stream (same position in the movie).
  function viaProxy(url) {
    if (!item || kind !== 'vod' || !url || playUrl === url) return false;
    playUrl = url;
    startAt = video.currentTime || 0;
    retried = false;
    plainNext = fellBack = false;
    load();
    return true;
  }

  function stop() {
    if (global.Perf) Perf.zap.cancel();
    clearTimers();
    item = null;
    playUrl = '';
    detach();
    setMode('off');
    emit('stopped');
  }

  function retry() {
    if (!item) return;
    retried = false;
    plainNext = fellBack = false;
    if (kind === 'vod' && video.currentTime > 5) startAt = video.currentTime;
    load();
  }

  function pause() {
    if (item && !video.paused) video.pause();
  }

  function resume() {
    if (!item) return;
    if (state === 'ended') {
      try { video.currentTime = 0; } catch (e) { /* ignore */ }
    }
    if (video.paused) video.play().catch(() => {});
  }

  function toggle() {
    if (!item) return;
    if (video.paused || state === 'ended') resume();
    else pause();
  }

  function duration() {
    const d = video.duration;
    if (isFinite(d) && d > 0) return d;
    return (item && item.duration) || 0;
  }

  function seek(sec) {
    if (!item || kind !== 'vod') return;
    const d = duration();
    const t = Math.max(0, d ? Math.min(d - 1, sec) : sec);
    try { video.currentTime = t; } catch (e) { /* ignore */ }
    if (state === 'ended') emit('paused');
  }

  const seekBy = (delta) => seek((video.currentTime || 0) + delta);

  function position() {
    let buffered = 0;
    try {
      if (video.buffered.length) buffered = video.buffered.end(video.buffered.length - 1);
    } catch (e) { /* ignore */ }
    return { time: video.currentTime || 0, duration: duration(), buffered };
  }

  // --- Preview behind the home screen --------------------------------------------

  function cancelPreview() {
    clearTimeout(previewTimer);
    clearTimeout(previewStop);
    previewTimer = previewStop = null;
  }

  const preview = {
    start(ch) {
      if (!ch || !ch.url || mode === 'full' || mode === 'pane') return;
      cancelPreview();
      previewTimer = setTimeout(() => {
        if (mode === 'full' || mode === 'pane' || document.hidden) return;
        play(ch, { mode: 'preview' });
        previewStop = setTimeout(preview.stop, PREVIEW_MAX);
      }, PREVIEW_DELAY);
    },
    stop() {
      cancelPreview();
      if (mode === 'preview') stop();
    }
  };

  // --- App hidden / shown -----------------------------------------------------------

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelPreview();
      resumeAfterHide = item && (mode === 'full' || mode === 'pane')
        ? { item, mode, kind, time: video.currentTime || 0 }
        : null;
      if (item) stop();
    } else if (resumeAfterHide) {
      const r = resumeAfterHide;
      resumeAfterHide = null;
      setTimeout(() => {
        const top = Router.top();
        if (!top || top.name !== 'tv') return;
        if (r.kind === 'vod') playMedia(r.item, { start: r.time, mode: r.mode });
        else play(r.item, { mode: r.mode });
        IPTV.emit('player-resumed', r);
      }, 300);
    }
  });

  IPTV.player = {
    video,
    play,
    playMedia,
    stop,
    retry,
    pause,
    resume,
    toggle,
    seek,
    seekBy,
    position,
    setMode,
    mode: () => mode,
    kind: () => kind,
    current: () => item,
    state: () => state,
    paused: () => video.paused,
    // 'plain' | 'option' | '' – how the source is set right now (for debugging and tests).
    sourceMode: () => attached,
    viaProxy,
    proxied: () => !!playUrl,
    onState: (fn) => listeners.push(fn)
  };
  IPTV.preview = preview;
})(window);
