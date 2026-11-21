/*
 * nav.js — spatial navigation for the remote (arrows + OK) and the Magic Remote pointer.
 *
 * Mark focusable elements with  data-focusable  and listen for (bubbling) events:
 *   nav:focus      the element received focus
 *   nav:activate   the OK button (short press) or a click
 *   nav:longpress  OK is held down (~0.6 s)
 *
 * Scrolling:
 *   <div data-scroll-viewport><div data-scroll-track data-scroll-edge="96"> … </div></div>    (horizontal)
 *   <div data-vscroll-viewport><div data-vscroll-track data-scroll-edge="120"> … </div></div> (vertical)
 *
 * Layers (menus/dialogs):  Nav.pushScope(el)  confines focus to el,  Nav.popScope()  restores it.
 * Keys:  Nav.onKey(fn)  — fn(name, event) runs before the default handling; return true if handled.
 *
 * Requires tv.js (TV.keyName).
 */
(function (global) {
  'use strict';

  const SELECTOR = '[data-focusable]';
  const ARROWS = { left: 1, right: 1, up: 1, down: 1 };
  const LONGPRESS_MS = 600;

  let current = null;
  let enabled = true;
  let interceptor = null;
  let lastActivate = 0;
  let pointerActive = false;
  let enterTimer = null;
  let enterLong = false;
  let enterDown = false;
  const scopes = []; // { el, restore }
  let base = null;   // active view (Nav.setRoot) – otherwise the whole document

  const scopeRoot = () => (scopes.length ? scopes[scopes.length - 1].el : base && base.isConnected ? base : document);

  function isVisible(el) {
    if (el.disabled || el.closest('[hidden], [inert], .is-hidden')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Elements in hidden subtrees (e.g. other tabs) are already filtered out by the selector.
  const VISIBLE_SELECTOR = SELECTOR + ':not([hidden]):not([hidden] *)';

  function focusables() {
    return Array.prototype.filter.call(scopeRoot().querySelectorAll(VISIBLE_SELECTOR), isVisible);
  }

  function inScope(el) {
    const root = scopeRoot();
    return root === document || root.contains(el);
  }

  // Fast path for ◀ ▶ within a row (data-scroll-track): the neighbour in the row directly, without measuring the whole page.
  // undefined = no neighbour (end of row) → regular search.
  function trackNeighbor(from, dir) {
    if (dir !== 'left' && dir !== 'right') return undefined;
    const item = from.closest('[data-scroll-track] > *');
    if (!item || item.closest('[data-nav-lock]') !== from.closest('[data-nav-lock]')) return undefined;
    const step = (n) => (dir === 'right' ? n.nextElementSibling : n.previousElementSibling);
    for (let n = step(item); n; n = step(n)) {
      if (n.hidden) continue;
      const f = n.matches(SELECTOR) ? n : n.querySelector(SELECTOR);
      if (f && !f.disabled && inScope(f)) return f;
    }
    return undefined;
  }

  function center(r) {
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // Is the candidate entirely on the correct side of the origin's centre?
  // (Edge-based, so that an enlarged/raised focused element does not fool the logic.)
  function inDirection(r, fc, dir) {
    if (dir === 'right') return r.left >= fc.x;
    if (dir === 'left') return r.right <= fc.x;
    if (dir === 'down') return r.top >= fc.y;
    return r.bottom <= fc.y;
  }

  // Find the nearest candidate in a direction.
  // Horizontal: prefer elements on the same row. Vertical: nearest row first,
  // then the element that lies most directly above/below.
  function findNext(from, dir) {
    const near = trackNeighbor(from, dir);
    if (near) return near;
    const fr = from.getBoundingClientRect();
    const fc = center(fr);
    const horizontal = dir === 'left' || dir === 'right';
    const sign = dir === 'right' || dir === 'down' ? 1 : -1;

    // Groups with data-nav-lock="left right" lock navigation in those directions, e.g. a list
    // that should not be left to the right.
    const group = from.closest('[data-nav-lock]');
    if (group && group.getAttribute('data-nav-lock').split(' ').indexOf(dir) !== -1) {
      // Only the group's elements are measured (not the whole view).
      const inGroup = Array.prototype.filter.call(group.querySelectorAll(VISIBLE_SELECTOR), (el) => inScope(el) && isVisible(el));
      return pick(inGroup);
    }
    return pick(focusables());

    function pick(list) {
      const cands = [];
      list.forEach((el) => {
        if (el === from) return;
        const r = el.getBoundingClientRect();
        if (!inDirection(r, fc, dir)) return;
        const c = center(r);
        cands.push({
          el,
          primary: (horizontal ? c.x - fc.x : c.y - fc.y) * sign,
          secondary: horizontal ? Math.abs(c.y - fc.y) : Math.abs(c.x - fc.x),
          overlaps: horizontal
            ? r.top < fr.bottom && r.bottom > fr.top
            : r.left < fr.right && r.right > fr.left
        });
      });
      if (!cands.length) return null;

      let pool;
      if (horizontal) {
        const sameLine = cands.filter((c) => c.overlaps);
        pool = sameLine.length ? sameLine : cands;
        pool.sort((a, b) => a.primary + a.secondary * 3 - (b.primary + b.secondary * 3));
      } else {
        const nearest = Math.min.apply(null, cands.map((c) => c.primary));
        const band = Math.max(24, fr.height * 0.5);
        pool = cands.filter((c) => c.primary <= nearest + band);
        // Remember the last focus in the row we are moving to, if there is one.
        const remembered = pool.filter((c) => c.el.hasAttribute('data-last-focus'));
        if (remembered.length && remembered[0].el.closest('[data-remember-focus]')) return remembered[0].el;
        pool.sort((a, b) => a.secondary - b.secondary);
      }
      return pool[0].el;
    }
  }

  // Scroll a track (horizontal or vertical) so the element is visible. Uses transform
  // (smooth on the TV) and measures the track's direct children so focus scaling has no effect.
  function revealIn(el, trackSel, vertical) {
    const item = el.closest(trackSel + ' > *');
    if (!item) return;
    const track = item.parentElement;
    const viewport = track.parentElement;
    const size = vertical ? viewport.clientHeight : viewport.clientWidth;
    const edge = parseFloat(track.getAttribute('data-scroll-edge') || '0');
    let offset = parseFloat(track.dataset.offset || '0');

    const start = vertical ? item.offsetTop : item.offsetLeft;
    const end = start + (vertical ? item.offsetHeight : item.offsetWidth);
    if (start - edge < offset) offset = start - edge;
    else if (end + edge > offset + size) offset = end + edge - size;

    const total = vertical ? track.scrollHeight : track.scrollWidth;
    offset = Math.min(Math.max(0, offset), Math.max(0, total - size));
    track.dataset.offset = String(offset);
    track.style.transform = vertical
      ? 'translate3d(0,' + -offset + 'px,0)'
      : 'translate3d(' + -offset + 'px,0,0)';
  }

  function reveal(el) {
    revealIn(el, '[data-scroll-track]', false);
    revealIn(el, '[data-vscroll-track]', true);
  }

  function focus(el, opts) {
    if (!el) return;
    opts = opts || {};
    if (el === current && !opts.force) return;
    const prev = current;
    if (prev) prev.classList.remove('is-focused');
    current = el;
    el.classList.add('is-focused');

    // Remember the most recently focused element per row.
    const row = el.closest('[data-remember-focus]');
    if (row) {
      const old = row.querySelector('[data-last-focus]');
      if (old && old !== el) old.removeAttribute('data-last-focus');
      el.setAttribute('data-last-focus', '');
    }

    if (!opts.fromPointer) reveal(el);
    el.dispatchEvent(new CustomEvent('nav:focus', { bubbles: true, detail: { prev, dir: opts.dir || null } }));
  }

  // "Can't go any further": a small sideways bounce. Web Animations (the translate property is applied
  // on top of the element's transform) – no class to restart, so no forced layout.
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
  function bumpEl(el, dir) {
    const d = dir === 'left' ? -10 : dir === 'right' ? 10 : 0;
    if (!el || !d || typeof el.animate !== 'function') return;
    if (el._bump) el._bump.cancel();
    el._bump = el.animate([{ translate: '0 0' }, { translate: d + 'px 0' }, { translate: '0 0' }], { duration: 260, easing: EASE });
  }

  function bump(dir) {
    bumpEl(current, dir);
  }

  function first() {
    const root = scopeRoot();
    return root.querySelector('[data-autofocus]:not([hidden]):not([hidden] *)') || focusables()[0] || null;
  }

  function move(dir) {
    if (!current || !isVisible(current) || !inScope(current)) {
      focus(first());
      return;
    }
    const next = findNext(current, dir);
    if (next) focus(next, { dir });
    else bump(dir);
  }

  function activate(el) {
    // The Magic Remote can send both a click and an OK key for the same press.
    const now = Date.now();
    if (!el || now - lastActivate < 350) return;
    lastActivate = now;
    el.dispatchEvent(new CustomEvent('nav:activate', { bubbles: true }));
  }

  const isInput = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

  function onKeyDown(e) {
    pointerActive = false;
    const name = global.TV.keyName(e);

    // Text fields with real focus: the keyboard owns everything except Enter, Back
    // and arrow up/down (on the TV also left/right, since the cursor is controlled by the TV's keyboard).
    if (isInput(document.activeElement)) {
      const code = e.keyCode;
      const commit = code === 13 ? 'enter' : code === 461 || code === 27 ? 'back' : null;
      if (commit) {
        e.preventDefault();
        document.activeElement.dispatchEvent(new CustomEvent('nav:commit', { bubbles: true, detail: { key: commit } }));
        document.activeElement.blur();
        return;
      }
      const leaves = code === 38 || code === 40 || (global.TV.isTV && (code === 37 || code === 39));
      if (!leaves) return;
      document.activeElement.blur();
    }

    if (interceptor && interceptor(name, e) === true) {
      e.preventDefault();
      return;
    }
    if (!enabled || !name) return;

    if (ARROWS[name]) {
      e.preventDefault();
      move(name);
    } else if (name === 'enter') {
      e.preventDefault();
      if (e.repeat || enterDown) return;
      enterDown = true;
      enterLong = false;
      clearTimeout(enterTimer);
      const target = current;
      enterTimer = setTimeout(() => {
        enterLong = true;
        if (target && target === current) {
          target.dispatchEvent(new CustomEvent('nav:longpress', { bubbles: true }));
        }
      }, LONGPRESS_MS);
    }
  }

  function onKeyUp(e) {
    const name = global.TV.keyName(e);
    if (name !== 'enter' || !enterDown) return;
    enterDown = false;
    clearTimeout(enterTimer);
    if (!enterLong && enabled) activate(current);
    enterLong = false;
  }

  function init() {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    // The pointer only takes focus when it actually moves – not when a row
    // scrolls in under a stationary pointer.
    const pointerFocus = (e) => {
      if (!enabled || !pointerActive) return;
      const el = e.target.closest && e.target.closest(SELECTOR);
      if (el && inScope(el)) focus(el, { fromPointer: true });
    };
    document.addEventListener('mousemove', (e) => {
      if (e.movementX || e.movementY) pointerActive = true;
      pointerFocus(e);
    });
    document.addEventListener('mouseover', pointerFocus);

    document.addEventListener('click', (e) => {
      if (!enabled) return;
      const el = e.target.closest && e.target.closest(SELECTOR);
      if (el && inScope(el)) {
        focus(el, { fromPointer: true });
        activate(el);
      }
    });

    focus(first());
  }

  function pushScope(el, opts) {
    scopes.push({ el, restore: current });
    const target = (opts && opts.focus) || el.querySelector('[data-autofocus]') || focusables()[0];
    if (target) focus(target, { force: true });
  }

  function popScope() {
    const s = scopes.pop();
    if (s && s.restore && document.contains(s.restore)) focus(s.restore, { force: true });
    else if (!current || !document.contains(current) || !isVisible(current)) focus(first());
  }

  global.Nav = {
    init,
    focus,
    move,
    reveal,
    bump: bumpEl,
    ease: EASE,
    first,
    pushScope,
    popScope,
    current: () => current,
    // Confine navigation to an element (the visible view) when no layer is open.
    setRoot: (el) => { base = el || null; },
    setEnabled: (on) => { enabled = !!on; },
    // Intercept keys before the default handling. Return true if you handled it.
    onKey: (fn) => { interceptor = fn; }
  };
})(window);
