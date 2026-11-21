/*
 * Defaults. Most of this you change directly on the TV under Settings –
 * what you change there is saved on the TV and wins over the values here.
 *
 * Personal or secret details (e.g. your IPTV login) can go in  config.local.js
 * (not committed to git), see config.local.example.js.
 */
window.LAUNCHER_DEFAULTS = {
  // UI language: 'auto' (the TV's menu language) | 'en' | 'sv'. Changed under Settings › Language.
  language: 'auto',

  // Weather location. Empty until you choose one under Settings › Weather (or set it in config.local.js).
  weather: { name: '', latitude: null, longitude: null },

  layout: {
    // Rows on the home screen below the dock, from top to bottom.
    // id: 'channels' | 'continue' | 'apps' | 'widgets'   (the dock = favourite apps is always at the top)
    sections: [
      { id: 'channels', visible: true },
      { id: 'continue', visible: true },
      { id: 'apps', visible: true },
      { id: 'widgets', visible: false }
    ],
    // Small weather reading next to the clock in the top right.
    statusWeather: true,
    // Wallpaper: the chosen collections. 'glass' is built into the app; 'space', 'earth', 'nature', 'bing' and 'photos'
    // come from the hub (without the hub there is Glass and a small space collection). Empty = the older choice below.
    wallpaperSets: [],
    wallpapers: 'mixed',
    // Change the wallpaper after this many minutes.
    wallpaperMinutes: 10,
    // Performance mode: no background blur behind glass.
    lite: false
  },

  favorites: {
    // App IDs in the order they appear in the dock. 'internal:tv' = the built-in TV app.
    // Apps that aren't on the TV are skipped.
    apps: [
      'internal:tv',
      'netflix',
      'youtube.leanback.v4',
      'amazon',
      'com.apple.appletv',
      'com.disney.disneyplus-prod',
      'spotify-beehive',
      'com.webos.app.hdmi1',
      'internal:screenoff',
      'internal:lghome'
    ]
  },

  // Apps and inputs that should not be shown at all.
  hiddenApps: [
    'com.webos.app.discovery',
    'com.webos.app.camera',
    'com.webos.app.storagemanager',
    'com.g3custom.launcher'
  ],

  // The widget row (if it is turned on): 'weather' | 'clock' | 'live'
  widgets: ['weather', 'clock'],

  // Screen saver (gentle on OLED) after this many minutes without a button press. 0 = off.
  ambientAfterMinutes: 5,
  // What the screen saver shows: 'images' (the wallpapers) or 'aerial' (aerial videos, needs the hub).
  // quality: 'hd' (1080p) | 'uhd' (4K) | 'hdr' (4K HDR). sources: which video collections are included.
  ambient: { mode: 'images', quality: 'uhd', maxMinutes: 60, sources: { apple: true, community: true, amazon: false } },

  iptv: {
    // '' = choose automatically: the hub if an address is set, otherwise Direct to Xtream.
    mode: '',
    hub: { url: '', token: '' },
    direct: { server: '', username: '', password: '', format: 'm3u8' },
    lastChannel: null,
    recent: [],
    // Silent preview of the last channel behind the home screen (when the cursor is on the TV tile).
    homePreview: true,
    // Navigation in the TV app (Settings › IPTV › Navigation):
    //   tabs:    'ok' (OK or ▼ switches tab) | 'focus' (switches when the cursor moves)
    //   preview: 'ok' (OK plays in the preview, OK again goes full screen) | 'auto' | 'off'
    //   zap:     'direct' (▲▼ change channel) | 'confirm' (▲▼ browse, OK switches)
    //   back:    'app' (Back after starting from the home screen goes to the TV app) | 'home'
    nav: { tabs: 'ok', preview: 'ok', zap: 'direct', back: 'app' }
  },

  // Movies and series. mediaInfo: let the TV report audio tracks/subtitles/HDR (needed to choose tracks).
  // hubSubs: text tracks in .mkv are drawn by the launcher (the file plays through the hub). sub.size 0–5 (Smallest … Very large).
  player: { autoNext: true, skip: 10, mediaInfo: true, hubSubs: true, audioPref: 'last', subPref: 'last', sub: { size: 3, position: 0, box: false } },
  // Live TV. mediaInfo is off by default – channel changes must not be put at risk.
  live: { bannerSeconds: 5, mediaInfo: false, audioPref: 'last', subPref: 'last' }
};
