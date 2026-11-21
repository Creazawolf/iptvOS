#!/usr/bin/env bash
# Send the hub from this computer to the server and install or update it.
#
#   hub/deploy/update.sh root@192.168.1.20              update directly in the container (SSH to the LXC)
#   hub/deploy/update.sh --pve root@proxmox 120          update CT 120 through the Proxmox host (pct)
#   hub/deploy/update.sh --create root@proxmox [CTID]    create a new container on Proxmox and install
#
# With --create, environment variables are passed on to proxmox-create-lxc.sh
# (STORAGE, BRIDGE, IP, GW, MEMORY, DISK, PORT, CT_HOSTNAME, PASSWORD).
set -euo pipefail
# macOS: no ._ files/xattr headers in the tar archive (they cause warnings on Linux).
export COPYFILE_DISABLE=1

HUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

MODE=direct
case "${1:-}" in
  --pve) MODE=pve; shift ;;
  --create) MODE=create; shift ;;
  -h|--help|"") usage ;;
esac
TARGET="${1:-}"
[ -n "$TARGET" ] || usage
CTID="${2:-}"
[ "$MODE" != pve ] || [ -n "$CTID" ] || die "--pve needs a CTID"
PORT="${PORT:-8787}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "Packing the hub"
COPYFILE_DISABLE=1 tar -C "$HUB" --exclude=./data --exclude=./node_modules --exclude='._*' --exclude=.DS_Store -czf "$TMP/g3hub.tgz" .

say "Sending to $TARGET"
scp -q "$TMP/g3hub.tgz" "$TARGET:/tmp/g3hub.tgz"

UNPACK='rm -rf /root/g3hub-src && mkdir -p /root/g3hub-src && tar -xzf /root/g3hub.tgz -C /root/g3hub-src'
case "$MODE" in
  direct)
    ssh -t "$TARGET" "set -e; mv /tmp/g3hub.tgz /root/g3hub.tgz; $UNPACK; G3HUB_PORT=$PORT bash /root/g3hub-src/deploy/install.sh"
    ;;
  pve)
    ssh -t "$TARGET" "set -e; pct push $CTID /tmp/g3hub.tgz /root/g3hub.tgz; rm -f /tmp/g3hub.tgz;
      pct exec $CTID -- bash -c '$UNPACK && G3HUB_PORT=$PORT bash /root/g3hub-src/deploy/install.sh'"
    ;;
  create)
    ENVS=""
    for v in STORAGE TEMPLATE_STORAGE BRIDGE IP GW CORES MEMORY DISK PORT CT_HOSTNAME PASSWORD SSH_KEY; do
      if [ -n "${!v:-}" ]; then ENVS="$ENVS $v=$(printf '%q' "${!v}")"; fi
    done
    ssh -t "$TARGET" "set -e; rm -rf /root/g3hub-deploy && mkdir -p /root/g3hub-deploy && tar -xzf /tmp/g3hub.tgz -C /root/g3hub-deploy && rm -f /tmp/g3hub.tgz;
      env $ENVS bash /root/g3hub-deploy/deploy/proxmox-create-lxc.sh $CTID"
    ;;
esac
