/*
 * IPTV.tracks — audio and subtitle tracks for what is playing right now (movie, episode or live channel).
 *
 * This is how LG's own media player (com.webos.app.mediadiscovery) does it, and we do the same:
 *   - The lists come from the TV in the "umsmediainfo" event on <video> (type "sourceInfo"). It is only
 *     sent when the stream was started with mediaOption { htmlMediaOption: { useUMSMediaInfo: true } }
 *     – see player.js. Without it there are no tracks to choose ("as if the subtitles do not exist").
 *   - Subtitles are controlled with video.send(JSON): SetMediaSubtitleEnable { enable },
 *     SetInternalSubtitle { index } and SetMediaSubtitleInfo { fontSize 0–4, position −3…4 (higher
 *     number = higher up), sync ms }. The TV draws the text itself (even image-based tracks such as PGS).
 *   - Audio tracks are switched with com.webos.media/selectTrack, which needs root → via the launcher's service.
 * If video.send does not respond, the service is used for subtitles too. In ordinary browsers
 * audioTracks/textTracks are used.
 *
 * Subtitle tracks in .mkv are drawn by the launcher itself when possible (subs.js, via the hub): the TV's own
 * subtitle engine drops text in ASS tracks and only has five sizes. The TV's own are used for image-based
 * tracks (PGS/VobSub), other file formats, direct mode and live.
 *
 * Language choice: 'last' (same as last time, the default), 'off' or a language code – separately for live and
 * for movies/series, so that subtitles you chose for a movie are not switched on for a TV channel.
 *
 *   IPTV.tracks.state()        { audio:[{ index, name, detail, lang }], text:[…], audioSel, textSel, badges:[…] }
 *   IPTV.tracks.selectAudio(i, remember) / selectText(i | -1, remember)   -> Promise
 *   IPTV.tracks.style() / setStyle({ size, position }) / setSync(sec) / lift(bool)
 *   IPTV.tracks.onChange(fn)   the lists, the selection or the picture info changed
 *   IPTV.tracks.langName('swe')   'Swedish' / 'Svenska' (in the interface language)
 *   IPTV.tracks.debug()        latest events and commands (debugging via npm run tv -- eval)
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const P = IPTV.player;
  const video = P.video;

  // Language codes (ISO 639-1 and 639-2, including B codes such as 'ger') → ISO 639-1. The names come from
  // Intl.DisplayNames in the interface language ('swe' → 'Svenska' / 'Swedish'). 'und' = unknown language.
  const CODES = {
    sv: 'sv', swe: 'sv', en: 'en', eng: 'en', no: 'no', nor: 'no', nob: 'no', nb: 'no',
    da: 'da', dan: 'da', fi: 'fi', fin: 'fi', de: 'de', ger: 'de', deu: 'de', fr: 'fr',
    fre: 'fr', fra: 'fr', es: 'es', spa: 'es', it: 'it', ita: 'it', pt: 'pt',
    por: 'pt', nl: 'nl', dut: 'nl', nld: 'nl', pl: 'pl', pol: 'pl',
    ru: 'ru', rus: 'ru', tr: 'tr', tur: 'tr', ar: 'ar', ara: 'ar', fa: 'fa', per: 'fa',
    hi: 'hi', hin: 'hi', ja: 'ja', jpn: 'ja', ko: 'ko', kor: 'ko', zh: 'zh', chi: 'zh',
    zho: 'zh', el: 'el', gre: 'el', ell: 'el', he: 'he', heb: 'he', hu: 'hu',
    hun: 'hu', cs: 'cs', cze: 'cs', ces: 'cs', ro: 'ro', rum: 'ro', ron: 'ro',
    sr: 'sr', srp: 'sr', hr: 'hr', hrv: 'hr', bs: 'bs', bos: 'bs', is: 'is', ice: 'is',
    uk: 'uk', ukr: 'uk', th: 'th', tha: 'th', und: 'und'
  };
  let langNames = null;
  try { langNames = new Intl.DisplayNames([I18n.locale], { type: 'language' }); } catch (e) { /* old engine: the code is shown */ }

  // Languages that can be chosen as a fixed choice in the settings.
  const PREF_LANGS = ['swe', 'eng', 'nor', 'dan', 'fin'];

  const isoOf = (c) => CODES[c] || CODES[c.slice(0, 3)] || CODES[c.slice(0, 2)];

  function langName(code) {
    if (!code) return '';
    const iso = isoOf(String(code).toLowerCase().trim());
    if (iso === 'und') return tr('tracks.unknownLanguage');
    let name = '';
    try { name = iso && langNames ? langNames.of(iso) : ''; } catch (e) { /* invalid code */ }
    if (!name || name === iso) return String(code).toUpperCase();
    return name.charAt(0).toLocaleUpperCase(I18n.locale) + name.slice(1);
  }

  // Same language? Compare the codes ('swe' = 'sv'), not the names.
  function langCode(code) {
    const c = String(code).toLowerCase().trim();
    return isoOf(c) || c;
  }

  function channelsLabel(n) {
    n = Number(n);
    if (!n) return '';
    return n === 1 ? tr('tracks.mono') : n === 2 ? tr('tracks.stereo') : n === 6 ? '5.1' : n === 8 ? '7.1' : tr('tracks.channels', { n });
  }

  const CODECS = {
    ac3: 'Dolby Digital', 'ac-3': 'Dolby Digital', eac3: 'Dolby Digital+', 'e-ac-3': 'Dolby Digital+', 'ec-3': 'Dolby Digital+',
    truehd: 'Dolby TrueHD', dts: 'DTS', dtshd: 'DTS-HD', 'dts-hd': 'DTS-HD', aac: 'AAC', mp3: 'MP3', mp2: 'MP2', opus: 'Opus',
    flac: 'FLAC', pcm: 'PCM', vorbis: 'Vorbis'
  };
  function codecName(c) {
    if (!c) return '';
    const k = String(c).replace(/^(audio|video)\//, '').toLowerCase();
    return CODECS[k] || String(c).replace(/^(audio|video)\//, '').toUpperCase();
  }

  function trackLabel(t, i, kind) {
    const name = langName(t.language || t.lang) || (kind === 'audio' ? tr('tracks.audioTrackN', { n: i + 1 }) : tr('tracks.subtitleTrackN', { n: i + 1 }));
    const extra = [];
    if (t.codec && kind === 'audio') extra.push(codecName(t.codec));
    const ch = channelsLabel(t.channels || t.channel || t.numChannels);
    if (ch) extra.push(ch);
    if (kind === 'text' && t.type) extra.push(String(t.type).toUpperCase());
    const title = t.title || t.name || t.trackName || t.label || '';
    if (title && String(title).toLowerCase() !== String(name).toLowerCase()) extra.push(String(title));
    return { name, detail: extra.join(' · ') };
  }

  // Several tracks in the same language (e.g. ordinary subtitles and subtitles for the hard of hearing) cannot otherwise be told apart.
  function numberDuplicates(list) {
    const total = {};
    list.forEach((t) => { total[t.name] = (total[t.name] || 0) + 1; });
    const seen = {};
    list.forEach((t) => {
      if (total[t.name] < 2) return;
      seen[t.name] = (seen[t.name] || 0) + 1;
      t.name = t.name + ' ' + seen[t.name];
    });
    return list;
  }

  const T = { audio: [], text: [], audioSel: 0, textSel: -1, mediaId: '', source: '', badges: [], video: {}, sync: 0 };
  const listeners = [];
  const changed = () => listeners.forEach((fn) => { try { fn(T); } catch (e) { console.error(e); } });
  const prefKey = () => (P.kind() === 'live' ? 'live' : 'player');

  let ready = false;    // the stream is playing (then the TV accepts track choices)
  let applied = false;  // the language choice has been made for this stream
  let lifted = false;

  // --- Debugging: the latest events from the TV and the commands we have sent -----------------

  const log = [];
  let rawSource = null;
  function note(kind, data) {
    let text;
    try { text = JSON.stringify(data); } catch (e) { text = String(data); }
    log.push({ at: Date.now(), kind, data: text.length > 1500 ? text.slice(0, 1500) + '…' : text });
    if (log.length > 120) log.shift();
  }

  function resetTracks() {
    T.audio = [];
    T.text = [];
    T.audioSel = 0;
    T.textSel = -1;
    T.mediaId = '';
    T.source = '';
    T.badges = [];
    T.video = {};
    T.sync = 0;
    ready = applied = lifted = false;
  }

  // --- Picture info (4K, HDR, Dolby Vision, Atmos) -------------------------------------------------

  // The fields have different names in different events/firmware: look for known names a few levels down.
  function deepFind(o, names, depth) {
    if (!o || typeof o !== 'object' || (depth || 0) > 4) return undefined;
    const keys = Object.keys(o);
    for (let i = 0; i < keys.length; i++) {
      const v = o[keys[i]];
      if (names.indexOf(keys[i].toLowerCase()) >= 0 && v != null && typeof v !== 'object' && v !== '') return v;
    }
    for (let i = 0; i < keys.length; i++) {
      const v = deepFind(o[keys[i]], names, (depth || 0) + 1);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  function hdrLabel(v) {
    const s = String(v == null ? '' : v);
    if (/dolby/i.test(s)) return 'Dolby Vision';
    if (/hdr10\s*(\+|plus)/i.test(s)) return 'HDR10+';
    if (/hlg/i.test(s)) return 'HLG';
    if (/hdr/i.test(s)) return 'HDR10';
    return '';
  }

  function collectInfo(info) {
    const v = T.video;
    const w = Number(deepFind(info, ['width', 'videowidth']));
    const h = Number(deepFind(info, ['height', 'videoheight']));
    if (w > 0) v.width = w;
    if (h > 0) v.height = h;
    const hdr = hdrLabel(deepFind(info, ['hdrtype', 'hdr_type', 'hdr', 'dynamicrange', 'videorange']));
    if (hdr) v.hdr = hdr;
    const atmos = deepFind(info, ['isatmos', 'atmos', 'immersive', 'isdolbyatmos']);
    if (atmos === true || /^(true|atmos|on|1)$/i.test(String(atmos))) v.atmos = true;
    const vt = info.programInfo && info.programInfo[0] && info.programInfo[0].videoTrackInfo;
    const vcodec = vt && (Array.isArray(vt) ? vt[0] && vt[0].codec : vt.codec);
    if (vcodec) v.codec = String(vcodec).toUpperCase();
    buildBadges();
  }

  function buildBadges() {
    const v = T.video;
    const out = [];
    const w = v.width || video.videoWidth || 0;
    const h = v.height || video.videoHeight || 0;
    if (w >= 3800 || h >= 2000) out.push('4K');
    else if (w >= 1900 || h >= 1000) out.push('HD 1080');
    else if (w >= 1200 || h >= 700) out.push('HD 720');
    if (v.hdr) out.push(v.hdr);
    const a = T.audio[T.audioSel];
    if (v.atmos) out.push('Dolby Atmos');
    else if (a && a.detail) out.push(a.detail.replace(' · ', ' '));
    T.badges = out;
  }

  // --- Track lists -----------------------------------------------------------------------------

  // webOS: track lists and picture info from the media server (for what is playing right now, movie or live).
  video.addEventListener('umsmediainfo', (e) => {
    if (!P.current()) return;
    let d = null;
    try { d = typeof e.detail === 'string' ? JSON.parse(e.detail) : e.detail; } catch (x) { return; }
    if (!d) return;
    note('ums', d);
    if (d.mediaId) T.mediaId = d.mediaId;
    const info = d.info && typeof d.info === 'object' ? d.info : {};
    const prog = info.programInfo && info.programInfo[0];
    if (d.type === 'sourceInfo' && prog) {
      T.source = 'webos';
      T.audio = numberDuplicates((prog.audioTrackInfo || []).map((t, i) => Object.assign({ index: i }, trackLabel(t, i, 'audio'), { lang: t.language || '' })));
      T.text = numberDuplicates((prog.subtitleTrackInfo || []).map((t, i) => Object.assign({ index: i }, trackLabel(t, i, 'text'),
        { lang: t.language || '', kind: String(t.type || '').toLowerCase() })));
      annotate();
      rawSource = d; // the full message from the TV, for debugging (the log truncates it otherwise)
      collectInfo(info);
      maybeApply();
      changed();
    } else if (d.type === 'videoInfo' || d.type === 'audioInfo') {
      collectInfo(info);
      changed();
    }
  });

  // Browsers (and webOS if supported): audioTracks/textTracks.
  function readHtmlTracks() {
    if (T.source === 'webos') return;
    const at = video.audioTracks;
    const tt = video.textTracks;
    const audio = [];
    const text = [];
    if (at && at.length) {
      for (let i = 0; i < at.length; i++) {
        audio.push(Object.assign({ index: i }, trackLabel({ language: at[i].language, label: at[i].label }, i, 'audio'), { lang: at[i].language || '' }));
        if (at[i].enabled) T.audioSel = i;
      }
    }
    if (tt && tt.length) {
      for (let i = 0; i < tt.length; i++) {
        if (tt[i].kind !== 'subtitles' && tt[i].kind !== 'captions') continue;
        text.push(Object.assign({ index: i }, trackLabel({ language: tt[i].language, label: tt[i].label }, i, 'text'), { lang: tt[i].language || '' }));
        if (tt[i].mode === 'showing') T.textSel = i;
      }
    }
    if (audio.length || text.length) {
      T.source = 'html';
      T.audio = audio;
      T.text = text;
      buildBadges();
      maybeApply();
      changed();
    }
  }

  video.addEventListener('loadedmetadata', () => { if (P.current()) setTimeout(readHtmlTracks, 300); });

  // --- Commands ----------------------------------------------------------------------------------

  function mediaId() {
    return T.mediaId || video.mediaId || '';
  }

  // Command directly to the TV's video pipeline (webOS extension on <video>). true = received.
  function send(command, parameter) {
    let ok = false;
    let err = '';
    try {
      if (typeof video.send === 'function') ok = !!video.send(JSON.stringify({ command, parameter: parameter || {} }));
      else err = 'video.send missing';
    } catch (e) { err = e.message; }
    note('send', { command, parameter, ok, err });
    return ok;
  }

  function viaService(params) {
    if (!global.Root || !Root.media) return Promise.reject(new Error('Service missing'));
    const id = mediaId();
    if (!id) return Promise.reject(new Error('The video has no media id yet'));
    return Root.media(Object.assign({ mediaId: id }, params)).then((r) => { note('svc', { params, r }); return r; },
      (e) => { note('svc', { params, error: e.message }); throw e; });
  }

  function selectAudio(i, remember) {
    const t = T.audio[i];
    if (!t) return Promise.resolve();
    let p;
    if (T.source === 'html' && video.audioTracks) {
      for (let k = 0; k < video.audioTracks.length; k++) video.audioTracks[k].enabled = k === t.index;
      p = Promise.resolve();
    } else {
      p = viaService({ op: 'track', type: 'audio', index: t.index });
    }
    return p.then(() => {
      T.audioSel = i;
      if (remember && t.lang) Store.set(prefKey() + '.audioLang', t.lang.toLowerCase());
      buildBadges();
      changed();
    }, (e) => UI.toast(e.code === 'NOT_ROOT' ? tr('tracks.audioFailedRoot') : tr('tracks.audioFailed'), 4000));
  }

  // Can the track be drawn by the launcher itself (via the hub)? The hub's details about the track win; otherwise what
  // the TV says (an unknown type counts as text – most tracks in .mkv are).
  function overlayable(t) {
    if (!t || P.kind() !== 'vod' || !IPTV.subs || !IPTV.subs.usable()) return false;
    const info = IPTV.subs.trackInfo(t.index);
    if (info) return !!info.text;
    return !t.kind || t.kind === 'text';
  }

  let forced = null; // track to select again once the stream has restarted via the hub: { index, remember }

  function selectText(i, remember) {
    let p;
    const t = i >= 0 ? T.text[i] : null;
    if (T.source === 'html' && video.textTracks) {
      for (let k = 0; k < video.textTracks.length; k++) video.textTracks[k].mode = t && k === t.index ? 'showing' : 'disabled';
      p = Promise.resolve();
    } else if (!t) {
      if (IPTV.subs) IPTV.subs.hide();
      p = send('SetMediaSubtitleEnable', { enable: false }) ? Promise.resolve() : viaService({ op: 'subtitles', enable: false });
    } else if (overlayable(t)) {
      // The launcher's own subtitles. The TV's own are turned off so that the text is not shown twice.
      send('SetMediaSubtitleEnable', { enable: false });
      if (!P.proxied()) {
        // The file plays directly from the provider: switch to the hub's stream (same position). The stream restarts,
        // the track list arrives again and the choice is made then (maybeApply).
        forced = { index: t.index, remember: !!remember };
        if (P.viaProxy(IPTV.subs.proxyUrl())) return Promise.resolve();
        forced = null;
      }
      if (!IPTV.subs.show(t.index)) return selectNative(t, i, remember);
      p = Promise.resolve();
    } else {
      return selectNative(t, i, remember);
    }
    return p.then(() => {
      T.textSel = t ? i : -1;
      if (remember) Store.set(prefKey() + '.subLang', t ? (t.lang || 'on').toLowerCase() : 'off');
      changed();
    }, (e) => UI.toast(e.code === 'NOT_ROOT' ? tr('tracks.subtitlesFailedRoot') : tr('tracks.subtitlesFailed'), 4000));
  }

  // The TV's own subtitles (drawn by the TV).
  function selectNative(t, i, remember) {
    if (IPTV.subs) IPTV.subs.hide();
    const on = send('SetMediaSubtitleEnable', { enable: true });
    const picked = send('SetInternalSubtitle', { index: t.index });
    return Promise.resolve()
      .then(() => (picked ? null : viaService({ op: 'track', type: 'text', index: t.index })))
      .then(() => (on ? null : viaService({ op: 'subtitles', enable: true })))
      .then(() => {
        T.textSel = i;
        if (remember) Store.set(prefKey() + '.subLang', (t.lang || 'on').toLowerCase());
        applyStyle();
        changed();
      }, (e) => UI.toast(e.code === 'NOT_ROOT' ? tr('tracks.subtitlesFailedRoot') : tr('tracks.subtitlesFailed'), 4000));
  }

  // The hub's track list (codec, name, forced) makes the menu clearer: "ASS", "Image (PGS)", "Forced".
  const CODEC_LABEL = { srt: 'SRT', ass: 'ASS', ssa: 'SSA', vtt: 'WebVTT', pgs: tr('tracks.imageCodec', { codec: 'PGS' }),
    vobsub: tr('tracks.imageCodec', { codec: 'VobSub' }), dvb: tr('tracks.imageCodec', { codec: 'DVB' }) };
  function annotate() {
    if (!IPTV.subs) return;
    T.text.forEach((t) => {
      const info = IPTV.subs.trackInfo(t.index);
      if (!info) return;
      const parts = [CODEC_LABEL[info.codec] || String(info.codec || '').toUpperCase()];
      if (info.name && info.name.toLowerCase() !== langName(info.lang).toLowerCase()) parts.push(info.name);
      if (info.forced) parts.push(tr('tracks.forced'));
      t.detail = parts.filter(Boolean).join(' · ');
    });
  }
  IPTV.on('subs-tracks', () => { annotate(); changed(); });

  // --- Subtitle appearance (size, position, sync) ---------------------------------------------------

  // px = the text's height on a 1080 picture when the launcher draws it. lg = the nearest of the TV's five steps
  // (Very Small · Small · Normal · Big · Very Big, 0–4) when the TV draws it. On a G3 the TV's "Small" is about
  // 54 px and "Very Small" 41 px – the launcher's steps go considerably lower.
  const SIZES = [
    { v: 0, label: tr('tracks.size.smallest'), px: 28, lg: 0 }, { v: 1, label: tr('tracks.size.verySmall'), px: 34, lg: 0 },
    { v: 2, label: tr('tracks.size.small'), px: 40, lg: 0 }, { v: 3, label: tr('tracks.size.normal'), px: 48, lg: 1 },
    { v: 4, label: tr('tracks.size.large'), px: 58, lg: 2 }, { v: 5, label: tr('tracks.size.veryLarge'), px: 70, lg: 4 }
  ];
  // px = distance from the bottom edge of the picture (the launcher's text). v = the TV's value (−3…4, higher = higher up).
  const POSITIONS = [{ v: -2, label: tr('tracks.position.lower'), px: 36 }, { v: 0, label: tr('tracks.position.normal'), px: 72 },
    { v: 2, label: tr('tracks.position.higher'), px: 130 }, { v: 4, label: tr('tracks.position.highest'), px: 210 }];
  const LIFT_POSITION = 10; // like LG's player: the text moves up while the controls are showing

  function style() {
    const s = Store.get('player.sub') || {};
    return {
      size: SIZES.some((x) => x.v === s.size) ? s.size : 3,
      position: POSITIONS.some((x) => x.v === s.position) ? s.position : 0,
      box: !!s.box // dark plate behind the text (only the launcher's own subtitles)
    };
  }

  // The TV's own subtitles are active (not the launcher's).
  const subsActive = () => T.source === 'webos' && T.textSel >= 0 && !(IPTV.subs && IPTV.subs.active());

  function applyStyle() {
    if (IPTV.subs) IPTV.subs.refresh();
    if (!subsActive()) return;
    const s = style();
    const size = SIZES.find((x) => x.v === s.size) || SIZES[3];
    send('SetMediaSubtitleInfo', { fontSize: size.lg, position: lifted ? Math.max(s.position, LIFT_POSITION) : s.position });
  }

  function setStyle(patch) {
    Store.set('player.sub', Object.assign(style(), patch || {}));
    applyStyle();
    changed();
  }

  // Offset the text (seconds, + = later). Applies only to what is playing now.
  function setSync(sec) {
    T.sync = Math.max(-30, Math.min(30, Math.round(sec * 2) / 2));
    if (subsActive()) send('SetMediaSubtitleInfo', { sync: Math.round(T.sync * 1000) });
    changed();
  }

  function lift(on) {
    on = !!on;
    if (on === lifted) return;
    lifted = on;
    applyStyle();
  }

  // --- Language choice --------------------------------------------------------------------------

  const sameLang = (a, b) => !!a && !!b && langCode(a) === langCode(b);

  // 'last' = as last time (what you chose yourself in the player), otherwise a fixed choice.
  function wanted(kind) {
    const pref = Store.get(prefKey() + (kind === 'audio' ? '.audioPref' : '.subPref')) || 'last';
    if (pref !== 'last') return pref;
    return (Store.get(prefKey() + (kind === 'audio' ? '.audioLang' : '.subLang')) || '').toLowerCase();
  }

  // Done once per stream, when the track list exists and the stream is playing.
  function maybeApply() {
    if (applied || !ready || !T.source) return;
    applied = true;
    const al = wanted('audio');
    if (al && T.audio.length > 1) {
      const i = T.audio.findIndex((t) => sameLang(t.lang, al));
      if (i > 0 && i !== T.audioSel) selectAudio(i, false);
    }
    if (forced) {
      const f = forced;
      forced = null;
      const k = T.text.findIndex((t) => t.index === f.index);
      if (k >= 0) { selectText(k, f.remember); return; }
    }
    const sl = wanted('text');
    const i = sl && sl !== 'off' ? T.text.findIndex((t) => sameLang(t.lang, sl)) : -1;
    if (i >= 0) {
      if (i !== T.textSel) selectText(i, false);
    } else if (T.source === 'webos' && T.text.length) {
      // No subtitles should be shown: tell the TV, so that it does not show the file's first track on its own.
      send('SetMediaSubtitleEnable', { enable: false });
    }
  }

  // New stream (channel change, new episode, new attempt): the lists no longer apply.
  P.onState((s) => {
    if (s === 'loading' || s === 'stopped') {
      if (s === 'stopped') forced = null;
      resetTracks();
      changed();
    } else if (s === 'playing' && !ready) {
      ready = true;
      buildBadges();
      maybeApply();
      changed();
    }
  });

  IPTV.tracks = {
    state: () => T,
    selectAudio,
    selectText,
    langName,
    sizes: SIZES,
    positions: POSITIONS,
    prefLangs: PREF_LANGS,
    style,
    setStyle,
    setSync,
    lift,
    debug: () => ({ source: T.source, mode: P.sourceMode ? P.sourceMode() : '', mediaId: mediaId(), send: typeof video.send, audioSel: T.audioSel, textSel: T.textSel, audio: T.audio, text: T.text, video: T.video, style: style(), sourceInfo: rawSource, log: log.slice() }),
    // Send a command directly to the TV's video pipeline (debugging via npm run tv -- eval).
    send,
    onChange: (fn) => listeners.push(fn)
  };
})(window);
