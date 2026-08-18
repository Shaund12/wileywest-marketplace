#!/usr/bin/env bash
#
# ############################################################
# #  DO NOT RUN — SUPERSEDED. Kept for reference only.       #
# ############################################################
#
# This script was written on the mistaken belief that the host had no
# firewall. It does: ufw is active, fail2ban is running, and CrowdSec now
# enforces via crowdsec-firewall-bouncer (nftables mode). See ops/README.md
# section 4.
#
# Running this would rewrite existing ufw policy and could conflict with the
# fail2ban chains. It remains here only as a reference for what a
# from-scratch ruleset on a bare host would look like.
#
# BlockDust host firewall — REVIEW BEFORE RUNNING.
#
#   sudo bash ops/harden-firewall.sh          # apply
#   DRY_RUN=1 bash ops/harden-firewall.sh     # print only, change nothing
#
# This host currently has NO firewall (no ufw rules, no iptables rules) while
# binding many services to 0.0.0.0. It is also a workstation, not a dedicated
# server, so a deny-by-default policy WILL cut off anything you reach from
# another machine that is not allowed below. Read the ALLOW list first.
#
# Services observed listening on public interfaces at the time of writing:
#   22    sshd                      -> allowed
#   80    nginx                     -> allowed
#   443   nginx                     -> allowed
#   4001  ipfs swarm                -> allowed (p2p needs inbound)
#   26656 hyved p2p                 -> allowed (p2p needs inbound)
#   ----- everything below is denied by the default policy -----
#   3002  next-server               3006  next-server
#   3011  next-server               3012  next-server
#   4000  node                      4040  llmster
#   4096  opencode                  5000  node
#   5002  node                      5199  node
#   8420  python3                   8787  blockdust backend
#   9001  node
#
# 8787 should ALSO be fixed at the app level (backend/server.js now binds
# 127.0.0.1 by default); this firewall is defense in depth, not the fix.

set -euo pipefail

if [[ "${I_KNOW_THIS_IS_SUPERSEDED:-0}" != "1" ]]; then
  cat >&2 <<'STOP'
This script is superseded and should not be run — the host already has ufw,
fail2ban, and CrowdSec enforcement in place. See ops/README.md section 4.

To run it anyway (e.g. on a genuinely bare host):
  I_KNOW_THIS_IS_SUPERSEDED=1 sudo bash ops/harden-firewall.sh
STOP
  exit 1
fi

DRY_RUN="${DRY_RUN:-0}"
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  [dry-run] $*"
  else
    echo "  + $*"
    "$@"
  fi
}

if ! command -v ufw >/dev/null 2>&1; then
  echo "ufw is not installed. Install it first:  sudo apt-get install ufw" >&2
  exit 1
fi

if [[ "$DRY_RUN" != "1" && "${EUID}" -ne 0 ]]; then
  echo "Run with sudo, or use DRY_RUN=1 to preview." >&2
  exit 1
fi

echo "==> Default policies"
run ufw default deny incoming
run ufw default allow outgoing

echo "==> Allow SSH (do not remove — this is your way back in)"
run ufw limit 22/tcp comment 'ssh (rate-limited)'

echo "==> Allow HTTP/HTTPS for nginx"
run ufw allow 80/tcp comment 'nginx http'
run ufw allow 443/tcp comment 'nginx https'

echo "==> Allow peer-to-peer listeners that require inbound connections"
run ufw allow 4001 comment 'ipfs swarm'
run ufw allow 26656/tcp comment 'hyved p2p'

# --- Optional: LAN-only access to development servers -----------------------
# Deny-by-default will block the dev servers on this box from other machines.
# If you reach them from a laptop on the LAN, uncomment and set your subnet.
#
# LAN_SUBNET="192.168.1.0/24"
# for port in 3002 3006 3011 3012 4000 5000 5002 5199; do
#   run ufw allow from "$LAN_SUBNET" to any port "$port" proto tcp comment 'dev (LAN only)'
# done

echo "==> Enabling"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "  [dry-run] ufw --force enable"
else
  ufw --force enable
fi

echo
echo "==> Resulting rules"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "  [dry-run] ufw status verbose"
else
  ufw status verbose
fi

cat <<'NOTE'

Done. Verify before you disconnect:
  - SSH still works from another machine.
  - https://blockdust.pyvendr.com still loads.
  - The backend is NOT reachable directly:
      curl -m 5 http://<this-host-lan-ip>:8787/api/health   # should hang/refuse

To roll back:  sudo ufw disable
NOTE
