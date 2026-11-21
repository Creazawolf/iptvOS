/*
 * tv.js — small helper for webOS TV apps.
 *
 * Works both on the TV (via PalmServiceBridge) and in an ordinary browser,
 * where Luna calls are answered by mocks (TV.mocks) so you can develop on your computer.
 *
 *   TV.launch('netflix')                                  -> Promise
 *   TV.request('luna://com.webos.service.x', 'method', {}) -> Promise<response>
 *   TV.keyName(event)   -> 'left' | 'enter' | 'back' | 'red' | 'digit5' | 'channelUp' | ...
 *   TV.back()           -> leave the app (like the Back button)
 *   TV.root.exec('ls')  -> Promise<{ stdout, stderr }>  (requires root + Homebrew Channel)
 */
(function (global) {
  'use strict';

  var isTV = typeof global.PalmServiceBridge !== 'undefined';

  // Bridges must be kept alive until the response arrives, otherwise they may be garbage collected.
  var pending = {};
  var seq = 0;

  function request(uri, method, params) {
    if (!isTV) return mockRequest(uri, method, params || {});

    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var bridge = new global.PalmServiceBridge();
      pending[id] = bridge;

      bridge.onservicecallback = function (msg) {
        delete pending[id];
        var res;
        try {
          res = JSON.parse(msg);
        } catch (e) {
          res = { returnValue: false, errorText: 'Invalid response from ' + uri };
        }
        if (res.returnValue === false) {
          var err = new Error(res.errorText || 'Luna call failed');
          err.code = res.errorCode;
          err.response = res;
          reject(err);
        } else {
          resolve(res);
        }
      };

      bridge.call(uri.replace(/\/?$/, '/') + method, JSON.stringify(params || {}));
    });
  }

  function launch(appId, params) {
    return request('luna://com.webos.applicationManager', 'launch', {
      id: appId,
      params: params || {}
    });
  }

  function back() {
    var sys = global.webOSSystem || global.PalmSystem;
    if (sys && typeof sys.platformBack === 'function') sys.platformBack();
    else global.history.back();
  }

  // Bring the app to the front (needed with "handlesRelaunch": true in appinfo.json – then the app does not
  // come to the front by itself when it is launched again, but when it is ready).
  function activate() {
    var sys = global.webOSSystem || global.PalmSystem;
    try {
      if (sys && typeof sys.activate === 'function') sys.activate();
    } catch (e) { /* the browser */ }
  }

  // Parameters the app was launched with (webOS puts them as JSON in launchParams).
  function launchParams() {
    var sys = global.webOSSystem || global.PalmSystem;
    try {
      var p = sys && sys.launchParams;
      return p ? (typeof p === 'string' ? JSON.parse(p) : p) : {};
    } catch (e) { return {}; }
  }

  // --- Root via Homebrew Channel -------------------------------------------

  var HBC = 'luna://org.webosbrew.hbchannel.service';

  var root = {
    // true if the Homebrew Channel service runs as root.
    available: function () {
      return request(HBC, 'checkRoot', {}).then(
        function (r) { return r.returnValue === true; },
        function () { return false; }
      );
    },
    // Run a shell command as root.
    exec: function (command) {
      return request(HBC, 'exec', { command: command }).then(function (r) {
        return { stdout: r.stdoutString || '', stderr: r.stderrString || '' };
      });
    },
    // Give a service in a separate package root privileges.
    elevateService: function (serviceId) {
      return request(HBC, 'elevateService', { id: serviceId });
    }
  };

  // --- Mocks for the browser ----------------------------------------------

  var mocks = {
    'luna://com.webos.applicationManager/launch': function (params) {
      console.info('[TV mock] launch', params.id, params.params);
      return { returnValue: true, processId: 'mock' };
    }
  };

  function mockRequest(uri, method, params) {
    var key = uri.replace(/\/$/, '') + '/' + method;
    var handler = mocks[key];
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (!handler) {
          var err = new Error('[TV mock] No mock response for ' + key);
          err.code = 'NO_MOCK';
          reject(err);
          return;
        }
        try {
          Promise.resolve(handler(params)).then(function (res) {
            if (res && res.returnValue === false) {
              var e = new Error(res.errorText || 'mock error');
              e.response = res;
              reject(e);
            } else {
              resolve(res);
            }
          }, reject);
        } catch (e) {
          reject(e);
        }
      }, 80);
    });
  }

  // --- Keys -----------------------------------------------------------------

  var KEYS = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down',
    13: 'enter',
    461: 'back',
    403: 'red', 404: 'green', 405: 'yellow', 406: 'blue',
    415: 'play', 19: 'pause', 413: 'stop', 412: 'rewind', 417: 'forward',
    33: 'channelUp', 34: 'channelDown',
    457: 'info'
  };

  // Browser only: keyboard shortcuts for TV buttons.
  var BROWSER_KEYS = {
    8: 'back', 27: 'back',                       // Backspace / Esc
    82: 'red', 71: 'green', 89: 'yellow', 66: 'blue', // R G Y B
    73: 'info'                                   // I
  };

  function keyName(e) {
    var code = e.keyCode || e.which;
    if (KEYS[code]) return KEYS[code];
    if (code >= 48 && code <= 57) return 'digit' + (code - 48);
    if (code >= 96 && code <= 105) return 'digit' + (code - 96);
    if (!isTV && BROWSER_KEYS[code]) return BROWSER_KEYS[code];
    return null;
  }

  // Safety net for apps with "handlesRelaunch": if the rest of the app failed to start (an error in a
  // script) it should still come to the front when launched again. The app sets TV.started = true.
  global.document.addEventListener('webOSRelaunch', function () {
    if (!global.TV.started) activate();
  });

  global.TV = {
    started: false,
    isTV: isTV,
    request: request,
    launch: launch,
    back: back,
    activate: activate,
    launchParams: launchParams,
    keyName: keyName,
    root: root,
    mocks: mocks
  };
})(window);
