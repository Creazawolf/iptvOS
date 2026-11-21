/*
 * Widget registry. A widget is a card in the home screen's widget row.
 *
 *   Widgets.register('name', {
 *     title: 'Shown in settings',
 *     size: 1 | 2,               // width in "app tiles"
 *     render(face) {},           // fill the card's face (called again on refresh)
 *     activate() {}              // optional: OK on the card
 *   });
 *
 * Widgets.refresh('name') redraws all cards of that type (e.g. when new data has arrived).
 * All cards are also redrawn every 30 seconds.
 */
(function (global) {
  'use strict';

  const registry = {};
  let mounted = []; // [{ el, id }]

  function register(id, def) {
    def.id = id;
    registry[id] = def;
  }

  function renderOne(m) {
    const def = registry[m.id];
    if (!def) return;
    try { def.render(m.el); } catch (e) { console.error('[widget]', m.id, e); }
  }

  function mount(el, id) {
    const m = { el, id };
    mounted.push(m);
    renderOne(m);
  }

  function prune() {
    mounted = mounted.filter((m) => document.contains(m.el));
  }

  function refresh(id) {
    prune();
    mounted.forEach((m) => { if (!id || m.id === id) renderOne(m); });
  }

  setInterval(() => { if (!document.hidden) refresh(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  global.Widgets = {
    register,
    mount,
    refresh,
    get: (id) => registry[id] || null,
    list: () => Object.keys(registry).map((id) => registry[id])
  };
})(window);
