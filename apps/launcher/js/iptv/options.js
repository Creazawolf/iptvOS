/*
 * IPTV.options — what can be adjusted while something is playing (live and movies):
 *
 *   IPTV.fit       picture format: 'contain' (Fit) · 'cover' (Fill screen) · 'fill' (Stretch)
 *   IPTV.sleep     sleep timer: turns the TV off (via the service) after N minutes, with a
 *                  one-minute warning where you can keep watching
 *   IPTV.screenOff()               turn the screen off but keep the sound (via the service)
 *   IPTV.options.tracksMenu()      audio and subtitles (menu)
 *   IPTV.options.menu(extra)       the Options menu (red button): audio/subtitles, picture format, timer + extra
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const P = IPTV.player;
  const video = P.video;

  // --- Picture format --------------------------------------------------------------------------

  const FITS = [
    { id: 'contain', label: tr('options.fit.contain'), detail: tr('options.fit.containDetail') },
    { id: 'cover', label: tr('options.fit.cover'), detail: tr('options.fit.coverDetail') },
    { id: 'fill', label: tr('options.fit.fill'), detail: tr('options.fit.fillDetail') }
  ];
  const fitOf = () => FITS.find((f) => f.id === Store.get('player.fit')) || FITS[0];

  function applyFit() {
    video.style.objectFit = fitOf().id;
  }

  const fit = {
    list: FITS,
    current: fitOf,
    set(id) {
      Store.set('player.fit', id);
      applyFit();
    }
  };
  applyFit();

  function fitMenu() {
    const cur = fitOf();
    UI.menu({
      title: tr('options.pictureFormat'),
      items: FITS.map((f) => ({
        label: (f.id === cur.id ? '✓  ' : '') + f.label,
        detail: f.detail,
        action: () => { fit.set(f.id); UI.toast(tr('options.pictureFormatSet', { name: f.label })); }
      }))
    });
  }

  // --- Sleep timer -----------------------------------------------------------------------------

  const SLEEP_CHOICES = [15, 30, 45, 60, 90, 120];
  const dec = new Intl.NumberFormat(I18n.locale, { maximumFractionDigits: 1 }); // 1,5 / 1.5
  const WARN_S = 60;
  const sl = { until: 0, timer: null, warn: null, countdown: null };

  function powerOff() {
    try { P.stop(); } catch (e) { /* ignore */ }
    if (global.Root && Root.power) {
      Root.power('off').catch((e) => UI.toast(tr('options.powerOffFailed', { error: e.message }), 5000));
    } else {
      UI.toast(tr('options.sleepStopped'), 5000);
    }
  }

  function clearSleep() {
    clearTimeout(sl.timer);
    clearInterval(sl.countdown);
    sl.until = 0;
    sl.timer = null;
    sl.countdown = null;
    if (sl.warn && !sl.warn.closed && UI.close) UI.close(sl.warn);
    sl.warn = null;
  }

  function setSleep(min) {
    clearSleep();
    if (!min) return;
    sl.until = Date.now() + min * 60000;
    sl.timer = setTimeout(warn, Math.max(0, min * 60000 - WARN_S * 1000));
  }

  // One minute left: ask. No answer = off.
  function warn() {
    let left = WARN_S;
    const sub = () => tr('options.offInSeconds', { n: left });
    sl.warn = UI.menu({
      title: tr('options.sleepTimer'),
      subtitle: sub(),
      items: [
        { label: tr('options.keepWatching'), detail: tr('options.moreMinutes', { n: 30 }), action: () => setSleep(30) },
        { label: tr('options.turnOffTimer'), action: () => clearSleep() },
        { label: tr('options.turnOffNow'), danger: true, action: () => { clearSleep(); powerOff(); } }
      ]
    });
    // Back (or any button that closes the box) = someone is watching: timer off.
    sl.warn.onCancel = () => { clearSleep(); UI.toast(tr('options.sleepOff')); };
    sl.countdown = setInterval(() => {
      left--;
      const el = sl.warn && sl.warn.el && sl.warn.el.querySelector('.sheet-sub');
      if (el) el.textContent = sub();
      if (left <= 0) {
        clearSleep();
        powerOff();
      }
    }, 1000);
  }

  // The timer and the warning live in the launcher. If you leave it (another app), nobody can see or answer
  // the warning – and the video here has stopped anyway. Then the timer is turned off, and you are told.
  let stoppedByHide = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (sl.until) {
        clearSleep();
        stoppedByHide = true;
      }
    } else if (stoppedByHide) {
      stoppedByHide = false;
      setTimeout(() => UI.toast(tr('options.sleepOffLeft'), 5000), 600);
    }
  });

  const sleepLeft = () => Math.max(1, Math.round((sl.until - Date.now()) / 60000));

  function sleepLabel() {
    if (!sl.until) return tr('common.off');
    return tr('options.minutesLeft', { n: sleepLeft() });
  }

  function sleepMenu() {
    UI.menu({
      title: tr('options.sleepTimer'),
      subtitle: sl.until ? tr('options.offInMinutes', { n: sleepLeft() }) : tr('options.sleepHint'),
      items: [{ label: (sl.until ? '' : '✓  ') + tr('common.off'), action: () => { clearSleep(); UI.toast(tr('options.sleepOff')); } }]
        .concat(SLEEP_CHOICES.map((m) => ({
          label: m < 60 ? tr('common.minutes', { n: m }) : tr('options.hours', { n: m / 60, h: dec.format(m / 60) }),
          action: () => { setSleep(m); UI.toast(tr('options.offInMinutes', { n: m })); }
        })))
    });
  }

  // --- Screen off (the sound continues) --------------------------------------------------------------

  function screenOff() {
    if (!TV.isTV) { UI.toast(tr('options.screenOffPreview')); return; }
    if (!global.Root || !Root.screen) return;
    UI.toast(tr('options.screenOffHint'), 2500);
    setTimeout(() => {
      Root.screen('off').catch((e) => UI.toast(tr('options.screenOffFailed', { error: e.message }), 5000));
    }, 900);
  }

  // --- Audio and subtitles (menu, for live) ---------------------------------------------------------

  function tracksMenu() {
    const T = IPTV.tracks.state();
    if (T.audio.length <= 1 && !T.text.length) {
      UI.toast(P.state() === 'loading' ? tr('options.loadingTracks') : tr('options.noTracks'), 3500);
      return;
    }
    const items = [];
    T.audio.forEach((t, i) => items.push({
      label: (i === T.audioSel ? '✓  ' : '') + tr('options.audioTrack', { name: t.name }),
      detail: t.detail || '',
      action: () => IPTV.tracks.selectAudio(i, true).then(() => UI.toast(tr('options.audioTrack', { name: t.name })))
    }));
    items.push({
      label: (T.textSel < 0 ? '✓  ' : '') + tr('options.subtitlesTrack', { name: tr('common.off') }),
      action: () => IPTV.tracks.selectText(-1, true)
    });
    T.text.forEach((t, i) => items.push({
      label: (i === T.textSel ? '✓  ' : '') + tr('options.subtitlesTrack', { name: t.name }),
      detail: t.detail || '',
      action: () => IPTV.tracks.selectText(i, true).then(() => UI.toast(tr('options.subtitlesTrack', { name: t.name })))
    }));
    UI.menu({ title: tr('options.audioAndSubtitles'), items });
  }

  // --- Options (red button) --------------------------------------------------------------------------

  function menu(opts) {
    opts = opts || {};
    UI.menu({
      title: opts.title || tr('options.title'),
      subtitle: opts.subtitle || '',
      items: (opts.before || []).concat([
        { label: tr('options.audioAndSubtitles'), action: tracksMenu },
        { label: tr('options.pictureFormat'), detail: fitOf().label, action: fitMenu },
        { label: tr('options.sleepTimer'), detail: sleepLabel(), action: sleepMenu },
        { label: tr('options.screenOff'), detail: tr('options.screenOffDetail'), action: screenOff }
      ], opts.after || [])
    });
  }

  IPTV.fit = fit;
  IPTV.sleep = { set: setSleep, clear: clearSleep, label: sleepLabel, active: () => !!sl.until };
  IPTV.screenOff = screenOff;
  IPTV.options = { menu, tracksMenu, fitMenu, sleepMenu };
})(window);
