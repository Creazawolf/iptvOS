/* Your app. Everything in lib/ comes from the project's shared/ folder. */
(function () {
  'use strict';

  const status = document.getElementById('status');
  const say = (msg) => { status.textContent = msg; };

  const actions = {
    hello() {
      say('Hello from ' + (TV.isTV ? 'the TV' : 'the browser') + '! The time is ' + new Date().toLocaleTimeString());
    },
    youtube() {
      TV.launch('youtube.leanback.v4')
        .then(() => say(TV.isTV ? 'Opening YouTube…' : 'Preview: YouTube opens on the TV'))
        .catch((e) => say('Failed: ' + e.message));
    },
    back() {
      TV.back();
    }
  };

  document.addEventListener('nav:activate', (e) => {
    const fn = actions[e.target.getAttribute('data-action')];
    if (fn) fn();
  });

  // The Back button on the remote
  Nav.onKey((key) => {
    if (key === 'back') {
      TV.back();
      return true;
    }
    return false;
  });

  Nav.init();
})();
