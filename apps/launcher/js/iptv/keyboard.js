/*
 * IPTV.keyboard — on-screen keyboard for the remote (grid, 6 columns, like tvOS grid mode).
 *
 *   const kb = IPTV.keyboard(container, { onChange(value) {} });
 *   kb.value() · kb.set('text') · kb.type('a') · kb.backspace() · kb.clear() · kb.first()
 *
 * OK types the character. Hold ⌫ to clear everything.
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const u = IPTV.u;

  // Six keys per row. Swedish gets å, ä and ö; other languages get punctuation that titles use instead.
  const ROWS = [
    'abcdef', 'ghijkl', 'mnopqr', 'stuvwx', I18n.lang === 'sv' ? 'yzåäö&' : "yz&'+:", '123456', '7890.-'
  ];

  function keyboard(host, opts) {
    opts = opts || {};
    let value = '';

    host.classList.add('kb');
    host.setAttribute('data-remember-focus', '');
    host.innerHTML =
      ROWS.map((row) => row.split('').map((ch) =>
        '<button class="kb-key" data-focusable data-k="' + u.esc(ch) + '">' + u.esc(ch) + '</button>'
      ).join('')).join('') +
      '<button class="kb-key kb-wide3" data-focusable data-k="space">' + u.icon('space') + '<span>' + tr('keyboard.space') + '</span></button>' +
      '<button class="kb-key kb-wide2" data-focusable data-k="back" aria-label="' + tr('common.delete') + '">' + u.icon('backspace') + '</button>' +
      '<button class="kb-key" data-focusable data-k="clear" aria-label="' + tr('keyboard.clear') + '">' + u.icon('x') + '</button>';

    function changed() {
      host.classList.toggle('is-empty', !value);
      if (opts.onChange) opts.onChange(value);
    }

    function type(ch) {
      if (value.length >= 60) return;
      value += ch;
      changed();
    }

    function backspace() {
      if (!value) return;
      value = value.slice(0, -1);
      changed();
    }

    function clear() {
      if (!value) return;
      value = '';
      changed();
    }

    // Short press feedback (transform/opacity only).
    function flash(btn) {
      if (!btn.animate) return;
      btn.animate([{ transform: 'scale(1.02)', offset: 0.5 }], { duration: 180, easing: Nav.ease });
    }

    host.addEventListener('nav:activate', (e) => {
      const btn = e.target.closest('.kb-key');
      if (!btn || !host.contains(btn)) return;
      const k = btn.getAttribute('data-k');
      flash(btn);
      if (k === 'space') { if (value && !/ $/.test(value)) type(' '); }
      else if (k === 'back') backspace();
      else if (k === 'clear') clear();
      else type(k);
    });

    host.addEventListener('nav:longpress', (e) => {
      const btn = e.target.closest('.kb-key');
      if (!btn) return;
      const k = btn.getAttribute('data-k');
      if (k === 'back' || k === 'clear') clear();
      else if (k.length === 1 && /[a-zåäö]/.test(k)) type(k.toUpperCase());
    });

    changed();

    return {
      value: () => value,
      set(v) { value = String(v || ''); changed(); },
      type,
      backspace,
      clear,
      first: () => host.querySelector('.kb-key'),
      el: host
    };
  }

  IPTV.keyboard = keyboard;
})(window);
