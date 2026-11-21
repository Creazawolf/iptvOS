/*
 * Router — a stack of full-screen views (home, TV, settings).
 *
 *   Router.register('settings', {
 *     el,                       // <section data-view="settings">
 *     show(params) {},          // the view is shown (the first time or via go())
 *     resume() {},              // the view is shown again after back()
 *     hide() {},                // the view is hidden
 *     onKey(name, e) {}         // return true if the key was handled
 *   });
 *   Router.go('settings', params) / Router.back() / Router.home()
 *   Router.on((name) => …)   // called when a new view is shown
 */
(function (global) {
  'use strict';

  const views = {};
  const stack = []; // [{ name, params, focus }]
  const listeners = [];
  const emit = () => { const t = top(); listeners.forEach((fn) => { try { fn(t ? t.name : null); } catch (e) { console.error(e); } }); };

  function register(name, view) {
    view.name = name;
    views[name] = view;
    if (view.el) view.el.hidden = true;
  }

  const top = () => stack[stack.length - 1] || null;
  const topView = () => (top() ? views[top().name] : null);

  function hideTop() {
    const t = top();
    if (!t) return;
    const v = views[t.name];
    t.focus = Nav.current();
    if (v.hide) v.hide();
    if (v.el) v.el.hidden = true;
  }

  function showEntry(entry, resumed) {
    const v = views[entry.name];
    if (v.el) v.el.hidden = false;
    // Navigation only searches the visible view (faster, and focus cannot end up in a hidden one).
    if (Nav.setRoot) Nav.setRoot(v.el || null);
    document.body.setAttribute('data-view', entry.name);
    emit();
    if (resumed && v.resume) v.resume(entry.params);
    else if (v.show) v.show(entry.params || {});
    requestAnimationFrame(() => {
      const target = resumed && entry.focus && v.el && v.el.contains(entry.focus) ? entry.focus : null;
      if (target) Nav.focus(target, { force: true });
      else if (v.el && !(Nav.current() && v.el.contains(Nav.current()))) {
        Nav.focus(v.el.querySelector('[data-autofocus]') || v.el.querySelector('[data-focusable]'), { force: true });
      }
    });
  }

  function go(name, params) {
    if (!views[name]) throw new Error('Unknown view: ' + name);
    const t = top();
    if (t && t.name === name) {
      t.params = params || {};
      const v = views[name];
      if (v.show) v.show(t.params);
      return;
    }
    hideTop();
    const entry = { name, params: params || {}, focus: null };
    stack.push(entry);
    showEntry(entry, false);
  }

  function back() {
    if (stack.length <= 1) return false;
    const t = stack.pop();
    const v = views[t.name];
    if (v.hide) v.hide();
    if (v.el) v.el.hidden = true;
    showEntry(top(), true);
    return true;
  }

  function home() {
    while (stack.length > 1) back();
  }

  global.Router = { register, go, back, home, top, topView, views, on: (fn) => listeners.push(fn) };
})(window);
