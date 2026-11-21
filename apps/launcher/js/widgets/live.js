/* "Live now" — what is on right now on your favourite channels. */
(function () {
  'use strict';

  const esc = (s) => UI.esc(s);
  const nowCache = {}; // channel id -> { now, next }
  let fetching = false;

  function progress(p) {
    if (!p || !p.start || !p.end) return 0;
    return Math.max(0, Math.min(100, ((Date.now() - p.start) / (p.end - p.start)) * 100));
  }

  function load(channels) {
    if (fetching || !window.IPTV || !IPTV.configured()) return;
    fetching = true;
    Promise.all(channels.map((ch) => {
      let r;
      try { r = IPTV.epg.nowNext(ch); } catch (e) { return null; }
      if (r && typeof r.then === 'function') return r.then((v) => { nowCache[ch.id] = v; }, () => {});
      if (r && !r.pending) nowCache[ch.id] = r;
      return null;
    })).then(() => {
      fetching = false;
      Widgets.refresh('live');
    });
  }

  Widgets.register('live', {
    title: tr('liveWidget.title'),
    size: 2,
    render(face) {
      const chans = (window.IPTV && IPTV.favorites ? IPTV.favorites() || [] : []).slice(0, 3);
      if (!window.IPTV || !IPTV.configured()) {
        face.innerHTML = '<div class="wg wg-empty">' + Icons.svg('tv') + '<span>' + tr('liveWidget.setupIptv') + '</span></div>';
        return;
      }
      if (!chans.length) {
        face.innerHTML = '<div class="wg wg-empty">' + Icons.svg('star') + '<span>' + tr('liveWidget.starChannels') + '</span></div>';
        return;
      }
      const stale = chans.some((c) => !nowCache[c.id] || (nowCache[c.id].now && nowCache[c.id].now.end < Date.now()));
      if (stale) load(chans);

      face.innerHTML =
        '<div class="wg wg-live"><span class="wg-l-head"><i></i>' + tr('liveWidget.title') + '</span>' +
        chans.map((c) => {
          const r = nowCache[c.id] || {};
          const now = r.now;
          return '<div class="wg-l-row">' +
            (c.logo ? '<img src="' + esc(c.logo) + '" alt="">' : '<span class="wg-l-noimg">' + esc(c.name.slice(0, 3)) + '</span>') +
            '<span class="wg-l-text"><b>' + esc(now ? now.title : c.name) + '</b>' +
            '<span class="progress"><i style="--p:' + progress(now).toFixed(1) + '%"></i></span></span>' +
            '</div>';
        }).join('') +
        '</div>';
    },
    activate() {
      if (window.IPTV && IPTV.open) IPTV.open({ tab: 'live' });
    }
  });
})();
