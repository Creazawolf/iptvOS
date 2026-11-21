/*
 * UI — small shared components: toast, menu (action sheet), text dialog and confirmation.
 *
 *   UI.toast('Saved')
 *   UI.menu({ title, items: [{ label, detail?, danger?, action() }], stacked? })   stacked: the explanation below the label (wraps)
 *   UI.prompt({ title, label, value, type: 'text'|'password'|'url' }) -> Promise<string|null>
 *   UI.confirm({ title, message, ok: 'Remove' }) -> Promise<boolean>
 *   UI.esc(text)  // HTML-escape
 */
(function (global) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');

  let toastTimer;
  function toast(msg, ms) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), ms || 3200);
  }

  // Stack of open layers; the topmost gets the keys first.
  const layers = [];

  function openLayer(html, cls, onKey) {
    const host = document.getElementById('overlays');
    const el = document.createElement('div');
    el.className = 'layer ' + (cls || '');
    el.innerHTML = '<div class="layer-scrim"></div><div class="layer-body">' + html + '</div>';
    host.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-on')));
    const layer = { el, onKey, closed: false };
    layers.push(layer);
    Nav.pushScope(el.querySelector('.layer-body'));
    return layer;
  }

  function closeLayer(layer) {
    if (layer.closed) return;
    layer.closed = true;
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    layer.el.classList.remove('is-on');
    Nav.popScope();
    setTimeout(() => layer.el.remove(), 260);
  }

  // Returns true if an open layer handled the key.
  function handleKey(name, e) {
    const layer = layers[layers.length - 1];
    if (!layer) return false;
    if (layer.onKey && layer.onKey(name, e) === true) return true;
    if (name === 'back') {
      closeLayer(layer);
      if (layer.onCancel) layer.onCancel();
      return true;
    }
    return false;
  }

  function menu(opts) {
    const items = opts.items.filter(Boolean);
    const html =
      '<div class="sheet' + (opts.stacked ? ' sheet-stacked' : '') + '">' +
      (opts.title ? '<p class="sheet-title">' + esc(opts.title) + '</p>' : '') +
      (opts.subtitle ? '<p class="sheet-sub">' + esc(opts.subtitle) + '</p>' : '') +
      '<div class="sheet-items">' +
      items.map((it, i) =>
        '<button class="btn btn-wide' + (it.danger ? ' is-danger' : '') + '" data-focusable data-i="' + i + '"' +
        (i === 0 ? ' data-autofocus' : '') + '>' + esc(it.label) +
        (it.detail ? '<span class="btn-detail">' + esc(it.detail) + '</span>' : '') + '</button>'
      ).join('') +
      '</div></div>';
    const layer = openLayer(html, 'layer-sheet');
    layer.el.addEventListener('nav:activate', (e) => {
      const i = e.target.getAttribute('data-i');
      if (i == null) return;
      closeLayer(layer);
      const it = items[+i];
      if (it && it.action) setTimeout(() => it.action(), 0);
    });
    return layer;
  }

  function prompt(opts) {
    return new Promise((resolve) => {
      const type = opts.type === 'password' ? 'password' : opts.type === 'url' ? 'url' : 'text';
      const html =
        '<div class="sheet sheet-prompt">' +
        '<p class="sheet-title">' + esc(opts.title || '') + '</p>' +
        (opts.message ? '<p class="sheet-sub">' + esc(opts.message) + '</p>' : '') +
        '<label class="field" data-focusable data-autofocus>' +
        '<span class="field-label">' + esc(opts.label || '') + '</span>' +
        '<input class="field-input" type="' + type + '" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(opts.value || '') + '"' +
        (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + '>' +
        '</label>' +
        '<div class="sheet-row">' +
        '<button class="btn" data-focusable data-act="ok">' + esc(opts.ok || tr('common.save')) + '</button>' +
        '<button class="btn" data-focusable data-act="cancel">' + tr('common.cancel') + '</button>' +
        '</div></div>';
      const layer = openLayer(html, 'layer-sheet');
      const input = layer.el.querySelector('input');
      const field = layer.el.querySelector('.field');
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        closeLayer(layer);
        resolve(value);
      };
      layer.onCancel = () => finish(null);

      layer.el.addEventListener('nav:activate', (e) => {
        const act = e.target.getAttribute('data-act');
        if (e.target === field) input.focus();
        else if (act === 'ok') finish(input.value);
        else if (act === 'cancel') finish(null);
      });
      // Enter in the field (or "Done" on the TV's keyboard) = save.
      input.addEventListener('nav:commit', (e) => {
        if (e.detail.key === 'enter') finish(input.value);
        else Nav.focus(field, { force: true });
      });
      input.addEventListener('blur', () => field.classList.remove('is-editing'));
      input.addEventListener('focus', () => field.classList.add('is-editing'));
      // Open the keyboard immediately.
      setTimeout(() => input.focus(), 120);
    });
  }

  function confirm(opts) {
    return new Promise((resolve) => {
      const layer = menu({
        title: opts.title,
        subtitle: opts.message,
        items: [
          { label: opts.ok || tr('common.ok'), danger: !!opts.danger, action: () => resolve(true) },
          { label: tr('common.cancel'), action: () => resolve(false) }
        ]
      });
      layer.onCancel = () => resolve(false);
    });
  }

  global.UI = { esc, toast, menu, prompt, confirm, handleKey, close: closeLayer, hasLayer: () => layers.length > 0 };
})(window);
