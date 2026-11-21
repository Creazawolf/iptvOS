/*
 * Perf — measurement points for  npm run tv -- perf  (read over the TV's remote debugging) and  npm run test:ui.
 * Costs almost nothing: a few timestamps and one rAF per key press.
 *
 *   Perf.mark('home')                 the first time something happened (ms since the page started loading)
 *   Perf.zap.start(url, kind) / .end()   channel change/movie: from play() to the first frame
 *   Perf.report()                     { boot, keys, zap, memory, dom, longTasks }
 */
(function (global) {
  'use strict';

  const ZAP_KEY = 'g3:perf:zap:v1';
  const marks = {};
  const keys = [];        // ms from keydown to the next frame (last 300)
  let longTasks = 0;
  let longTaskMs = 0;

  const now = () => Math.round(performance.now());
  function mark(name) {
    if (marks[name] == null) marks[name] = now();
  }

  // --- Key press → next frame ---------------------------------------------------------------------
  // The listener is on window (bubbles last), so the time covers all handling of the press.
  global.addEventListener('keydown', (e) => {
    // (The frame's own timestamp can be earlier than the press – measure with the clock when it runs.)
    const t0 = e.timeStamp;
    requestAnimationFrame(() => {
      keys.push(Math.max(0, Math.round(performance.now() - t0)));
      if (keys.length > 300) keys.shift();
    });
  });

  try {
    new PerformanceObserver((list) => {
      list.getEntries().forEach((e) => { longTasks++; longTaskMs += e.duration; });
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { /* not supported */ }

  // --- Channel change / movie start ---------------------------------------------------------------

  let zapLog = [];
  try { zapLog = JSON.parse(localStorage.getItem(ZAP_KEY)) || []; } catch (e) { zapLog = []; }
  let pending = null;

  const formatOf = (url) => {
    const m = /\.(m3u8|ts|mp4|mkv|avi)(\?|$)/i.exec(String(url || ''));
    return m ? m[1].toLowerCase() : 'annat';
  };

  const zap = {
    start(url, kind) {
      pending = { t: performance.now(), fmt: formatOf(url), kind: kind || 'live' };
    },
    end() {
      if (!pending) return;
      const ms = Math.round(performance.now() - pending.t);
      zapLog.push({ fmt: pending.fmt, kind: pending.kind, ms, at: Date.now() });
      pending = null;
      if (zapLog.length > 200) zapLog = zapLog.slice(-200);
      try { localStorage.setItem(ZAP_KEY, JSON.stringify(zapLog)); } catch (e) { /* full */ }
    },
    cancel() { pending = null; }
  };

  // --- Report ---------------------------------------------------------------------------------------

  function stats(list) {
    if (!list.length) return null;
    const s = list.slice().sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, p50: q(0.5), p90: q(0.9), max: s[s.length - 1] };
  }

  function report() {
    const nav = (performance.getEntriesByType('navigation') || [])[0] || {};
    const paint = {};
    (performance.getEntriesByType('paint') || []).forEach((p) => { paint[p.name] = Math.round(p.startTime); });
    const byFmt = {};
    zapLog.forEach((z) => {
      const k = z.kind + ' ' + z.fmt;
      (byFmt[k] = byFmt[k] || []).push(z.ms);
    });
    const zapOut = {};
    Object.keys(byFmt).forEach((k) => { zapOut[k] = stats(byFmt[k]); });
    const mem = performance.memory || {};
    return {
      at: new Date().toISOString(),
      boot: Object.assign({
        domContentLoaded: nav.domContentLoadedEventEnd ? Math.round(nav.domContentLoadedEventEnd) : null,
        load: nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
        firstPaint: paint['first-paint'] || null,
        firstContentfulPaint: paint['first-contentful-paint'] || null
      }, marks),
      keys: stats(keys),
      zap: zapOut,
      longTasks: { n: longTasks, ms: Math.round(longTaskMs) },
      memory: mem.usedJSHeapSize ? { usedMB: Math.round(mem.usedJSHeapSize / 1048576), totalMB: Math.round(mem.totalJSHeapSize / 1048576) } : null,
      dom: document.getElementsByTagName('*').length,
      scripts: document.scripts.length
    };
  }

  mark('perf');
  global.Perf = { mark, zap, report, clearZap() { zapLog = []; try { localStorage.removeItem(ZAP_KEY); } catch (e) { /* */ } } };
})(window);
