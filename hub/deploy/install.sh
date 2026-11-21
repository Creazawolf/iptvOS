#!/usr/bin/env bash
# Installs or updates G3 Hub in a Debian 12/Ubuntu container (or VM).
# Run as root from inside a copy of the hub/ folder:
#
#   bash deploy/install.sh
#
# Environment variables:  G3HUB_PORT (8787)  G3HUB_SHARP (1 = try to install sharp for image scaling)
# The same script is used for updates – data in /var/lib/g3hub is not touched.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/g3hub
DATA=/var/lib/g3hub
PORT="${G3HUB_PORT:-8787}"
SVC_USER=g3hub

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$SRC/server.mjs" ] || die "can't find server.mjs in $SRC"
export DEBIAN_FRONTEND=noninteractive

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# --- Node.js ≥ 18 ---------------------------------------------------------------------
if [ "$(node_major)" -lt 18 ]; then
  say "Installing Node.js"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  cand="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ {print $2}')"
  cand="${cand#*:}"          # remove the epoch (e.g. "1:")
  major="${cand%%.*}"
  if [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 18 ]; then
    apt-get install -y -qq nodejs >/dev/null           # Debian 12: Node 18
  else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
fi
[ "$(node_major)" -ge 18 ] || die "Node.js 18 or newer is needed (found $(node -v 2>/dev/null || echo none))"
NODE="$(command -v node)"
say "Node $("$NODE" -v)"
command -v curl >/dev/null 2>&1 || apt-get install -y -qq curl >/dev/null

# --- User and files ----------------------------------------------------------------------
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP" "$DATA"
if [ "$SRC" != "$APP" ]; then
  say "Copying the hub to $APP"
  rm -rf "$APP/lib" "$APP/web" "$APP/deploy" "$APP/test"
  cp -a "$SRC/server.mjs" "$SRC/package.json" "$SRC/lib" "$SRC/web" "$SRC/deploy" "$APP/"
  if [ -f "$SRC/README.md" ]; then cp -a "$SRC/README.md" "$APP/"; fi
fi
chown -R root:root "$APP"
chown -R "$SVC_USER:$SVC_USER" "$DATA"
chmod 750 "$DATA"

# --- Optional: sharp (scales down logos and covers) ----------------------------------------
if [ "${G3HUB_SHARP:-1}" = 1 ] && [ ! -d "$APP/node_modules/sharp" ]; then
  if ! command -v npm >/dev/null 2>&1; then apt-get install -y -qq npm >/dev/null 2>&1 || true; fi
  if command -v npm >/dev/null 2>&1; then
    say "Installing sharp (image scaling, optional)"
    (cd "$APP" && npm install --omit=dev --no-audit --no-fund --no-save sharp@0.33 >/dev/null 2>&1) \
      || echo "   Couldn't install sharp – images won't be scaled, but everything else works."
  fi
fi

# --- systemd -------------------------------------------------------------------------------
say "Creating the g3hub service"
cat > /etc/systemd/system/g3hub.service <<EOF
[Unit]
Description=G3 Hub – IPTV for the G3 launcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
Environment=NODE_ENV=production
# Large providers (100,000+ films/channels) need more than Node's default limit – but leave
# room for sharp (outside V8's heap) and the system, so that V8 cleans up before the container runs out.
Environment=NODE_OPTIONS=--max-old-space-size=1280
Environment=G3HUB_DATA=$DATA
Environment=G3HUB_PORT=$PORT
WorkingDirectory=$APP
ExecStart=$NODE $APP/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable g3hub >/dev/null 2>&1
systemctl restart g3hub

say "Waiting for the hub to start"
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo
    for ip in $(hostname -I 2>/dev/null); do
      case "$ip" in *:*) ;; *) printf '   \033[1mhttp://%s:%s\033[0m\n' "$ip" "$PORT" ;; esac
    done
    echo
    say "Done. Open the address above in a browser and add your playlist."
    exit 0
  fi
  sleep 0.5
done
systemctl --no-pager status g3hub | tail -20 || true
die "the hub isn't responding – see  journalctl -u g3hub -n 50"
