/*
 * Copy to  config.local.js  (ignored by git) and fill in.
 * The values here are used as defaults – what you save under Settings on the TV wins.
 *
 * Recommended: point to your G3 Hub (for example on Proxmox). There you add playlists and choose
 * categories and favourites from the web, so the TV needs no login details at all.
 * Without the hub: fill in the Xtream account under direct.
 */
window.LAUNCHER_LOCAL = {
  // language: 'en',                                          // 'auto' | 'en' | 'sv'
  // weather: { name: 'London', latitude: 51.5072, longitude: -0.1276 },
  // favorites: { apps: ['internal:tv', 'netflix', 'youtube.leanback.v4', 'com.webos.app.hdmi1'] },
  iptv: {
    hub: {
      url: 'http://192.168.1.20:8787',   // the hub's address (port 8787 if you leave it out)
      token: ''                           // only if you set a TV token in the hub
    },
    direct: {
      server: 'http://provider.example:8080',
      username: 'username',
      password: 'password',
      format: 'm3u8'                      // 'm3u8' (HLS) or 'ts'
    }
  }
};
