# G3 Hub

**[Svenska](README.sv.md)** · [Main README](../README.md) · [Architecture](../docs/ARCHITECTURE.md)

The IPTV hub for the launcher. It runs on your Proxmox server (or any computer with Node 18 or later) and does the heavy work:

- **Fetches your playlists** (Xtream Codes or M3U) and keeps a copy, so the TV starts quickly even when the provider is slow.
- **Remembers your selection:** which categories are shown, in what order, and your favourite channels. Of 22,000 channels, the TV only downloads the ones you chose.
- **Movies and series** with covers and plots, and "Continue watching" that carries over from one session to the next. With a TMDB key, the hub fills in missing covers.
- **Fast search** across everything, also without accents ("skargard" finds "Skärgård").
- **A web admin** that works from your phone. Changes show up on the TV straight away, and what you star on the TV shows up in the web admin straight away.
- **English and Swedish** on the TV, in the web admin and in the hub's own messages. See [Language](#language).

## Install on Proxmox

The easiest way is to run this from your computer, in the repo's root folder. The script creates a Debian 12 container on the Proxmox host and installs the hub in it:

```bash
hub/deploy/update.sh --create root@<proxmox-ip>
```

By default the container gets 1 core, 1 GB RAM, a 4 GB disk on `local-lvm` and an address from DHCP on `vmbr0`, and it starts when the host starts. You can change that with environment variables, and give a container ID as the last argument (otherwise the next free one is used). For example:

```bash
IP=192.168.1.20/24 GW=192.168.1.1 STORAGE=local-zfs hub/deploy/update.sh --create root@<proxmox-ip> 120
```

| Variable | Default | |
| --- | --- | --- |
| `IP` | `dhcp` | Or a fixed address such as `192.168.1.20/24`, which also needs `GW` |
| `GW` | – | The gateway, for a fixed address |
| `STORAGE` | `local-lvm` | Storage for the root disk |
| `TEMPLATE_STORAGE` | `local` | Where the Debian template is downloaded |
| `BRIDGE` | `vmbr0` | Network bridge |
| `CORES`, `MEMORY`, `DISK` | `1`, `1024` (MB), `4` (GB) | |
| `PORT` | `8787` | The hub's port. Images use the next port. |
| `CT_HOSTNAME` | `g3hub` | |
| `PASSWORD` | random | Root password in the container. A random one is printed at the end. |
| `SSH_KEY` | – | A public key file **on the Proxmox host** (for example `/root/.ssh/authorized_keys`) whose keys are added for root in the container |

You can also copy the `hub/` folder to the Proxmox host and run `bash deploy/proxmox-create-lxc.sh [CTID]` there as root.

When the script is done, it prints the address, for example `http://192.168.1.20:8787`. Give the container a fixed address in your router so the TV always finds it.

**Update later:**

```bash
hub/deploy/update.sh root@192.168.1.20             # directly to the container (SSH to the LXC)
hub/deploy/update.sh --pve root@<proxmox-ip> 120   # through the Proxmox host (pct), no SSH to the container needed
```

**Another Debian or Ubuntu machine:** copy the `hub/` folder there and run `bash deploy/install.sh` as root inside it. It installs Node.js if needed, tries to install `sharp` and sets up the systemd service `g3hub`. The same script updates. Options: `G3HUB_PORT` (default `8787`) and `G3HUB_SHARP=0` to skip `sharp`. The hub goes to `/opt/g3hub` and its data to `/var/lib/g3hub`, which updates don't touch. Logs: `journalctl -u g3hub -f`.

**By hand:** `node hub/server.mjs [--port 8787] [--data <dir>] [--host <address>] [--img-port <port>]`, or the environment variables `G3HUB_PORT`, `G3HUB_DATA`, `G3HUB_HOST` and `G3HUB_IMG_PORT`.

## Language

The hub speaks English and Swedish. There are two settings, both in the web admin under **Settings › Language**:

- **Language on this page** is the web admin's own language. *Automatic* follows your browser. It is saved only in that browser, so everyone can have their own.
- **Hub language** applies to the whole hub. The launcher tells the hub its language on every call (the TV's menu language, or what you chose under Settings › Language on the TV), so the TV always gets messages and statuses in its own language. The hub language is the fallback for requests that don't say, and it sets these defaults:
  - the **TMDB language** for plots, while the *TMDB language* field is empty: `en-US` for English, `sv-SE` for Swedish. Fill in the field, for example `en-GB`, to choose another;
  - the market for Bing's **Picture of the day** wallpapers;
  - Swedish captions on the **aerial videos** (only when the hub is Swedish);
  - names the hub makes up itself, such as "Uncategorised".

A new hub starts in English. A hub that already existed before the setting was added, or a backup from one, stays Swedish. You can change it at any time. Plots already fetched from TMDB keep their old language for up to 60 days, and the Picture of the day and aerial video lists switch the next time they are fetched.

## Using the web admin

1. **Playlists › Add playlist:** enter the server, username and password for Xtream, or an M3U address. Press *Test* and then *Add*. Fetching takes a few seconds to a minute.
2. **Live categories:** at first, only categories that look Swedish or Nordic are shown (if there are none, the first five). Filter on, for example, "sport" or a country prefix ("UK", "SE"), turn on what you want and drag the categories into the order you want on the TV. *Hide everything* clears the selection.
3. **Channels:** search all channels and star your favourites. They go to the top of the TV guide and onto the home screen.
4. **Favourites:** drag to change the order.
5. **Movies and Series:** choose which categories become rows in the TV app.
6. **Settings:**
   - **Name:** shown on the TV.
   - **Refresh lists:** how often the lists are fetched again.
   - **Image proxy:** whether images go through the hub.
   - **Language:** see [Language](#language).
   - **TMDB API key:** optional, free at [themoviedb.org](https://www.themoviedb.org/settings/api). **TMDB language:** empty follows the hub language.
   - **Admin token:** a password for the web admin.
   - **TV token:** if the TV should need a key.
   - **Backup:** *Download* saves playlists (with passwords), selections, favourites, settings and Continue watching in one file. *Restore…* reads such a file back; channels and images are then fetched again. The current admin and TV tokens are kept.

If the provider has blocked the hub for a while (HTTP 403/429), it shows at the top of the overview page, with the time when the hub will try again.

## Connect the TV

On the TV, open **Settings › IPTV** in the launcher, choose **Hub** and enter the hub's address, for example `http://192.168.1.20:8787`. Also enter the TV token if you have set one. The address is shown on the web admin's overview page.

The hub answers on two ports: **8787** for the API and the web admin, and **8788** for images (`/api/img`). The TV only has six connections at a time per address and port, so a slow image mustn't keep the guide and the detail pages waiting. The TV gets the image address from the hub (`imgBase` in bootstrap) and needs no setting. Another port: `--img-port` or `G3HUB_IMG_PORT`; `0` puts everything on the main port.

Without the hub, the launcher's Direct mode still works, against a single Xtream server.

## Development

```bash
npm run dev          # the launcher on :8080 + a hub with demo data on :8787
npm run hub          # only the hub (data in build/hub-data)
node hub/test/smoke.mjs   # smoke test of every API route against the demo provider (also in npm test)
node hub/test/bench.mjs   # response times with 22,000 channels and 30,000 movies
```

The demo provider is in `scripts/dev-mocks.mjs` and has about 22,000 channels in about 400 categories, 3,000 movies and 400 series. The API is described in [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md#1-the-hubs-api-hub-default-port-8787), and how languages work in [§7](../docs/ARCHITECTURE.md#7-languages-i18n). The hub's texts are in `hub/lib/locales/` (server messages) and `hub/web/i18n/` (the web admin); `npm run i18n:check` checks that every key exists in every language.

No dependencies are needed. If the package [`sharp`](https://sharp.pixelplumbing.com) is installed, the hub scales images down, and the install script tries to install it automatically.

## Through a VPN (WireGuard)

The hub's own traffic can go through a WireGuard profile, for example from Mullvad: lists, EPG, images and TMDB. A kill switch stops all outgoing traffic that doesn't go through the tunnel. The TV and the web admin on your home network reach the hub as usual.
Copy `hub/deploy/wireguard.sh` and your profile to the Proxmox host and run, as root:

```bash
bash wireguard.sh <CTID> profile.conf [192.168.1.0/24]
```

The last argument is your home network, the one the TV is on, which can still reach the hub outside the tunnel. Without it, the script uses the container's own network. Check the result with `pct exec <CTID> -- curl -s https://am.i.mullvad.net/connected`. To undo: `pct exec <CTID> -- systemctl disable --now wg-quick@wg0 g3-killswitch`, then restore `/etc/resolv.conf` and remove `/etc/.pve-ignore.resolv.conf` in the container.

> Live TV goes directly from the provider to the TV, not through the hub or the tunnel. Movies and episodes only go through the hub when the launcher draws the subtitles of an `.mkv` file, and Apple's aerial videos always do.
>
> **Important:** never use the same WireGuard profile (the same key) in the hub and in the router at the same time.
> Mullvad's files for different servers (`se-sto-wg-001`, `-002` …) belong to the same device and key. If you
> already run a VPN in the router, it is easier to add the hub's IP address to the router's VPN list instead.

## Kind to the provider

Xtream panels block IP addresses that send too many requests (they answer 403 to everything). So:

- **Pace:** the hub sends at most about 2.5 requests per second to the provider's API.
- **Pause:** on 403 or 429 (or 503, 509, 513) it pauses for 15 minutes, then longer (at most 2 hours) if the block is still there.
- **EPG:** fetched as **one** file (`xmltv.php`) every 12 hours. Only the channels in your visible categories and favourites are kept, on disk too. Channel-by-channel EPG is only used if `xmltv.php` doesn't work. Channels outside the selection that the TV watches anyway (for example through "search all channels") are included in the next download; a new selection gives a new download at the earliest after 3 hours.
- **All requests to the provider's hosts** follow the pace and the pauses – also logos on the panel's own server, and straight after a restart. The provider's own API calls go before queued images. A 403 on single images only counts once it happens three times within two minutes.
- **Across restarts:** pauses and fetches in progress are saved in `runtime.json`. If the hub dies in the middle of a fetch, it waits 30 minutes before the next attempt instead of starting over straight away.
- **Detail pages** (movies and series) are saved on disk (`cache/info/`): movies count as fresh for 7 days and series for 12 hours. Older ones are shown straight away while a new version is fetched in the background, and if the provider doesn't answer, the old one is kept.
- **Images:** the original is fetched once; all sizes are made from it, in the hub. Addresses that don't answer rest for 30 minutes.

## Catch-up and programme search

Channels where the provider keeps recordings (`tv_archive` in Xtream) get `catchup` and `catchupDays`. For them the hub also keeps past programmes (at most 7 days back), and `/api/live/catchup` gives the address of a past programme, with the start time in the provider's time zone. The guide on the TV marks such programmes with ↺, and OK plays them. `/api/epg/search` searches the guide among your channels.
