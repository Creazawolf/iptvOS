# Architecture (v3)

Three parts that talk to each other:

```
┌──────────────── TV (LG G3, webOS) ────────────────┐        ┌──── Proxmox LXC ────┐
│ apps/launcher  (web app, Chromium 132, 1920×1080) │  HTTP  │ hub/  (Node ≥ 18)   │
│   ├─ home screen, apps, settings                  │◀──────▶│  Xtream/M3U cache   │
│   └─ TV app: Live, Movies, Series, Search         │  SSE   │  selection, favs    │
│ apps/launcher/service  (Node 20, root via HBC)    │        │  search, EPG, art   │
│   └─ app list, HDMI, icons, autostart, fetch,     │        │  web admin  :8787/  │
│      reminders, sleep timer                       │        │  images     :8788   │
└───────────────────────────────────────────────────┘        └─────────────────────┘
```

* **The hub** is the IPTV brain. It fetches and caches the providers' lists (22,000+ channels),
  keeps your selection (which categories are shown, their order, favourites) and has the web admin.
  The TV only downloads what you have chosen to show.
* **The launcher** also works without the hub: the TV app then talks directly to an Xtream server
  (Direct mode) and the selection is stored on the TV.
* **The service** on the TV runs as root (lifted by the Homebrew Channel's `elevate-service`). It reads
  the TV's real app list, HDMI inputs and icon files. Developer apps only get public ACG groups, so the
  app cannot call `listLaunchPoints` or the Homebrew Channel itself.
* **Languages.** The launcher, the web admin and the hub's own messages are in English and Swedish, see §7.

## Known facts about the TV (verified 2026-11-01 on the developer's TV)

* OLED65G36LA, "Rockhopper release 11.2.0" (webOS 26 firmware), kernel 6.12, **Node v20.12.2**.
* `listLaunchPoints` is in the groups `applications.internal`/`private` → needs a root service.
* `com.webos.service.eim/getAllInputStatus` is in `externalinput.query` (public).
  It returns every HDMI input with `label` (the name set on the TV, e.g. "PS5 Spelkonsol"), `connected`
  and `appId` (`com.webos.app.hdmi4`).
* The installer filters `requiredACG` down to public groups. `org.webosbrew.hbchannel.service.group`
  is dropped, so neither the app nor a non-elevated service can call the Homebrew Channel.
* An elevated service (HBC's `run-js-service`, uid 0, client permission `all`) can call anything through
  `service.call()`. **Important:** in that mode the Node process exits when the event loop is empty.
  The service must keep itself alive with its own timer (`setInterval`) and handle its own idle timeout.
* `luna-send` in scripts: run it with `</dev/null`. Without that (for example in an SSH session) there is
  often no reply.
* The web engine is **Chromium 132** (WebAppMgr), 3 cores (Cortex-A76), ~2 GB RAM but only ~500 MB free.
  Flags that affect the launcher: no V8 code cache for `file://` apps (`LocalResourceCodeCache` off),
  which is why the scripts are bundled (§6); only **one** active video player
  (`--max-activated-media-players=1`), so the next channel cannot be preloaded in a second `<video>`;
  background apps are cleared after 10–15 s; a budget of 96 MB for decoded images and 250 MB of GPU
  memory; remote debugging on port 9998 (used by `npm run tv -- perf`).
* LG's own apps start without a splash (`noSplashOnLaunch`, `spinnerOnLaunch:false`) and handle relaunch
  themselves (`handlesRelaunch`). The launcher does the same and calls `webOSSystem.activate()` only once
  it has switched to the home screen. The application manager accepts `"keepAlive": true` at launch (sent
  by the init script and the Home button command).
* `com.webos.service.tvpower/power/powerOff` with `{"reason":"sleepTimer"}` turns the TV off like its own
  sleep timer. `com.webos.notification/createAlert` shows a box with buttons on top of everything.
* `com.webos.service.tvpower/power/turnOffScreen` / `turnOnScreen` (`{}`) turn the screen off and on while
  the sound continues, whatever app is in front. `getPowerState` then answers `"Screen Off"`. It is the
  same call LG's media player makes for music.
* User space is **32-bit** (the kernel is 64-bit): `process.arch` is `arm`, and a key event from
  `/dev/input/event*` is 16 bytes (not 24).
* **LG Input Hook** doesn't start by itself after a restart (its own autostart only exists if you turned
  it on in its app). The watcher starts it; `/tmp/inputhook` exists when the hook is in place.
* **Inherited bus connections (found 2026-11-21).** A process that the service starts inherits its open
  connection to the Luna bus. If the child lives on (the watcher), the bus thinks the service is still
  there after it has exited or been reinstalled: `ls-monitor -l` shows the service with a pid that doesn't
  exist, no new one is started, and every call goes unanswered until the TV is restarted. The watcher
  therefore closes inherited sockets when it starts (`close_inherited` in the init script). Debug with
  `ls-monitor -l | grep g3custom`.
* The app manager's `launch` accepts `"preload": "full"` ("App will be launched in background" in the
  schema `/etc/palm/schemas/sam/applicationManager.launch.schema`): the app starts without touching what
  is on screen. The watcher uses it to keep the launcher warm after a reinstall or when the TV has closed
  it, and it can be used to check a new version through remote debugging without disturbing whoever is
  watching.
* `elevate()` in the init script stops the old service process with `pgrep -f`. The pattern also matches
  `luna-send` calls to the service and SSH scripts that mention its name, so only Node processes are
  stopped.

### Video: how LG's own media player does it (verified 2026-11-20 in `com.webos.app.mediadiscovery`)

`<video>` uses the TV's own pipeline, so HEVC, AV1, VP9, HDR10, HLG, Dolby Vision, Dolby Digital(+),
Atmos and DTS are decoded by the TV (`canPlayType` answers "probably" for `dvh1`, `dvhe`, `hvc1`, `av01`,
`ec-3`, `ac-3`, `dtsc`; not TrueHD). What the app has to do itself is ask for track info and control the
subtitles:

* The source is set as `<source src type="video/mp4;mediaOption=<escape(JSON)>">` (LG gives `video/mp4`
  for every file, mkv too). `mediaOption.htmlMediaOption.useUMSMediaInfo: true` makes `<video>` receive the
  event `umsmediainfo` with `detail` = JSON: `{ type: 'sourceInfo', mediaId, info: { container,
  programInfo: [{ audioTrackInfo: [...], subtitleTrackInfo: [...], videoTrackInfo }] } }`. Without it, no
  track lists arrive.
* Subtitles are controlled with `video.send(JSON.stringify({ command, parameter }))` (available on
  `<video>` for developer apps too): `SetMediaSubtitleEnable { enable }`, `SetInternalSubtitle { index }`,
  `SetExternalSubtitle { uri, preferredEncoding, index }` and `SetMediaSubtitleInfo { fontSize 0–4,
  position −3…4 (LG raises it to 10/18 while the controls are shown), sync ms, color … }`. The TV draws
  the text.
* Audio tracks: `com.webos.media/selectTrack { mediaId, type: 'audio', index }` (needs root → the service).
* **The TV's text engine drops text in ASS tracks** (seen in screenshots 2026-11-21, Dark Matter S1E1,
  42 ASS tracks in an .mkv): everything before the first comma in a line disappears, and lines without a
  comma are not shown at all. Size, height and character encoding make no difference. An external SRT
  file, on the other hand, is shown complete: `SetExternalSubtitle { uri: 'file:///tmp/x.srt',
  preferredEncoding: 'UTF-8', index: 0 }` (the bare path, without `file://`, shows no text). The TV's
  "Small" (`fontSize` 1) is text about 54 px high, "Very Small" 41 px. That is why the launcher draws text
  tracks itself, see §2 "Subtitles".
* Screenshot of what is shown (picture + graphics): `luna://com.webos.service.capture/executeOneShot
  { path, method: 'DISPLAY', format: 'JPEG', width, height }` → `npm run tv -- shot`.
* LG also sets `htmlMediaOption.useDassControl` and `mediaTransportType`. They are not turned on here;
  they can be tried without a reinstall through `Store.set('player.lab', { dass: true, transport: 'USB' })`
  (for example with `npm run tv -- eval`).

---

## 1. The hub's API (`hub/`, default port 8787)

All JSON (gzip for responses > 4 kB). CORS `Access-Control-Allow-Origin: *`, including preflight for
`POST`/`PUT`/`DELETE` with `Content-Type: application/json`, `X-Hub-Token` and `Accept-Language` (the TV
app runs from `file://`, Origin `null`).

**Errors** come back as `{ error }` with a 4xx/5xx status. The text is in the request's language (§7).

**Token:** if `adminToken` is set, `X-Hub-Token: <token>` or `?token=` is required on all
`/api/admin/*`. The TV routes (`/api/tv`, `/api/live`, `/api/epg`, `/api/vod`, `/api/series`,
`/api/search`, `/api/events`, `/api/wallpapers`, `/api/stream`, `/api/subs`) need a token only if
`tvToken` is set (the admin token is accepted too). `/api/health` and `/api/img` are always open (images
are loaded with `<img>`, without headers). EventSource cannot send headers → use `?token=`.

**IDs** are global strings `"<playlistId>:<providerId>"`, for example `"p1:12345"` for channels, movies,
series and episodes (movies and series have their own namespaces at the provider, so the same id can
appear in both – `kind` or the route decides). Categories: live `"p1:c:17"`, movies `"p1:v:17"`,
series `"p1:s:17"`. M3U lists get stable hash ids (`"p2:Xy3…"`).

### Objects

```js
Channel  = { id, playlistId, name, logo, num, categoryId, epgId, url, catchup: bool, catchupDays /* 0 = none */ }
Category = { id, name, count }
Movie    = { id, title, year, poster, backdrop, rating /* 0–10 | null */, added /* unix s */, categoryId }
Series   = { id, title, year, poster, backdrop, rating, added, categoryId }
Episode  = { id, season, episode, title, plot, duration /* s */, still, url, progress }
Program  = { title, start /* unix ms */, end, desc }
Progress = { id, kind: 'vod'|'episode', seriesId?, title, subtitle, poster, backdrop, still?, url?,
             position /* s */, duration, updated /* ms */, next?: true }
```

* `url` is always a ready-to-play address (HLS `.m3u8` or `.ts` depending on the playlist's format;
  movies and episodes with the provider's file extension).
* `Movie.backdrop` is often empty in lists (Xtream sends no backdrops in the list). It is filled in once
  `/api/vod/info` has been called for the movie (or by TMDB), so fetch info for the focused item if you
  want to show a backdrop.
* **Image proxy** (on by default): image fields are rewritten to `<imgBase>/api/img?u=<url-encoded address>`,
  where `imgBase` is the hub's **image port** (default 8788 = the API port + 1; `--img-port 0` = the same
  port). Images should not share the TV's six connections with the API. Add `&w=<width>` for a scaled-down
  image (only works if `sharp` is installed). The original is fetched once and all sizes are made from it.
  Addresses that don't answer rest for 30 min. `/api/img` unwraps double-wrapped addresses and refuses
  local addresses that don't belong to a playlist. The TV uses the sizes 160/320 (logos), 320 (posters),
  480 (cards) and 1280 (backdrops).
* `Progress.subtitle`: the movie's year, or `"S1 · E3 – Episode title"` in the request's language
  (Swedish: `"S1 · A3 – …"`). `next: true` = the next episode after a finished one (position 0). Only
  one row per series.
* `progress` on episodes and in `/api/vod/info` = `{ position, duration, updated } | null`.

### TV endpoints

| Method | Route | Response |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, version, name }` |
| GET | `/api/tv/bootstrap` | `{ rev, hash, name, version, caps:{ stream, wallpapers }, imgBase, playlists:[{ id, name, type, enabled, status:{ ok, refreshing, step, error, warnings, updatedAt, counts, expires, … } }], live:{ categories:[Category], favorites:[Channel] }, vod:{ categories, favorites:[Movie] }, series:{ categories, favorites:[Series] }, continue:[Progress], positions:{ ID:[position, duration] } }`. `step`, `error` and `warnings` are in the request's language. With `?since=<hash>` and nothing changed: `{ same: true, hash }` (the TV doesn't have to redraw). |
| GET | `/api/events` | SSE. `event: rev` `data: {"rev":N,"reason":"favorites\|mediaFavorites\|curation\|playlists\|catalog\|settings"}` on every change (the first message after connecting has no `reason`). `event: continue` `data: {"count":N}` when Continue watching changes. Ping comment every 25 s, `retry: 3000`. |
| GET | `/api/live/channels?category=ID` | `{ items:[Channel] }` sorted by number. `category=favorites` gives the favourites. |
| GET | `/api/live/epg?ids=ID,ID,…` | `{ epg: { ID: { now: Program\|null, next: Program\|null } } }` (max 50 ids per call, cached 10 min, at most 4 calls to the provider at a time) |
| GET | `/api/live/grid?category=ID\|favorites&from=ms&hours=3&offset=0&limit=60` | `{ from, to, total, channels:[Channel], programs:{ ID:[Program] } }` (the guide grid) |
| GET | `/api/live/guide?id=ID` | `{ items:[Program] }` (the next 24 hours, at most 40) |
| GET | `/api/live/catchup?id=ID&start=ms&end=ms` | `{ url, start, end }` – catch-up address (Xtream `/timeshift/…`, start time in the provider's time zone, 2 min before and 5 min after). 400 if the channel has no catch-up, 410 if the programme is too old. |
| GET | `/api/epg/search?q=…&limit=40` | `{ items:[{ channel: Channel, program: Program }] }` – search the guide among your channels: on now first, then upcoming, past ones last (only channels with catch-up). |
| GET | `/api/vod/list?category=ID&offset=0&limit=60&sort=added\|name\|rating` | `{ total, items:[Movie] }`. `category=recent` (default) = the 200 most recently added in visible categories. `limit` ≤ 500. |
| GET | `/api/vod/info?id=ID` | `Movie & { plot, genre, cast, director, duration /* s */, trailer /* YouTube URL */, url, progress }` |
| GET | `/api/series/list?category=ID&offset&limit&sort` | `{ total, items:[Series] }`. `category=recent` exists. |
| GET | `/api/series/info?id=ID` | `Series & { plot, genre, cast, director, trailer, seasons:[{ season, name, poster, episodes:[Episode] }] }` (season 0 = "Extras", last; seasons and episodes without a real name get "Season N" / "Episode N" in the request's language) |
| GET | `/api/search?q=…&limit=30&all=0` | `{ live:[Channel], vod:[Movie], series:[Series] }`. Ignores diacritics (`skargard` finds "Skärgård") and matches the start of words. Without `all`, visible categories are searched (+ favourites for live); `all=1` searches everything. |
| GET | `/api/img?u=URL&w=WIDTH` | An image through the hub's disk cache (≤ 800 MB, oldest removed first). |
| GET/HEAD | `/api/stream?u=URL` | A movie or episode through the hub: the same bytes as from the provider (Range, 206), one upstream request per request from the TV, closed when the TV closes. `u` must belong to a playlist's server. For `.mkv`, the text tracks are read out of the byte stream on the way. |
| GET | `/api/wallpapers` | `{ sets:[{ id, title, detail, count, updatedAt, error, loading }] }` – the wallpaper collections (`space`, `earth`, `nature`, `featured`, `bing`, `photos`); `title`, `detail` and `error` are in the request's language. The first time, the response waits up to 6 s for the lists to be fetched. |
| GET | `/api/wallpapers/items?sets=a,b&limit=30` | `{ items:[{ id, set, title, credit, src }] }` – a random selection, spread evenly over the chosen collections. `src` is the source's address (≤ 1,920 px wide); the TV loads it through `/api/img?…&w=1920`. |
| GET | `/api/wallpapers/aerial` | `{ videos:[{ id, source:'apple'\|'community'\|'amazon', name, place, scene, time, urls:{ hd, uhd, hdr }, poi:[[second, text]] }], updatedAt, error, proxyHosts:[host] }` – the aerial videos for the screen saver. Videos on a host in `proxyHosts` are played through `/api/wallpapers/video`. |
| GET/HEAD | `/api/wallpapers/video?u=URL` | An aerial video through the hub (Range, 206; closed when the TV closes; nothing is stored). Only the hosts in `hub/lib/aerialproxy.mjs` (Apple's video server) and only `.mov/.mp4/.m4v`. |
| GET | `/api/subs?u=URL&track=N&after=K` | What the hub has read out so far: `{ known, tracks:[{ index, codec, text, lang, name, default, forced }], cues:[[start, end, text]], next }` (seconds; `after` = the number of cues the TV already has for the track). Without `track`: only the track list. |
| POST | `/api/tv/favorites/toggle` `{ id }` | `{ rev, favorite: bool }` (added last) |
| POST | `/api/tv/media-favorites/toggle` `{ kind:'vod'\|'series', id }` | `{ rev, favorite: bool }` (a favourite movie or series; newest first in bootstrap) |
| POST | `/api/tv/favorites/move` `{ id, delta }` | `{ rev }` |
| POST | `/api/tv/categories/move` `{ kind:'live'\|'vod'\|'series', id, delta }` | `{ rev }` (moves among the *visible* ones) |
| POST | `/api/tv/categories/hide` `{ kind, id }` | `{ rev }` |
| POST | `/api/tv/progress` `{ id, kind, seriesId?, position, duration }` | `{ ok, finished?, ignored? }`. ≥ 95 % = finished (removed; for episodes the next one is queued). Under 10 s is not saved. |

### Admin endpoints (web admin)

| Method | Route | |
| --- | --- | --- |
| GET | `/api/admin/status` | overview: `{ name, version, rev, uptime, node, sharp, tmdb, dataDir, urls:[LAN addresses], counts, favorites, favoritesMissing, continue, playlists:[…+status], tv:{ connected, lastSeen, lastRequest }, pauses:[{ host, until, code, strikes }], streams:{ active, files }, aerial:{ active, served } }` |
| GET/POST | `/api/admin/playlists` | list (without passwords, `hasPassword`) / create `{ name, type:'xtream'\|'m3u', server, username, password, m3uUrl, epgUrl, format:'m3u8'\|'ts', userAgent, enabled }` |
| PUT/DELETE | `/api/admin/playlists/:id` | change (empty password = keep it) / remove (also clears its favourites and selection) |
| POST | `/api/admin/playlists/:id/refresh` | fetch the catalogue again now |
| POST | `/api/admin/refresh` | fetch all active playlists again |
| POST | `/api/admin/playlists/test` | test without saving → `{ ok, info \| error }` (with `id` and an empty password, the saved one is used) |
| GET | `/api/admin/categories?kind=live\|vod\|series` | all categories `{ id, name, count, visible, playlistId, playlistName }` in the user's order |
| PUT | `/api/admin/categories?kind=…` | `{ order?:[id], visible?:[id] }` (what is sent replaces the old) |
| GET | `/api/admin/channels?category=ID\|favorites&q=…&offset&limit` | `{ total, items:[Channel & { favorite, categoryName, categoryVisible }] }`; `q` searches all channels |
| GET/PUT | `/api/admin/favorites` | `{ items }` (missing channels as `{ id, missing:true }`) / `{ ids:[id] }` (ordered list) |
| GET | `/api/admin/search?q=…&all=1` | like `/api/search` |
| GET/PUT | `/api/admin/settings` | `{ settings:{ name, adminToken, tvToken, refreshHours, tmdbKey, tmdbLanguage, imageProxy, language } }`. PUT takes the fields to change and answers the same. `language` = `'en'\|'sv'`, the hub's language (§7); changing it rebuilds the index. `tmdbLanguage` = e.g. `en-GB`; empty (the default) = derived from `language`: `sv-SE` or `en-US`. `refreshHours` 1–168. |
| DELETE | `/api/admin/progress` | clear Continue watching |
| GET | `/api/admin/backup` | `{ kind:'g3hub-backup', version, hub, exportedAt, config, progress }` (contains passwords) |
| POST | `/api/admin/restore` | such a file → replaces everything you have set up except the current admin and TV tokens; new or changed playlists are fetched again → `{ ok, rev, playlists }`. A backup without `settings.language` is from before the setting and is restored as Swedish. |
| GET | `/api/events?admin=1` | like the TV's SSE + `event: status` with the fetch status per playlist, in the language given by `?lang=` |

### Selection for new playlists

The first time a playlist is loaded, only categories that look Swedish/Nordic are shown (live), plus
"new/popular" for movies and series – at most 12 per type, otherwise the first 5 (live) or 8 (movies,
series). Categories that appear later stay hidden until you turn them on. This does not depend on the
hub's language.

### Storage

`hub/data/` (git-ignored; in the LXC `/var/lib/g3hub`): `config.json` (playlists, selection, favourites,
settings, `rev`; `config.json.1` = a copy at most an hour old, used if `config.json` is broken),
`progress.json`, `runtime.json` (provider pauses and fetches in progress – survives a restart),
`cache/<playlistId>.json` (normalised catalogue), `cache/<playlistId>.epg.json` (guide),
`cache/info/` (detail pages, stale-while-revalidate), `cache/wallpapers/` (the wallpaper and aerial
lists), `tmdb.json` (at most 20,000 lookups), `img/`.

### Operations

`hub/deploy/install.sh` runs in a Debian/Ubuntu container (installs Node, optionally `sharp`, and the
systemd service `g3hub`; the same script updates). `hub/deploy/proxmox-create-lxc.sh` runs on the
Proxmox host and creates the container. From the computer: `hub/deploy/update.sh` (`--create`, `--pve` or
directly to the container). Step by step: [hub/README.md](../hub/README.md). Locally: `npm run hub` (data
in `build/hub-data`), or `npm run dev`, which starts a hub with demo data on the dev port + 707. Tests:
`node hub/test/smoke.mjs`, `node hub/test/bench.mjs`.

---

## 2. IPTV in the launcher (`apps/launcher/js/iptv/`)

The data source is chosen in the settings: `iptv.mode = 'hub' | 'direct' | ''` (`''` = the hub if an
address is set, otherwise Direct).

```js
IPTV.source            // the active backend (hub or direct), same methods as the hub's TV API:
  .bootstrap() .channels(catId) .epg(ids) .guide(id) .vodList(q) .vodInfo(id) .seriesList(q)
  .seriesInfo(id) .search(q) .toggleFavorite(id) .toggleMediaFavorite(kind, id) .moveFavorite(id, d)
  .moveCategory(kind, id, d) .hideCategory(kind, id) .progress(p) .img(url, w)

// Public API used by the home screen and widgets (stable contract):
IPTV.ready                 // Promise that resolves when bootstrap has loaded (or failed)
IPTV.configured()          // bool
IPTV.favorites()           // [Channel] (synchronous, last known)
IPTV.continueWatching()    // [Progress]
IPTV.onChange(fn)          // fn(reason) on a new bootstrap or favourite change
IPTV.open(params)          // open the TV view: { tab:'live'|'movies'|'series'|'search', channel?, fullscreen?, item? }
IPTV.openItem(progress)    // continue watching a movie or episode
IPTV.preview.start(ch) / IPTV.preview.stop()   // silent preview behind the home screen
IPTV.epg.nowNext(ch)       // { now, next } | { pending: true } (cached; triggers a fetch)
IPTV.lastChannel()         // Channel | null
IPTV.settingsPages         // { iptv: factory, … }, see §4

// New in v3.1:
IPTV.loadUi()              // Promise – the TV view's UI (lazy-loaded in the package, see §6)
IPTV.catchup.available(ch, prog) / .play(ch, prog)   // watch afterwards / from the start
IPTV.reminders.toggle(ch, prog) / .has / .list / .remove   // reminders (the service shows the box)
IPTV.tracks.state() / .selectAudio(i) / .selectText(i)     // audio/subtitles for what is playing (movies and live)
IPTV.options.menu() · IPTV.fit.set('contain'|'cover'|'fill') · IPTV.sleep.set(min)

// New in v3.2:
IPTV.player.sourceMode()   // 'option' (mediaOption, track info from the TV) | 'plain' | ''
IPTV.tracks.style() / .setStyle({ size, position }) / .setSync(sec) / .lift(bool)   // how subtitles look
IPTV.tracks.debug()        // the latest umsmediainfo events and commands (npm run tv -- eval)
IPTV.screenOff()           // turn the screen off, the sound continues
IPTV.ui.openSettings()     // the TV app's settings (the gear in the tab row)
```

**The player (v3.2).** Movies and episodes are started with `mediaOption` (see "Video" above). If that
doesn't work for a stream, the next attempt uses a plain `video.src`; if it happens twice, `video.src` is
used for the rest of the session. Live uses `video.src` unless *Audio and subtitle tracks for channels*
is turned on (the gear › Live TV). Once the TV has sent the track list and the stream is playing, the
language is chosen according to the setting (`'last'` = what you last chose in the player, `'off'` or a
language code), and the subtitle is turned on at the TV. The player shows badges such as
"4K · Dolby Vision · Dolby Atmos" when the TV reports them.

**Subtitles (v3.3).** The provider allows one connection at a time (the older one is closed when a new
one opens), so the text cannot be fetched alongside playback. Instead the file is played through the
hub's `/api/stream`, which reads the text tracks out of the same bytes (`hub/lib/mkvsubs.mjs`: a
streaming Matroska parser that skips everything except track descriptions and text blocks; SRT, ASS/SSA
and WebVTT). The TV fetches the cues from `/api/subs` once a second and draws them itself on top of the
video (`js/iptv/subs.js`) – whatever the TV has buffered has always passed through the hub before it is
shown. That gives the full text, six sizes (28–70 px), four heights and an optional dark box. It is used
for text tracks in `.mkv` in Hub mode (`player.hubSubs`, bootstrap `caps.stream`). If a subtitle is
preselected, the file plays through the hub from the start; otherwise the player switches stream (same
position) when you choose a text track. Image-based tracks (PGS/VobSub), other file formats, Direct mode
and live use the TV's own subtitles. If the stream through the hub can't be played, the player switches
to direct playback by itself (`proxy-failed`) and stays there for ten minutes.

**Navigation (v3.2).** Nothing changes just because the focus moves: the tab row needs OK or ▼, the
channel list only plays when you press OK (in the preview), and OK again goes full screen. `iptv.nav.*`
controls this, see below. If the TV view is opened from the home screen (the TV tile, a channel,
Continue watching), Back leads to the TV app and only then to the home screen (`iptv.nav.back`).

Keys in full screen (live): ▲▼ change channel (holding only starts the channel you stop on), digits
(switch as soon as the number is unambiguous), OK channel list, **blue** previous channel, **green**
audio and subtitles, **red** Options (aspect ratio, sleep timer, reminder), yellow favourite.
In the movie player: green = audio and subtitles, red = Options.

Store keys (owned by the IPTV module): `iptv.mode`, `iptv.hub.url`, `iptv.hub.token`,
`iptv.direct.{server,username,password,format}`, `iptv.lastChannel`, `iptv.recent`,
`iptv.local.{favorites,catOrder,catHidden,mediaFav.vod,mediaFav.series}` (the selection in Direct mode),
`iptv.reminders`, `player.fit`, `player.{audioLang,subLang}` (movies), `live.{audioLang,subLang}` (live),
`iptv.nav.{tabs,preview,zap,back}`, `iptv.homePreview`, `player.{autoNext,skip,mediaInfo,audioPref,subPref,sub}`,
`live.{bannerSeconds,mediaInfo,audioPref,subPref}`, `player.lab` (trial flags), `player.hubSubs`,
`player.sub.{size 0–5, position, box}`.
Its own localStorage keys: `g3:iptv:boot:v1` (bootstrap cache, only written when something changed),
`g3:iptv:pos:v1` (playback positions, written every 10 s during playback – which is why they are not in
the settings), `g3:perf:zap:v1` (measurements). The settings are written when the TV is idle
(`requestIdleCallback`, after 2 s at the latest) and always before the app is hidden. Old flat keys
`iptv.server/username/password/format` are migrated to `iptv.direct.*`.

### Wallpapers and aerial videos (`js/core/wallpaper.js`, `js/core/idle.js`, `hub/lib/wallpapers.mjs`)

These sit outside the IPTV part but use the hub (bootstrap `caps.wallpapers`). Without the hub there is
Glass and a small built-in space collection.

**Images.** The hub fetches the sources' *lists* (not the images), saves them in
`data/cache/wallpapers/<id>.json` and fetches them again in the background when they get old (if that
fails, the old list still applies and the next attempt is at the earliest an hour later; a list saved
with an older `LIST_VERSION` counts as not fetched):

| Collection | Source | Count (2026-11-21) | Refetched |
| --- | --- | --- | --- |
| `space` Space | ESA/Webb, ESA/Hubble and ESO: the "Top 100" pages (CC BY 4.0) | 294 | 7 days |
| `earth` Earth from above | Google Earth View (the list from `limhenry/earthview`) | 1,520 | 30 days |
| `nature` Nature and landscapes | Wikimedia Commons, the categories "Featured pictures of landscapes / mountains / lakes / sunsets / sunrises / clouds / beaches / waterfalls / forests / coasts / snow / volcanoes / the Milky Way" (the API, one request at a time with a 0.7 s pause – otherwise 429). Only JPEG ≥ 2,400 px, aspect ratio 1.45–2.4. Photographer and licence come along. | 781 | 14 days |
| `featured` Featured pictures | Wikimedia Commons "Commons featured widescreen desktop backgrounds" – mixed (animals, buildings, art, nature), same filter | 644 | 14 days |
| `bing` Picture of the day | Bing's `HPImageArchive` (only images marked `wp`) in the hub's market (§7); new days are added to the old ones (at most 150) | 16 → 150 | 12 hours |
| `photos` Photographs | Chromecast's ambient mode (the list from `dconnolly/chromecast-backgrounds`). About half of the links are dead: the hub asks each one with HEAD and keeps those that answer. | 405 | 30 days |

The launcher (`Wallpaper`) lets several collections be chosen (`layout.wallpaperSets`; the older
`layout.wallpapers` applies until you choose yourself) and draws each new image from a randomly chosen
collection. From the hub it fetches 30 entries at a time (`/api/wallpapers/items`), starting a few
seconds after start-up. Each image is loaded through the image proxy at 1,920 px (all sources are
already ≤ 1,920 px wide, so it works without `sharp` too), decoded before the crossfade, and there are
only two image layers. If an image doesn't load within 7 s, the next one is taken, and finally a
built-in one. The latest image is saved (`g3:wp:cur`) and shown straight away at the next start. The
blurred version behind the grid is a 128×72 thumbnail (at most 30 are kept).

**Aerial videos** (`ambient.mode = 'aerial'`, Settings › Wallpaper › Screen saver shows). The lists come
from the Aerial Views project (`theothernt/AerialViews`, `app/src/main/res/raw/`: `tvosNN.json` = the
Apple TV screen saver – the highest version available is chosen – `comm1/comm2.json` = Jetson Creative
and Robin Fourcade, `fireos8.json` = Amazon Fire TV; names and captions from `*_strings.json`, and Swedish
ones from `raw-sv/` when the hub's language is Swedish). The screen saver plays one video at a time in
its own `<video id="ambient-video">` (muted, fading through black between videos) and shows the video's
name and the captions (`poi`) at the bottom right. Sources are chosen with `ambient.sources` and quality
with `ambient.quality` (`hd` 1080p ≈ 2–3 GB/hour, `uhd` 4K ≈ 4–6 GB/hour, `hdr` = Apple's 4K Dolby Vision
profile 5, up to 11 GB/hour; all HEVC 10-bit). If a video can't be played, a lower quality is tried, and
after three errors in a row the images are shown. After `ambient.maxMinutes` (60) the images take over
for the rest of the screen saver.

* The TV has a single active video player: the screen saver stops the preview on the home screen first,
  and releases its video at the first key press or when another app takes over the screen. The screen
  saver never starts while you are watching (the player blocks it).
* **Apple's video server** (`sylvan.apple.com`) has a certificate under Apple's own root, which neither
  the TV nor Node trusts (on the TV: `openssl s_client` → "unable to get local issuer certificate"). Those
  videos therefore go through the hub (`/api/wallpapers/video`, `hub/lib/aerialproxy.mjs`), which checks
  the certificate against exactly "Apple Root CA" (included in the file) and passes the bytes on
  untouched – ~300 Mbit/s measured. The TV fetches the other videos (GitHub, Amazon's CDN) directly.

## 3. The service on the TV (`com.g3custom.launcher.service`)

| Method | Response |
| --- | --- |
| `status` | `{ root: bool, elevated: bool, node, version, autostart: { installed, running, launch, homeButton } }` |
| `apps` | `{ apps:[{ id, title, icon, iconColor, bgColor, bgImage, systemApp, removable, lptype, params }], inputs:[{ id:'HDMI_3', appId, label, port, connected, icon }] }` (needs root, otherwise `errorCode` `NOT_ROOT`) |
| `image` `{ path }` | `{ mime, data /* base64 */, size }` (only image files under /usr, /media, /mnt) |
| `fetch` `{ url, timeout, pick, maxBytes }` | `{ status, contentType, body }` (HTTP without CORS) |
| `autostart` `{ enable?, homeButton?, remove? }` | installs or updates `/var/lib/webosbrew/init.d/90-g3custom` and answers `{ autostart }`. `enable` = start the launcher at power-on (flag file `g3custom_nolaunch`), `homeButton` = the watcher takes over when LG's home screen opens (`g3custom_nohome`), `remove: true` stops the watcher and removes the script. |
| `media` `{ op, mediaId, … }` | switches audio track or subtitle in the player (`com.webos.media`) |
| `power` `{ op: 'off' }` | turns the TV off (the sleep timer) |
| `screen` `{ op: 'off'\|'on'\|'toggle'\|'state' }` | turns the screen off/on, the sound continues → `{ state }` |
| `lgHome` | shows LG's own home screen: creates `/tmp/g3custom-lghome` (the watcher then doesn't take over) and starts `com.webos.app.home` |
| `keys` `{ op: 'get' }` | `{ screenoff: code\|null, hook: { installed, active } }` |
| `keys` `{ op: 'learn', timeout }` | the next button pressed on `/dev/input/event*` → `{ code, reserved }` |
| `keys` `{ op: 'set', action: 'screenoff', code }` / `{ op: 'clear', action }` | adds/removes our line in LG Input Hook's `keybinds.json` (`exec` → `90-g3custom screen toggle`). Home, OK, arrows etc. are refused; other people's shortcuts are not overwritten. |
| `remind` `{ items?: [{ id, at, title, message, params, watch, close }] }` | reminders: the service keeps the time and shows a box with a "Watch now" button (starts the launcher with `params`, e.g. `{ action:'tune', channel }`). The service has no dictionaries, so the launcher sends the button labels along (`watch`, `close`) in its own language. Saved in `/var/luna/preferences/g3custom_reminders.json`; the service doesn't shut down while something is pending. Without `items`: read the list. |
| `ping` | `{ node, uid }` |

The init script lifts the service at every boot, lifts it again after a reinstall (checked every 20 s)
and starts the launcher at power-on/wake-up. If the launcher isn't running (after a reinstall, or closed
by the TV), it is started in the background with `preload` – straight after a reinstall, otherwise at a
check every five minutes. It also starts LG Input Hook, lets LG's home screen through when it was opened
on purpose (the flag is removed when another app comes to the front), and has
`90-g3custom screen [off|on|toggle]` (at most one switch per two seconds) and `90-g3custom lghome`.
The first time: `npm run tv -- root` (SSH), or run the command shown under Settings › Use as home screen.

## 4. Settings pages from other modules

`settings.js` merges `window.SETTINGS_PAGES` (an object `{ id: factory(h) }`) with its own pages.
`factory(h)` returns `{ title, icon, desc, rows }` and gets the helpers
`h.toggle, h.nav, h.action, h.note, h.info, h.pick(label, options, current, apply), h.edit(opts, apply),
h.render, h.moveInList`. `Router.go('settings', { section, root: true })` opens a page as the top one
(Back leaves the settings) – that is how the TV app opens its pages: `iptv` (overview), `iptv-source`,
`iptv-nav`, `iptv-live`, `iptv-player`, `iptv-lang`, `iptv-reminders`, `iptv-clean`, `iptv-cats`
(visible live categories in Direct mode; in Hub mode that is done in the web admin).

## 5. Design system (Liquid Glass, `css/base.css`)

* Safe area: 80 px at the sides, 60 px at the top and bottom (Apple HIG). Grid: 5 columns of 320 px,
  40 px gaps.
* Glass (`.glass`, `.glass-clear`) only for navigation and controls: tab row, menus, buttons, playback
  controls, status pills. Never for content (tiles, posters).
* Focus on content: scale (1.1), soft shadow through a pseudo-element (only opacity is animated), a
  specular shine that sweeps across the surface, edge light. Only `transform`/`opacity` are animated.
* `body.lite` swaps `backdrop-filter` for an almost opaque fill (Performance mode).
* Glass on top of video (full screen, the channel list, the movie player) has no `backdrop-filter`: the
  video sits in a hardware layer that can't be blurred, so the blur only cost GPU time.
* Tiles and posters have no GPU layer of their own when idle; shelves in Movies/Series have
  `content-visibility: auto`.
* Classes: `.btn` (`.btn-glass`, `.btn-primary`), `.pill`, `.chip`, `.list-row`, `.switch`,
  `.tile` (app, 320×192), `.card` (16:9), `.poster` (2:3), `.shelf`/`.shelf-viewport`/`.shelf-track`,
  `.progress`, `.layer`/`.sheet`, `.toast`, typography `.t-large/.t-title/.t-head/.t-body/.t-callout/.t-caption`.

## 6. Packaging, performance and tests

**The package** (`npm run deploy`, `npm run tv -- package`, see `scripts/lib.mjs`): all `<script>` tags in
`index.html` are packed in order into `app.js`, those with `data-lazy="iptv-ui"` into `iptv-ui.js`, and
all stylesheets into `css/app.css` – minified with esbuild for Chromium 132. `data-dev` scripts (the
fake TV) are left out. `config.local.js` is packed in if it exists. The TV's web engine has no code cache
for apps from `file://`, so fewer and smaller files give a faster cold start. `--no-bundle` gives the
unbundled files (for `npm run tv -- inspect`). `npm run dev:build` tries the package in the browser.

**Lazy loading** (`js/iptv/lazy.js`): the TV view's UI (tabs, full screen, movie player, guide, search)
is in `iptv-ui.js` and is loaded when the TV view opens, or when the TV has been idle for ~1.5 s after
start-up. `IPTV.open` and `IPTV.openItem` already work before that (they wait for the file).

**Start-up and return:** bootstrap is compared part by part; unchanged = no `change`, and the hub answers
`{ same: true }` to `?since=`. The home screen only rebuilds sections whose HTML has changed. With
`handlesRelaunch`, the app switches to the home screen before it is brought to the front.

**Measurement** (`js/core/perf.js`): `npm run tv -- perf` reads the launcher's measurements from the TV
through an SSH tunnel to remote debugging: start-up times, key press → next frame (median/90 %), channel
change → first video frame per format (`live m3u8`, `live ts`, `vod mp4` …), long tasks, JS memory and
the number of DOM elements. `--reload` measures a reload, `--json` gives the raw data, `--clear` resets
the channel changes.

**Tests:** `npm test` = the translation check (`scripts/i18n-check.mjs`, §7) + the hub's smoke test +
the stream proxy and subtitle extraction (`hub/test/subs.mjs`: an .mkv built with ffmpeg, a fake provider
with redirects and Range) + the wallpapers and aerial videos (`hub/test/wallpapers.mjs`: the sources'
parsers against small samples, disk cache, selection, the video proxy against a fake video server;
`hub/test/wallpapers-live.mjs` runs the real sources by hand) + the watcher against a fake TV
(`scripts/init-test.mjs`: the Home button, LG's home screen, screen off, Input Hook) + the service's
methods (`scripts/service-test.mjs`: screen off, learning a button, `keybinds.json`) + the UI test
(`scripts/ui-test.mjs`) against the source files in Swedish and in English (`--lang en`), and against
the package (`--build`). The UI test runs the launcher in a local headless Chrome with its own demo hub
and presses the remote through the DevTools protocol (home screen, navigation, the tab row and channel
list with OK, zapping, colour buttons, the Back paths, the guide with catch-up and a reminder, programme
search, movies, and the player in simulated TV mode: `mediaOption`, track lists in `umsmediainfo` and
subtitles through `video.send`; plus the Wallpaper page and the screen saver with aerial videos). The dev
server is then started with `--demo-wallpapers`, so that the hub serves fake collections and fake videos
instead of fetching from the internet.

## 7. Languages (i18n)

Everything the user reads is in **English** or **Swedish**. English is the reference: every key must
exist in `en`, and a missing key in another language falls back to English, then to the key itself.
Three sets of dictionaries, one per place the text is shown:

| Where | Core | Dictionaries | Language chosen by |
| --- | --- | --- | --- |
| The launcher (TV) | `apps/launcher/js/core/i18n.js` | `apps/launcher/js/i18n/{en,sv}.js` | Store key `language`, else the TV's menu language |
| The web admin (browser) | `hub/web/i18n.js` | `hub/web/i18n/{en,sv}.js` | "Language on this page", else the browser's languages |
| The hub's own messages | `hub/lib/i18n.mjs` | `hub/lib/locales/{en,sv}.mjs` | the request (`?lang=`, `Accept-Language`), else the hub's language |

All three use the same format: nested keys (`tv.favAdded`), placeholders `{name}`, and plural forms as
a value `{ one, other }` chosen by `vars.n` with `Intl.PluralRules`.

### The launcher

* `tr('ns.key', vars)` is global (don't call it `t`, that is a common local variable). `I18n.lang` is the
  active language (`'en'|'sv'`), `I18n.locale` the BCP 47 tag for `Intl` and `toLocale*` (the TV's own
  tag if it matches the language and has a region, otherwise `en-GB` or `sv-SE`), `I18n.pref()` the
  user's choice and `I18n.langs` the list for the picker.
* **Choosing the language.** The Store key `language` is `'auto' | 'en' | 'sv'` (default `'auto'` from
  `LAUNCHER_DEFAULTS.language` in `config.js`; `config.local.js` can override it). `'auto'` takes the
  first entry in `navigator.languages` that has a dictionary, which on the TV is the menu language, and
  falls back to English. The user changes it under Settings › Language. The language is fixed when the
  app starts, so `I18n.set(id)` saves the choice, flushes the Store and reloads the app.
* **Migration.** Launchers installed before the language setting existed were Swedish-only. At start-up,
  if the saved settings (`g3:settings:v1`) exist but have no `i18n` flag and no `language`, `language` is
  set to `'sv'`. Then `i18n: 1` is saved so this only happens once. A fresh install has no saved settings
  and stays on `'auto'`.
* **Talking to the hub.** Every JSON request in Hub mode (`IPTV.source.hub` in `js/iptv/source.js`, which
  wallpapers and aerial videos also use) sends `Accept-Language: <I18n.lang>`, so errors, playlist
  statuses, wallpaper collection names and episode lines come back in the TV's language. The TV's
  EventSource sends no language; its `rev` and `continue` events carry no text.
* **The service** has no dictionaries. Where it shows text itself, the launcher sends it along: the
  reminder box gets its button labels in `remind` (`watch`, `close`, §3).
* Missing keys are logged once (`[i18n] missing`) and collected in `I18n.missing`.

### The hub

* **The request's language** (`langOf(req)`): `?lang=` first (EventSource can't set headers, so the web
  admin's `/api/events?admin=1` uses it), then the best `Accept-Language` tag that has a dictionary, then
  the hub's language.
* **Errors.** `HttpError(status, key, vars)` and `LocalError(key, vars)` carry a key and variables.
  `sendError` translates them into the request's language when the response is sent, as `{ error }`.
  `e.message` is always English, for the log.
* **Stored messages.** Statuses that are saved and shown later (a playlist's `step`, `error` and
  `warnings`, wallpaper list errors, the "Continue watching" episode line) are stored as `{ key, vars }`
  (`msg()`) and translated when read, for the reader's language. Old stored plain strings are shown as
  they are. The admin SSE `status` event is built once per language among the connected clients.
* **The hub's language** is `settings.language` (`'en'|'sv'`), set in the web admin under Settings ›
  Language › Hub language or with `PUT /api/admin/settings { language }`. It is the fallback for requests
  that don't name a known language (curl, old launchers), and it drives content defaults:
  * the TMDB language: `tmdbLanguage` if set, otherwise `sv-SE` or `en-US`;
  * the Bing market (`mkt`) for Picture of the day: `sv-SE` or `en-US`;
  * Swedish aerial video captions (`raw-sv/`) only when the hub is Swedish;
  * the names of the hub's own index sets (e.g. "Uncategorised"), which is why changing the language
    rebuilds the index.

  TMDB lookups already in `tmdb.json` keep their language until they expire, and the Bing and aerial
  lists use the new language the next time they are fetched.
* **Migration.** A data directory whose `config.json` exists but has no `settings.language` comes from a
  Swedish-only hub and gets `'sv'` (saved straight away). A fresh data directory gets `'en'`. A restored
  backup without `settings.language` also becomes `'sv'`. An unknown value becomes `'en'`. The start-up
  log line shows the language.

### The web admin

`hub/web/i18n.js` works like the launcher's. "Language on this page" (`'auto'|'en'|'sv'`) is stored only
in that browser (`localStorage` key `g3hub:lang`); `'auto'` follows the browser's languages. The page
sends `Accept-Language` on its API calls and `?lang=` on its event stream, so the hub's messages match
the page. "Hub language" next to it is the hub-wide `settings.language` above.

### Adding a language

1. **Launcher:** copy `apps/launcher/js/i18n/en.js` to `<id>.js`, change `I18n.add('en', …)` to the new
   id and translate. Add a `<script>` tag for it in `apps/launcher/index.html` after `en.js` (the package
   picks it up from there) and an entry `{ id, name, locale }` in `LANGS` in `js/core/i18n.js`.
2. **Web admin:** the same with `hub/web/i18n/en.js`, a `<script>` tag in `hub/web/index.html` and
   `LANGS` in `hub/web/i18n.js`.
3. **Hub server:** copy `hub/lib/locales/en.mjs`, import it in `hub/lib/i18n.mjs` and add it to `LANGS`,
   `DICTS`, `LOCALES` and `REGIONS` (the TMDB language and Bing market). The web admin's hint for an
   empty TMDB language (`tmdbAuto` in `hub/web/app.js`) mirrors `REGIONS`.
4. Run `npm run i18n:check`. It finds the new files by itself and fails if a key, a plural form or a
   placeholder differs from English.
