/*
 * IPTV.subs — the launcher's own subtitles for movies and episodes, drawn on top of the video.
 *
 * Why not the TV's own: LG's video pipeline drops text in ASS tracks (everything before the first comma
 * in a cue disappears, cues without a comma are not shown at all – seen on a G3 2026-11-21), and
 * it only has five text sizes. Here the file is played via the hub (/api/stream), which extracts the subtitle
 * tracks from the same byte stream and serves the cues on /api/subs. The provider still sees only one
 * connection. The cues for what the TV has buffered are always at the hub before they are due to be shown.
 *
 * Used for subtitle tracks in .mkv when the source is a hub that supports it (bootstrap caps.stream).
 * Otherwise (image-based tracks, .mp4, direct mode, hub down) the TV's own are used – see tracks.js.
 *
 *   IPTV.subs.usable(media)        can the file be played via the hub with our own subtitles?
 *   IPTV.subs.wantedAtStart(media) should it be played via the hub from the start (subtitles are preselected)?
 *   IPTV.subs.proxyUrl(media)      the hub's stream address for the file
 *   IPTV.subs.show(index)          show subtitle track number index (the file's order, as on the TV)
 *   IPTV.subs.hide() · .active() · .track()
 *   IPTV.subs.trackInfo(index)     the hub's details about the track ({ codec, text, name, forced }) or null
 *   IPTV.subs.refresh()            re-read size/position from the settings
 *   IPTV.subs.el                   the element the text is drawn in (the player puts it over the video)
 *   IPTV.subs.debug()
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const P = IPTV.player;
  const video = P.video;

  const POLL_MS = 1000;
  const DRAW_MS = 120;
  const BROKEN_MS = 10 * 60000;   // after an error via the hub: play directly for a while

  const el = document.createElement('div');
  el.className = 'subs';
  el.hidden = true;
  el.innerHTML = '<span class="subs-text"></span>';
  const textEl = el.firstChild;

  const S = {
    url: '',          // the provider's address for the file (the key at the hub)
    track: -1,
    cues: [],         // [[start, end, text]] sorted by start
    next: 0,          // number of cues fetched from the hub for the track
    tracks: null,     // the hub's track list once known
    shown: '',
    brokenUntil: 0,
    polls: 0,
    lastError: ''
  };
  let pollTimer = null;
  let drawTimer = null;

  const src = () => IPTV.source.hub || {}; // the hub's calls (streamUrl, subs) – only exist in hub mode
  const mediaUrl = (m) => (m && m.url) || '';

  function usable(media) {
    media = media || (P.kind() === 'vod' ? P.current() : null);
    const boot = IPTV.boot && IPTV.boot();
    return !!(media && media.kind !== 'catchup' && IPTV.mode() === 'hub' && src().streamUrl && boot && boot.caps && boot.caps.stream &&
      Store.get('player.hubSubs') !== false && Date.now() > S.brokenUntil && /\.mkv(\?|#|$)/i.test(mediaUrl(media)));
  }

  // Subtitles are preselected (a fixed language, or what you last chose in the player was not "Off").
  function wantedAtStart(media) {
    if (!usable(media)) return false;
    const pref = Store.get('player.subPref') || 'last';
    const want = pref === 'last' ? Store.get('player.subLang') : pref;
    return !!want && want !== 'off';
  }

  const proxyUrl = (media) => (usable(media) ? src().streamUrl(mediaUrl(media || P.current())) : '');

  // --- Fetch cues from the hub --------------------------------------------------------------------

  function merge(cues) {
    if (!cues || !cues.length) return;
    let sorted = true;
    let last = S.cues.length ? S.cues[S.cues.length - 1][0] : -1;
    for (let i = 0; i < cues.length; i++) {
      if (cues[i][0] < last) sorted = false;
      last = cues[i][0];
      S.cues.push(cues[i]);
    }
    // After seeking backwards, older cues arrive last.
    if (!sorted) S.cues.sort((a, b) => a[0] - b[0]);
  }

  function poll() {
    clearTimeout(pollTimer);
    if (!S.url) return;
    const url = S.url;
    const track = S.track;
    src().subs(url, track, track >= 0 ? S.next : 0).then((r) => {
      if (url !== S.url || track !== S.track || !r) return;
      S.polls++;
      S.lastError = '';
      if (r.tracks && r.tracks.length && (!S.tracks || S.tracks.length !== r.tracks.length)) {
        S.tracks = r.tracks;
        IPTV.emit('subs-tracks', r.tracks);
      }
      if (track >= 0) {
        merge(r.cues);
        if (r.next != null) S.next = r.next;
      }
    }, (e) => { S.lastError = (e && e.message) || 'error'; }).then(() => {
      if (url !== S.url) return;
      // As long as no track is shown only the track list is needed: poll sparsely, and stop once it is known.
      if (S.track < 0 && S.tracks) return;
      pollTimer = setTimeout(poll, S.track >= 0 ? POLL_MS : 1500);
    });
  }

  // --- Draw ---------------------------------------------------------------------------------------

  // Cues to show at time t (binary search on start, then a few steps back for overlaps).
  function at(t) {
    const c = S.cues;
    let lo = 0;
    let hi = c.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid][0] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const out = [];
    for (let k = i; k >= 0 && k > i - 4; k--) if (c[k][1] > t) out.unshift(c[k][2]);
    return out.join('\n');
  }

  function draw() {
    if (S.track < 0) return;
    const sync = (IPTV.tracks.state().sync || 0);
    const playing = P.kind() === 'vod' && P.current() && P.state() !== 'loading' && P.state() !== 'stopped' && P.state() !== 'error';
    const text = playing ? at((video.currentTime || 0) - sync) : '';
    if (text === S.shown) return;
    S.shown = text;
    textEl.textContent = text;
    el.classList.toggle('has-text', !!text);
  }

  function refresh() {
    const st = IPTV.tracks.style();
    const size = IPTV.tracks.sizes.find((x) => x.v === st.size) || IPTV.tracks.sizes[3];
    const pos = IPTV.tracks.positions.find((x) => x.v === st.position) || IPTV.tracks.positions[1];
    el.style.setProperty('--subs-size', size.px + 'px');
    el.style.setProperty('--subs-bottom', pos.px + 'px');
    el.classList.toggle('has-box', !!(Store.get('player.sub') || {}).box);
  }

  // --- Control ------------------------------------------------------------------------------------

  function watch(url) {
    if (S.url === url) return;
    S.url = url;
    S.track = -1;
    S.cues = [];
    S.next = 0;
    S.tracks = null;
    S.shown = '';
    textEl.textContent = '';
    el.classList.remove('has-text');
    clearTimeout(pollTimer);
    if (url) pollTimer = setTimeout(poll, 600);
  }

  function show(index) {
    const media = P.kind() === 'vod' ? P.current() : null;
    if (!media || !P.proxied()) return false;
    watch(mediaUrl(media));
    S.track = index;
    S.cues = [];
    S.next = 0;
    S.shown = '';
    textEl.textContent = '';
    refresh();
    el.hidden = false;
    clearInterval(drawTimer);
    drawTimer = setInterval(draw, DRAW_MS);
    poll();
    return true;
  }

  function hide() {
    S.track = -1;
    S.cues = [];
    S.next = 0;
    S.shown = '';
    clearInterval(drawTimer);
    drawTimer = null;
    textEl.textContent = '';
    el.classList.remove('has-text');
    el.hidden = true;
  }

  // New file, or playback ended: start over. If the file plays via the hub, the track list is fetched straight away
  // (with codec and name), so that the menu can show it even before a track has been chosen.
  P.onState((s) => {
    if (s === 'stopped' || (s === 'loading' && P.kind() !== 'vod')) {
      hide();
      watch('');
    } else if (s === 'loading' && P.kind() === 'vod') {
      const media = P.current();
      if (P.proxied() && media) watch(mediaUrl(media));
      else { hide(); watch(''); }
    }
  });

  // The stream via the hub could not be played (the player has already switched to direct playback).
  IPTV.on('proxy-failed', () => {
    S.brokenUntil = Date.now() + BROKEN_MS;
    hide();
    watch('');
  });

  Store.on((path) => { if (path === '*' || /^player\.sub/.test(path)) refresh(); });
  refresh();

  IPTV.subs = {
    el,
    usable,
    wantedAtStart,
    proxyUrl,
    show,
    hide,
    refresh,
    active: () => S.track >= 0,
    track: () => S.track,
    trackInfo: (index) => (S.tracks && S.tracks[index]) || null,
    debug: () => ({ url: S.url ? S.url.replace(/\/\/[^/]+\/.*\/([^/]+)$/, '//…/$1') : '', track: S.track, cues: S.cues.length, next: S.next, tracks: S.tracks ? S.tracks.length : null,
      polls: S.polls, shown: S.shown, error: S.lastError, proxied: P.proxied(), usable: usable(), time: video.currentTime, sample: S.cues.slice(0, 3) })
  };
})(window);
