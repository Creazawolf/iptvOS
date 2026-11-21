#!/usr/bin/env bash
# Creates a Debian 12 container for G3 Hub on Proxmox VE and installs the hub in it.
# Run as root on the Proxmox host, from inside a copy of the hub/ folder:
#
#   bash deploy/proxmox-create-lxc.sh [CTID]
#
# Environment variables (all optional):
#   CTID              next free id
#   CT_HOSTNAME       g3hub
#   STORAGE           local-lvm      (root disk)
#   TEMPLATE_STORAGE  local          (where the template is stored)
#   BRIDGE            vmbr0
#   IP                dhcp           or e.g. 192.168.1.20/24 (requires GW)
#   GW                gateway for a static IP
#   CORES=1  MEMORY=1024  DISK=4 (GB)  PORT=8787
#   PASSWORD          root password in the container (randomised if empty, and printed)
#   SSH_KEY           path to a public key that is added for root (e.g. ~/.ssh/authorized_keys)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v pct >/dev/null 2>&1 || die "pct is missing – run this script on the Proxmox host"
[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$SRC/server.mjs" ] || die "can't find the hub's files in $SRC"

CTID="${1:-${CTID:-$(pvesh get /cluster/nextid)}}"
CT_HOSTNAME="${CT_HOSTNAME:-g3hub}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"
CORES="${CORES:-1}"
MEMORY="${MEMORY:-1024}"
DISK="${DISK:-4}"
PORT="${PORT:-8787}"
PASSWORD="${PASSWORD:-}"
GENERATED=0
if [ -z "$PASSWORD" ]; then
  # (head closes the pipe early; with pipefail that would otherwise abort the script with SIGPIPE)
  PASSWORD="$( (tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20) 2>/dev/null || true)"
  GENERATED=1
fi

if pct status "$CTID" >/dev/null 2>&1; then
  die "CT $CTID already exists. Update it with deploy/update.sh instead, or choose another id."
fi

# --- Template ----------------------------------------------------------------------------------
say "Looking for the Debian 12 template"
pveam update >/dev/null 2>&1 || true
TEMPLATE="$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "found no debian-12-standard template (pveam available)"
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  say "Downloading $TEMPLATE"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null
fi

# --- Container ----------------------------------------------------------------------------------
NET="name=eth0,bridge=$BRIDGE,ip=$IP"
if [ "$IP" != "dhcp" ]; then
  [ -n "${GW:-}" ] || die "a static IP needs GW"
  NET="$NET,gw=$GW"
fi

say "Creating CT $CTID ($CT_HOSTNAME)"
EXTRA=()
if [ -n "${SSH_KEY:-}" ] && [ -f "${SSH_KEY}" ]; then EXTRA+=(--ssh-public-keys "$SSH_KEY"); fi
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" \
  --description "G3 Hub – IPTV hub for the LG launcher. Web admin on port $PORT." \
  --tags g3hub \
  --cores "$CORES" --memory "$MEMORY" --swap 256 \
  --rootfs "$STORAGE:$DISK" \
  --net0 "$NET" \
  --unprivileged 1 --features nesting=1 \
  --onboot 1 \
  --password "$PASSWORD" \
  ${EXTRA[@]+"${EXTRA[@]}"} >/dev/null
pct start "$CTID"

say "Waiting for the network in the container"
CT_IP=""
for _ in $(seq 1 60); do
  CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | tr ' ' '\n' | grep -v ':' | head -1 || true)"
  if [ -n "$CT_IP" ] && pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  sleep 2
done
[ -n "$CT_IP" ] || die "the container got no IP address"

# --- Install the hub ------------------------------------------------------------------------------
say "Copying the hub to the container"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -C "$SRC" --exclude=./data --exclude=./node_modules --exclude='._*' --exclude=.DS_Store -czf "$TMP/g3hub.tgz" .
pct push "$CTID" "$TMP/g3hub.tgz" /root/g3hub.tgz

say "Installing (Node.js, systemd service)"
pct exec "$CTID" -- bash -c "set -e
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl >/dev/null
  rm -rf /root/g3hub-src && mkdir -p /root/g3hub-src
  tar -xzf /root/g3hub.tgz -C /root/g3hub-src
  G3HUB_PORT=$PORT bash /root/g3hub-src/deploy/install.sh"

echo
say "G3 Hub is running in CT $CTID"
printf '   Web admin:  \033[1mhttp://%s:%s\033[0m\n' "$CT_IP" "$PORT"
printf '   On the TV:  Settings › IPTV › Hub › http://%s:%s\n' "$CT_IP" "$PORT"
if [ "$GENERATED" = 1 ]; then printf '   Root password in the container: %s\n' "$PASSWORD"; fi
echo "   Tip: give the container a fixed address in your router (DHCP reservation) so the TV always finds it."
