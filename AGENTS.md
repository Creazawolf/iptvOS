# AGENTS.md

Guidance for AI coding agents working in this repository, or helping someone install it on their TV. Read [README.md](README.md) first; it is the user-facing source of truth. This file adds what an agent needs to act safely and check its work.

## What this is

iptvOS: a replacement home screen ("launcher") for LG webOS TVs, with built-in IPTV, plus an optional server ("the hub"). Three parts:

| Part | Path | Runs on | Notes |
| --- | --- | --- | --- |
| Launcher | `apps/launcher/` | The TV (web app, Chromium, 1920×1080) | Vanilla JS, no framework, no modules: each file is an IIFE loaded by a `<script>` tag in `index.html`. `scripts/lib.mjs` bundles them for the TV. |
| Service | `apps/launcher/service/` | The TV, as root (Node 20) | App list, HDMI inputs, icons, autostart, fetch without CORS, reminders, sleep timer. It is lifted to root by the Homebrew Channel through `service/g3custom-init.sh`. |
| Hub | `hub/` | A small Linux server (Node 18+, no npm dependencies) | Caches Xtream/M3U playlists, EPG, artwork; web admin on port 8787. Optional. |

Architecture, APIs, storage keys and known TV facts: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Hub setup: [hub/README.md](hub/README.md).

## Ground rules

- **Rooting.** This project requires a rooted TV with the Homebrew Channel, but it does not root TVs. Don't write rooting or exploit instructions. Send the user to the official resources: [CanI.RootMy.TV](https://cani.rootmy.tv/) to check model and firmware, and [webosbrew.org/rooting](https://www.webosbrew.org/rooting/) for the guide. Pick up again once the Homebrew Channel is installed and SSH is on.
- **No content.** The project ships no channels or streams. Don't help find IPTV providers, playlists or ways around a provider's limits. The user brings their own subscription.
- **Secrets.** Never print, log, commit or send anywhere: `apps/launcher/config.local.js` (may hold IPTV credentials), the hub's data directory (`config.json` holds playlist credentials and tokens), webOS Dev Manager's device file (`~/.webos/*/novacom-devices.json`, holds the TV's SSH password or key), and the user's IP addresses in anything public. `.gitignore` already excludes the first two.
- **The TV is the user's.** Commands that change the TV (`deploy`, `root`, `screen`, `key`, `uninstall`, anything over SSH) need the user's go-ahead. Every `npm run tv` command accepts `--dry-run`; use it to show what would happen. `status`, `device`, `shot` and `eval` without arguments only read.
- **Keep both languages.** All UI text goes through `tr('key')`. Never add a user-visible string without adding the key to both dictionaries (see [Translations](#translations)).

## Helping someone install

Work through these in order. Each step says how to check it before moving on.

| # | Step | Check |
| --- | --- | --- |
| 1 | TV can be rooted, is rooted, and has the Homebrew Channel | The user confirms the Homebrew Channel app opens and shows root status. If not: the official resources above, then stop. |
| 2 | SSH is on in the Homebrew Channel's settings; the TV has a fixed IP | `ssh root@<tv-ip>` works from the computer (the user types the password; don't ask for it in chat). |
| 3 | Node.js 18+, npm and git on the computer | `node -v` |
| 4 | `npm install` in the repo | Exit code 0 |
| 5 | The TV is known: webOS Dev Manager (user `root`, port 22) or `npm run tv -- setup <tv-ip> root` | `npm run tv -- device` prints the TV |
| 6 | `npm run deploy` | The launcher appears on the TV |
| 7 | `npm run tv -- root` (once) | `npm run tv -- status` shows the watcher running and the service answering with root |
| 8 | LG Input Hook from the Homebrew Channel; bind Home to *Execute* with the command in README › Install › step 4 | Pressing Home opens the launcher. If Input Hook claims root is missing, see README › Troubleshooting. |
| 9 | IPTV, if wanted: Settings › IPTV › Direct (Xtream Codes) or Hub | The TV app's Live tab lists channels |
| 10 | Hub, if wanted: `hub/README.md` (Proxmox script, `hub/deploy/install.sh` on Debian/Ubuntu, or `node hub/server.mjs`) | `curl http://<hub>:8787/api/health` answers; the web admin opens |

Choosing between hub and direct: README › "With or without the hub". In short, direct needs only an Xtream Codes account; M3U, very large playlists, a web admin, TMDB artwork, launcher-drawn `.mkv` subtitles, extra wallpapers and aerial videos need the hub.

Useful when diagnosing:

- `npm run tv -- status`: watcher, service, Input Hook, foreground app.
- `npm run tv -- shot`: screenshot of what the TV shows (saved to `dist/tv-shot.jpg`); look at it.
- `npm run tv -- eval '<js>'`: run an expression in the launcher on the TV, for example `I18n.lang`, `IPTV.mode()`, `Store.get('iptv')` (careful: that last one contains credentials, don't echo it back in full).
- `npm run tv -- perf`: start-up and key-press timings.
- Hub: `GET /api/health`, and the web admin's overview page (`/api/admin/status`).

## Working on the code

```bash
npm install
npm run dev          # http://localhost:8080: launcher + local hub with demo data, keys simulate the remote
npm test             # translations, hub tests, service/watcher against a fake TV, UI test in Chrome (sv + en)
npm run i18n:check   # fast: every translation key exists in every language
```

- **The TV is slow.** The launcher runs on a TV's browser; keep hot paths (lists, the EPG grid, key handling) cheap. Build `Intl` formatters once, not per item. `npm run tv -- perf` measures on the real TV.
- **No dependencies at runtime.** The launcher and hub use no npm packages at runtime. Dev dependencies are build/test tools only.
- **Style.** 2 spaces, single quotes, semicolons, IIFEs in the launcher, ES modules in the hub and scripts. Comments, logs and docs are in English (README.sv.md and hub/README.sv.md are the Swedish user docs).
- **Tests.** `scripts/ui-test.mjs` drives the real UI in headless Chrome with fixed ports (8191/8193 and the demo hub on 8898/8899), so don't run two at once. It runs in Swedish by default; `--lang en` runs it in English. Hub tests are in `hub/test/`.
- **Remote, not mouse.** Everything must work with the arrow keys, OK, Back and the colour buttons (`shared/nav.js`). Nothing may change just because the cursor moved: the user presses OK to switch tabs or channels.

### Translations

- Launcher: `tr('ns.key', vars)` (global; don't name it `t`, that is a common local variable here). Dictionaries: `apps/launcher/js/i18n/en.js` (reference) and `sv.js`. Keys are grouped by module, for example `tv.*`, `settings.*`, `common.*`.
- Placeholders: `{name}`. Plurals: a value `{ one, other }` and pass `{ n }`.
- Dates, numbers and sorting: use `I18n.locale`, never a hard-coded locale.
- Values are inserted as-is: escape user or provider data before passing it as a variable if the result goes into `innerHTML`.
- The hub has its own: `hub/web/i18n/*.js` for the web admin and `hub/lib/locales/*.mjs` for server messages, which follow the request's `Accept-Language` (the launcher sends its language).
- `npm run i18n:check` fails if a key is missing in any language or the placeholders differ.
- New language: copy `en.js`, translate it, add a `<script>` tag in `apps/launcher/index.html` and an entry in `LANGS` in `apps/launcher/js/core/i18n.js`, and do the same for the hub.
