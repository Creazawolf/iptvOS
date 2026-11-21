#!/usr/bin/env bash
# Send the G3 Hub container's internet traffic through a WireGuard profile (e.g. Mullvad), with a kill switch.
# Run as root on the Proxmox host:
#
#   bash wireguard.sh <CTID> <profile.conf> [LAN]
#   bash wireguard.sh 120 mullvad-se.conf 192.168.1.0/24
#
# LAN is the home network that may still reach the hub directly (the TV, the web admin). Without it,
# the container's own network is used: the link route on the interface that has its default route.
#
# What happens:
#   - the wireguard module is loaded on the host (and at every boot)
#   - the profile is installed as wg0 in the container (wg-quick@wg0, starts automatically)
#   - kill switch (nftables): outgoing traffic is only let out through wg0 or to the home network, so the
#     hub never goes out directly if the tunnel is down. The TV and the web admin reach the hub as usual.
#   - DNS goes to the profile's DNS (through the tunnel); Proxmox and dhclient don't overwrite it
#   - the hub starts after the tunnel
#
# Undo:  pct exec <CTID> -- systemctl disable --now wg-quick@wg0 g3-killswitch
#        (and restore /etc/resolv.conf + remove /etc/.pve-ignore.resolv.conf)
set -euo pipefail

usage() {
  echo "usage: bash wireguard.sh <CTID> <profile.conf> [LAN, e.g. 192.168.1.0/24]" >&2
  exit 1
}
[ $# -ge 2 ] || usage
CTID="$1"
CONF="$2"
LAN="${3:-}"
[ -f "$CONF" ] || { echo "can't find $CONF" >&2; exit 1; }
command -v pct >/dev/null || { echo "run this on the Proxmox host" >&2; exit 1; }

# No LAN given: use the container's own IPv4 network, i.e. the link route (a.b.c.0/nn) on the
# interface that carries its default route in the main table (wg-quick keeps its routes in a table
# of its own, so this still finds the home network when the script is run again).
if [ -z "$LAN" ]; then
  DEV="$(pct exec "$CTID" -- ip -o -4 route show default 2>/dev/null |
    awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')" || true
  if [ -n "$DEV" ]; then
    LAN="$(pct exec "$CTID" -- ip -o -4 route show dev "$DEV" scope link 2>/dev/null |
      awk '$1 ~ /^[0-9.]+\/[0-9]+$/ && $1 !~ /^169\.254\./ { print $1; exit }')" || true
  fi
  if [ -z "$LAN" ]; then
    echo "Couldn't detect the LAN of CT $CTID (is it running?). Give it as the third argument." >&2
    usage
  fi
  echo "No LAN given: using $LAN (the network of CT $CTID on $DEV). Give a LAN as the third argument to override it."
fi

ENDPOINT="$(sed -n -E 's/^[[:space:]]*Endpoint[[:space:]]*=[[:space:]]*([0-9.]+):([0-9]+).*/\1 \2/p' "$CONF")"
read -r EP_IP EP_PORT <<<"$ENDPOINT"
[ -n "${EP_IP:-}" ] && [ -n "${EP_PORT:-}" ] || { echo "Endpoint must be IPv4:port" >&2; exit 1; }
DNS="$(sed -n -E 's/^[[:space:]]*DNS[[:space:]]*=[[:space:]]*([0-9.]+).*/\1/p' "$CONF" | head -1)"
DNS="${DNS:-10.64.0.1}"
# The container's IPv6 network (ULA) on the home network, if there is one.
LAN6="$(pct exec "$CTID" -- ip -6 route show dev eth0 2>/dev/null | awk '/^fd|^fc/ {print $1; exit}')"

modprobe wireguard
echo wireguard > /etc/modules-load.d/wireguard.conf

W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
grep -v -E '^[[:space:]]*DNS[[:space:]]*=' "$CONF" > "$W/wg0.conf"
cat > "$W/g3-killswitch.nft" <<EOF
# G3 Hub: only let traffic out through WireGuard (wg0) or to the home network.
table inet g3killswitch
delete table inet g3killswitch
table inet g3killswitch {
  chain output {
    type filter hook output priority 0; policy accept;
    oifname "lo" accept
    oifname "wg0" accept
    meta mark 0xca6c accept
    ip daddr $EP_IP udp dport $EP_PORT accept
    ip daddr $LAN accept
    ip daddr 255.255.255.255 accept
    ip6 daddr { fe80::/10, ff00::/8${LAN6:+, $LAN6} } accept
    counter reject
  }
}
EOF
cat > "$W/g3-killswitch.service" <<'EOF'
[Unit]
Description=G3 Hub: block traffic outside WireGuard (kill switch)
DefaultDependencies=no
Before=network-pre.target wg-quick@wg0.service g3hub.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/wireguard/g3-killswitch.nft
ExecStop=/usr/sbin/nft delete table inet g3killswitch

[Install]
WantedBy=multi-user.target
EOF

pct exec "$CTID" -- mkdir -p /root/g3wg
for f in wg0.conf g3-killswitch.nft g3-killswitch.service; do
  pct push "$CTID" "$W/$f" "/root/g3wg/$f" --perms 600
done

pct exec "$CTID" -- bash -c "set -e
  export DEBIAN_FRONTEND=noninteractive LC_ALL=C
  command -v wg >/dev/null || { apt-get update -qq; apt-get install -y -qq --no-install-recommends wireguard-tools nftables >/dev/null; }
  install -m 700 -d /etc/wireguard
  install -m 600 /root/g3wg/wg0.conf /etc/wireguard/wg0.conf
  install -m 644 /root/g3wg/g3-killswitch.nft /etc/wireguard/g3-killswitch.nft
  install -m 644 /root/g3wg/g3-killswitch.service /etc/systemd/system/g3-killswitch.service
  rm -rf /root/g3wg
  nft -c -f /etc/wireguard/g3-killswitch.nft
  touch /etc/.pve-ignore.resolv.conf
  sed -i '/^supersede domain-name-servers /d' /etc/dhcp/dhclient.conf
  echo 'supersede domain-name-servers $DNS;' >> /etc/dhcp/dhclient.conf
  printf 'nameserver $DNS\n' > /etc/resolv.conf
  mkdir -p /etc/systemd/system/g3hub.service.d
  printf '[Unit]\nAfter=wg-quick@wg0.service\nWants=wg-quick@wg0.service\n' > /etc/systemd/system/g3hub.service.d/wireguard.conf
  systemctl daemon-reload
  systemctl enable --now g3-killswitch.service
  systemctl enable wg-quick@wg0.service
  systemctl restart wg-quick@wg0.service
  systemctl restart g3hub.service 2>/dev/null || true
  sleep 3
  wg show wg0 | sed -n 's/^ *\(endpoint\|latest handshake\):/\1:/p'
  curl -s -m 10 https://am.i.mullvad.net/connected 2>/dev/null || curl -s -m 10 https://ifconfig.co 2>/dev/null || true
  echo"
echo "✓ CT $CTID now goes out through WireGuard ($EP_IP), with a kill switch. The home network ($LAN) reaches the hub as before."
