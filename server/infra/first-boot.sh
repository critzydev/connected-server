#!/usr/bin/env bash
# Connected VPS first-boot: harden SSH, firewall, install Docker.
# Run as root on a fresh OVH VPS-1 (Debian 12 / Ubuntu 24.04). Add your SSH key FIRST.
set -euo pipefail

echo "==> Disabling SSH password auth (key-only)"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo "==> Firewall (ufw)"
apt-get update -y
apt-get install -y ufw curl
ufw allow 22/tcp       # SSH
ufw allow 80/tcp       # HTTP (Caddy TLS challenge)
ufw allow 443/tcp      # HTTPS (WHIP + dashboard)
ufw allow 8189/udp     # WebRTC media (ICE)
# Phase 2: ufw allow 8890/udp   # SRT bonded ingest
ufw --force enable

echo "==> Docker"
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
# Let the invoking user run docker without sudo (applies from their next login).
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  usermod -aG docker "$SUDO_USER"
fi

echo "==> Done. Next: ./setup.sh"
