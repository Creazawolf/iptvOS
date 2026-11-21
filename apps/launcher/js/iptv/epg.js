/*
 * IPTV.epg — "now and next" per channel. Fetched in batches via the source (the hub: up to 50 channels
 * per request; direct mode: get_short_epg with at most four requests at a time) and cached for ~10 min.
 *
 *   IPTV.epg.nowNext(channel)  -> { now, next, pending }  (synchronous, latest known)
 *                                 The object can also be awaited: .then(({ now, next }) => …)
 *   IPTV.epg.peek(channel)     -> { now, next } | null   (cache only, no fetching)
 *   IPTV.epg.want([channels])  -> prefetch (e.g. visible rows)
 *   IPTV.epg.progress(programme) -> 0..1      IPTV.epg.time(ms) -> '20:00'
 *   IPTV.on('epg', fn(ids))  when new data has arrived
 *
 * programme = { title, desc, start, end }  (ms)
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const TTL = 10 * 60 * 1000;
  const FAIL_TTL = 2 * 60 * 1000;
  const BATCH = 50;
  const MAX = 2000; // channels in the cache (oldest out first)

  const cache = {};   // id -> { at, ttl, now, next }
  const waiting = {}; // id -> [resolve]
  let queue = [];
  let flushTimer = null;
  let inflight = 0;

  function current(e) {
    if (!e) return null;
    const t = Date.now();
    let now = e.now;
    let next = e.next;
    // The programme has ended: move "next" forward until we have new data.
    if (now && now.end <= t) {
      now = next && next.start <= t && next.end > t ? next : null;
      next = null;
    }
    return { now, next };
  }

  function fresh(e) {
    if (!e) return false;
    if (Date.now() - e.at > e.ttl) return false;
    if (e.ttl === FAIL_TTL) return true;
    return !(e.now && e.now.end <= Date.now() && !(e.next && e.next.end > Date.now()));
  }

  function resolveIds(ids) {
    ids.forEach((id) => {
      const list = waiting[id];
      delete waiting[id];
      const r = current(cache[id]) || { now: null, next: null };
      (list || []).forEach((fn) => fn(r));
    });
  }

  // Keep the cache bounded (you can browse through thousands of channels in an evening).
  function trim() {
    const keys = Object.keys(cache);
    if (keys.length <= MAX) return;
    keys.sort((a, b) => cache[a].at - cache[b].at);
    keys.slice(0, keys.length - MAX * 0.8).forEach((k) => { if (!waiting[k]) delete cache[k]; });
  }

  function flush() {
    flushTimer = null;
    if (!queue.length || !IPTV.source) return;
    // Most recently requested first – that is what is on screen now.
    const ids = queue.splice(Math.max(0, queue.length - BATCH), BATCH).reverse();
    inflight++;
    IPTV.source.epg(ids).then((map) => {
      const at = Date.now();
      ids.forEach((id) => {
        const r = map && map[id];
        cache[id] = r ? { at, ttl: TTL, now: r.now || null, next: r.next || null } : { at, ttl: FAIL_TTL, now: null, next: null };
      });
    }, () => {
      const at = Date.now();
      ids.forEach((id) => { cache[id] = { at, ttl: FAIL_TTL, now: null, next: null }; });
    }).then(() => {
      inflight--;
      trim();
      resolveIds(ids);
      IPTV.emit('epg', ids);
      if (queue.length) schedule();
    });
  }

  function schedule() {
    if (!flushTimer) flushTimer = setTimeout(flush, inflight ? 120 : 40);
  }

  function enqueue(id) {
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    queue.push(id);
    // Long queue (fast scrolling): drop the oldest.
    if (queue.length > 160) {
      const dropped = queue.splice(0, queue.length - 160);
      resolveIds(dropped.filter((d) => waiting[d]));
    }
    schedule();
  }

  function thenable(o, promise) {
    Object.defineProperty(o, 'then', {
      value: (a, b) => (promise || Promise.resolve({ now: o.now, next: o.next })).then(a, b),
      enumerable: false
    });
    return o;
  }

  function nowNext(ch) {
    if (!ch || ch.id == null) return thenable({ now: null, next: null, pending: false });
    const id = String(ch.id);
    const e = cache[id];
    const r = current(e);
    if (fresh(e)) return thenable({ now: r.now, next: r.next, pending: false });
    const promise = new Promise((resolve) => { (waiting[id] = waiting[id] || []).push(resolve); });
    enqueue(id);
    return thenable({ now: r ? r.now : null, next: r ? r.next : null, pending: true }, promise);
  }

  function peek(ch) {
    return ch ? current(cache[String(ch.id)]) : null;
  }

  function want(list) {
    (list || []).forEach((ch) => {
      if (ch && ch.id != null && !fresh(cache[String(ch.id)])) enqueue(String(ch.id));
    });
  }

  function progress(p) {
    if (!p || !p.end) return 0;
    return Math.min(1, Math.max(0, (Date.now() - p.start) / (p.end - p.start)));
  }

  function clear() {
    Object.keys(cache).forEach((k) => delete cache[k]);
    queue = [];
  }

  IPTV.epg = { nowNext, peek, want, progress, time: IPTV.u.time, clear };
})(window);
