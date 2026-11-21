/*
 * Idle — ambient mode after a period of inactivity. Paused while video is playing.
 *
 * Two modes (Settings › Background › Ambient shows, Store 'ambient.mode'):
 *   'images'  the background image drifts slowly (Ken Burns) and changes every three minutes
 *   'aerial'  aerial videos like the Apple TV screensaver: one video at a time, with the place name and
 *             captions. The list comes from the hub (/api/wallpapers/aerial); the video itself is
 *             streamed from the source – Apple's via the hub (the TV does not accept their servers'
 *             certificates), others directly. Quality: 'hd' (1080p), 'uhd' (4K) or 'hdr' (4K Dolby
 *             Vision profile 5 at Apple; videos without an HDR variant are shown in 4K).
 * A dimmed clock sits in the bottom left and moves a little now and then (gentle on OLED);
 * the video's caption in the bottom right moves in the same way.
 *
 * Performance: the videos only play in ambient mode (the TV has a single active video player, and it is
 * free then), are decoded by the TV's hardware and stopped at the first key press. Nothing is stored on the TV. If a
 * video cannot be played a lower quality is tried, and after three errors in a row the images are shown instead.
 * Videos are streamed for at most 'ambient.maxMinutes' (default 60) per ambient session – then the images take over, so
 * that a TV left on does not pull 4K video for hours.
 */
(function (global) {
  'use strict';

  const el = () => document.getElementById('ambient');
  let timer = null;
  let drift = null;
  let clock = null;
  let rotate = null;
  let active = false;
  let blocked = 0; // >0 when something (e.g. video) does not want ambient mode
  let prevMode = 'shelf';

  // --- Aerial videos ---------------------------------------------------------------------------

  const TIERS = ['hdr', 'uhd', 'hd'];
  const LIST_TTL = 12 * 3600e3;
  const START_TIMEOUT = 25000;
  const A = { list: null, proxyHosts: [], at: 0, order: [], video: null, errors: 0, tier: 0, playing: null, url: '', timer: null, on: false, poiAt: -1, since: 0 };

  const hub = () => (global.IPTV && IPTV.source && IPTV.mode && IPTV.mode() === 'hub' ? IPTV.source.hub : null);
  const aerialWanted = () => {
    const b = global.IPTV && IPTV.boot && IPTV.boot();
    return Store.get('ambient.mode') === 'aerial' && !!(hub() && hub().aerial && b && b.caps && b.caps.wallpapers);
  };

  function sources() {
    const s = Store.get('ambient.sources') || {};
    return { apple: s.apple !== false, community: s.community !== false, amazon: s.amazon === true };
  }

  function loadList() {
    if (A.list && Date.now() - A.at < LIST_TTL) return Promise.resolve(A.list);
    return hub().aerial().then((r) => {
      A.list = (r && r.videos) || [];
      A.proxyHosts = (r && r.proxyHosts) || [];
      A.at = Date.now();
      return A.list;
    });
  }

  function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function urlFor(v) {
    const want = Math.max(TIERS.indexOf(Store.get('ambient.quality') || 'uhd'), A.tier);
    for (let i = Math.max(0, want); i < TIERS.length; i++) if (v.urls[TIERS[i]]) return v.urls[TIERS[i]];
    return v.urls.uhd || v.urls.hd || v.urls.hdr || '';
  }

  // The address the TV should play: via the hub for the servers the hub has named, otherwise the video's own.
  function playable(url) {
    const host = (/^https?:\/\/([^/:?#]+)/i.exec(url) || [])[1] || '';
    return host && A.proxyHosts.indexOf(host.toLowerCase()) >= 0 && hub() && hub().aerialVideo ? hub().aerialVideo(url) : url;
  }

  const limitMs = () => {
    const m = Store.get('ambient.maxMinutes');
    return (m == null ? 60 : +m || 0) * 60000;
  };

  const veil = (on) => el().classList.toggle('is-veiled', !!on);

  function caption() {
    const v = A.playing;
    const name = document.getElementById('ambient-place');
    const poi = document.getElementById('ambient-poi');
    if (!v || !A.on) { name.textContent = ''; poi.textContent = ''; return; }
    name.textContent = v.name || v.place || '';
    const t = A.video.currentTime || 0;
    let text = v.place && v.place !== v.name ? v.place : '';
    let at = -1;
    for (let i = 0; i < v.poi.length; i++) if (v.poi[i][0] <= t) { text = v.poi[i][1]; at = i; }
    if (at !== A.poiAt) {
      A.poiAt = at;
      poi.textContent = text;
    }
  }

  function playNext() {
    clearTimeout(A.timer);
    if (!A.on) return;
    // The time limit is reached: the images are shown for the rest of the ambient session (checked between videos).
    if (limitMs() && Date.now() - A.since >= limitMs()) { stopAerial(true); return; }
    // The queue is kept between ambient sessions (so the same video does not come up again straight away), but only with
    // the sources that are currently selected.
    const src = sources();
    A.order = A.order.filter((v) => src[v.source]);
    if (!A.order.length) A.order = shuffled((A.list || []).filter((v) => src[v.source]));
    const v = A.order.shift();
    const url = v && playable(urlFor(v));
    if (!url) { stopAerial(true); return; }
    A.playing = v;
    A.url = url;
    A.poiAt = -1;
    veil(true); // fade through black between videos
    A.timer = setTimeout(() => {
      if (!A.on) return;
      A.video.src = url;
      const p = A.video.play();
      if (p && p.catch) p.catch(() => {});
      A.timer = setTimeout(() => failed('timeout'), START_TIMEOUT);
    }, 900);
  }

  function failed(why) {
    if (!A.on) return;
    clearTimeout(A.timer);
    A.errors++;
    // First error at a quality: try a lower one for the rest of the session. Three errors in a row: the images instead.
    if (A.tier < TIERS.length - 1) A.tier++;
    console.warn('[idle] the aerial video could not be played (' + why + ')', A.playing && A.playing.id);
    if (A.errors >= 3) { stopAerial(true); return; }
    try { A.video.removeAttribute('src'); A.video.load(); } catch (e) { /* ignore */ }
    playNext();
  }

  function ensureVideo() {
    if (A.video) return;
    A.video = document.getElementById('ambient-video');
    A.video.muted = true;
    A.video.addEventListener('playing', () => {
      if (!A.on) return;
      clearTimeout(A.timer);
      A.errors = 0;
      el().classList.add('has-video');
      veil(false);
      caption();
    });
    A.video.addEventListener('timeupdate', caption);
    A.video.addEventListener('ended', () => { if (A.on) playNext(); });
    A.video.addEventListener('error', () => { if (A.on && A.video.getAttribute('src')) failed('error'); });
  }

  function startAerial() {
    ensureVideo();
    A.on = true;
    A.errors = 0;
    A.tier = 0;
    A.since = Date.now();
    // The TV allows one active video player: release the preview behind the home screen first.
    try { if (global.IPTV && IPTV.preview) IPTV.preview.stop(); } catch (e) { /* ignore */ }
    loadList().then(() => { if (A.on) playNext(); }, () => stopAerial(true));
  }

  // fallback = the videos did not work: continue ambient mode with the images.
  function stopAerial(fallback) {
    const was = A.on;
    A.on = false;
    A.playing = null;
    clearTimeout(A.timer);
    if (A.video) {
      try { A.video.pause(); A.video.removeAttribute('src'); A.video.load(); } catch (e) { /* ignore */ }
    }
    const a = el();
    a.classList.remove('has-video', 'is-veiled');
    caption();
    if (fallback && was && active) startImages();
  }

  // --- Images -----------------------------------------------------------------------------------

  function startImages() {
    clearInterval(rotate);
    rotate = setInterval(() => { if (global.Wallpaper) Wallpaper.next().then(tick); }, 3 * 60000);
  }

  function tick() {
    const d = new Date();
    document.getElementById('ambient-time').textContent = Clock.time(d);
    const w = global.Weather && global.Weather.current();
    const date = Clock.date(d);
    document.getElementById('ambient-sub').textContent =
      date.charAt(0).toUpperCase() + date.slice(1) + (w ? ' · ' + w.temp + '° ' + w.text.toLowerCase() : '');
    const wp = global.Wallpaper && Wallpaper.current();
    document.getElementById('ambient-credit').textContent = A.on ? '' : wp && (wp.title || wp.credit) ? [wp.title, wp.credit].filter(Boolean).join(' · ') : '';
  }

  function move() {
    const inner = el().querySelector('.ambient-inner');
    inner.style.setProperty('--dx', Math.round(Math.random() * 120) + 'px');
    inner.style.setProperty('--dy', Math.round(-Math.random() * 90) + 'px');
    const place = el().querySelector('.ambient-place');
    place.style.setProperty('--dx', Math.round(-Math.random() * 100) + 'px');
    place.style.setProperty('--dy', Math.round(-Math.random() * 70) + 'px');
  }

  function enter() {
    if (active || blocked > 0 || document.hidden) return;
    active = true;
    const a = el();
    a.hidden = false;
    document.body.classList.add('is-ambient');
    if (global.Wallpaper) {
      prevMode = Wallpaper.getMode();
      Wallpaper.mode('ambient');
    }
    requestAnimationFrame(() => requestAnimationFrame(() => a.classList.add('is-on')));
    if (aerialWanted()) startAerial();
    else startImages();
    tick();
    clock = setInterval(tick, 10000);
    drift = setInterval(move, 60000);
    move();
  }

  function exit() {
    if (!active) return;
    active = false;
    clearInterval(clock);
    clearInterval(drift);
    clearInterval(rotate);
    stopAerial(false);
    document.body.classList.remove('is-ambient');
    if (global.Wallpaper) Wallpaper.mode(prevMode);
    const a = el();
    a.classList.remove('is-on');
    setTimeout(() => { if (!active) a.hidden = true; }, 700);
  }

  function reset() {
    clearTimeout(timer);
    const min = +Store.get('ambientAfterMinutes') || 0;
    if (min > 0 && blocked === 0) timer = setTimeout(enter, min * 60000);
  }

  // Another app takes over the screen: release the video player immediately.
  document.addEventListener('visibilitychange', () => { if (document.hidden && A.on) stopAerial(false); });

  global.Idle = {
    reset,
    enter,
    exit,
    isActive: () => active,
    aerial: () => ({
      on: A.on, playing: A.playing && { id: A.playing.id, name: A.playing.name, source: A.playing.source }, url: A.on ? A.url : '', viaHub: A.on && A.url.indexOf('/api/wallpapers/video?') > 0,
      quality: TIERS[Math.max(0, TIERS.indexOf(Store.get('ambient.quality') || 'uhd'), A.tier)], errors: A.errors, list: A.list ? A.list.length : null, time: A.video ? A.video.currentTime : 0,
      minutesLeft: A.on && limitMs() ? Math.max(0, Math.round((limitMs() - (Date.now() - A.since)) / 60000)) : null
    }),
    // Block ambient mode (e.g. while video is playing). Returns a function that releases the block.
    block() {
      blocked++;
      clearTimeout(timer);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        blocked = Math.max(0, blocked - 1);
        reset();
      };
    }
  };
})(window);
