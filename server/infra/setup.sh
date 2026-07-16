#!/usr/bin/env bash
# Connected relay — one-command setup for a fresh/dedicated VPS.
#
#   cp deploy.env.example deploy.env   # fill in DOMAIN, TWITCH_STREAM_KEY, BRAND
#   ./setup.sh
#
# It auto-detects the public IP, themes the BRB card from the brand, opens the
# firewall, and brings up the whole never-cut-out stack (MediaMTX + BRB + Caddy).
# Re-run any time to apply config changes — it's idempotent.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }

# --- 1. Config --------------------------------------------------------------
# No deploy.env + a human at the terminal = the setup wizard. Two questions,
# then it writes deploy.env and continues. (Non-interactive runs keep the old
# behavior: copy deploy.env.example and edit it.)
if [ ! -f deploy.env ] && [ -t 0 ]; then
  echo ""
  echo "  Welcome to Connected — let's set up your streaming server."
  echo ""
  printf "  Your domain (e.g. mystream.com — you must own it): "
  read -r WIZ_APEX
  WIZ_APEX=$(echo "$WIZ_APEX" | tr -d '[:space:]' | sed 's|https\?://||; s|/.*||')
  [ -z "$WIZ_APEX" ] && { err "A domain is required."; exit 1; }
  printf "  Your Twitch stream key (Enter to SKIP — you can link your Twitch account\n  in Settings later and the relay fetches the key itself): "
  read -r WIZ_KEY
  WIZ_KEY=$(echo "$WIZ_KEY" | tr -d '[:space:]')
  [ -z "$WIZ_KEY" ] && echo "  (Skipped — after setup, open Settings -> Channel rewards & sounds and Link Twitch.)"
  printf "  Your Twitch channel name (powers chat + alerts in the studio): "
  read -r WIZ_CHANNEL
  WIZ_CHANNEL=$(echo "$WIZ_CHANNEL" | tr -d '[:space:]#' | tr '[:upper:]' '[:lower:]')
  [ -z "$WIZ_CHANNEL" ] && echo "  (Skipped — chat and alerts stay off until TWITCH_CHANNEL is set in deploy.env.)"
  WIZ_IP=""
  for url in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
    WIZ_IP=$(curl -fsS -m 5 "$url" 2>/dev/null | tr -d '[:space:]') && break
  done
  cat > deploy.env <<WIZARD
# Written by the setup wizard on $(date -u +%Y-%m-%d). Edit + re-run ./setup.sh
# any time to change things.
DOMAIN=connected.${WIZ_APEX}
WEB_DOMAIN=${WIZ_APEX}
TWITCH_STREAM_KEY=${WIZ_KEY}
TWITCH_CHANNEL=${WIZ_CHANNEL}
BRAND=connected
WIZARD
  echo ""
  echo "  Now create these two DNS records for ${WIZ_APEX}"
  echo "  (Cloudflare: proxy status DNS ONLY — the orange cloud OFF):"
  echo ""
  echo "    A    ${WIZ_APEX}              ->  ${WIZ_IP:-<this server's IP>}"
  echo "    A    connected.${WIZ_APEX}    ->  ${WIZ_IP:-<this server's IP>}"
  echo ""
  printf "  Press Enter when both records exist... "
  read -r _
fi
if [ ! -f deploy.env ]; then
  err "Missing deploy.env. Run:  cp deploy.env.example deploy.env  then edit it."
  exit 1
fi
# shellcheck disable=SC1091
set -a; . ./deploy.env; set +a

if [ -z "${DOMAIN:-}" ] || [ "${DOMAIN}" = "stream.example.com" ]; then
  err "Set DOMAIN in deploy.env to your real domain (with DNS pointed at this box)."; exit 1
fi
case "${TWITCH_STREAM_KEY:-}" in
  live_000000000_*) err "TWITCH_STREAM_KEY still has the placeholder — set a real key, or clear it and link Twitch in Settings instead."; exit 1 ;;
  "") say "NOTE: no TWITCH_STREAM_KEY — the relay can't broadcast until you Link Twitch in Settings (it then fetches the key itself)." ;;
esac
BRAND=${BRAND:-connected}
if [ -z "${TWITCH_CHANNEL:-}" ]; then
  say "NOTE: TWITCH_CHANNEL is not set — studio chat + alerts stay off until you add it to deploy.env."
fi

# Generate a session code on first run so the studio hub is never open by
# default — and persist it so re-runs keep the same rig code.
if [ -z "${SESSION_CODE:-}" ]; then
  # head first, finite tr input: `tr </dev/urandom | head` dies of SIGPIPE (141)
  # under pipefail and silently kills the whole script.
  SESSION_CODE=$(head -c 1024 /dev/urandom | tr -dc 'a-z0-9' | head -c 10)
  if grep -q '^SESSION_CODE=$' deploy.env 2>/dev/null; then
    sed -i.bak "s/^SESSION_CODE=$/SESSION_CODE=${SESSION_CODE}/" deploy.env && rm -f deploy.env.bak
  else
    printf '\nSESSION_CODE=%s\n' "$SESSION_CODE" >> deploy.env
  fi
  say "Generated studio session code: $SESSION_CODE (saved to deploy.env)"
fi
export SESSION_CODE

# --- 2. Docker present? -----------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  err "Docker not found. Bootstrap the box first:  sudo ./first-boot.sh"
  exit 1
fi
# The docker group added by first-boot.sh only applies from the next login, so
# in the documented one-liner (sudo ./first-boot.sh && ./setup.sh) this shell
# can't reach the socket yet — fall back to sudo.
DOCKER=docker
if ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
  else
    err "This user can't reach Docker yet. Run:  sudo usermod -aG docker \$USER  then log out and back in, and re-run ./setup.sh"
    exit 1
  fi
fi

# --- 3. Public IP -----------------------------------------------------------
if [ -z "${PUBLIC_IP:-}" ]; then
  say "Detecting public IP…"
  for url in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
    PUBLIC_IP=$(curl -fsS -m 5 "$url" 2>/dev/null | tr -d '[:space:]') || true
    [ -n "${PUBLIC_IP:-}" ] && break
  done
  [ -z "${PUBLIC_IP:-}" ] && { err "Could not auto-detect PUBLIC_IP. Set it in deploy.env."; exit 1; }
fi
export PUBLIC_IP
say "Public IP: $PUBLIC_IP   Domain: $DOMAIN   Brand: $BRAND"

# --- 4. Theme the BRB card from the brand (unless overridden in deploy.env) --
if [ -z "${BRB_BG:-}" ] || [ -z "${BRB_FG:-}" ]; then
  case "$BRAND" in
    devi) BRB_BG=${BRB_BG:-0x0a0a0c}; BRB_FG=${BRB_FG:-0xff2d78} ;;  # Devi magenta
    *)    BRB_BG=${BRB_BG:-0x140a23}; BRB_FG=${BRB_FG:-0xEDE8FF} ;;  # Connected violet
  esac
fi
export BRB_BG BRB_FG

# Compose interpolates from deploy.env (--env-file); exported vars don't
# survive the sudo fallback, so persist the computed values.
persist_env() {
  if grep -q "^$1=" deploy.env; then
    sed -i.bak "s|^$1=.*|$1=$2|" deploy.env && rm -f deploy.env.bak
  else
    printf '%s=%s\n' "$1" "$2" >> deploy.env
  fi
}
persist_env PUBLIC_IP "$PUBLIC_IP"
persist_env BRB_BG "$BRB_BG"
persist_env BRB_FG "$BRB_FG"

# --- 4b. Kernel UDP buffers (Linux) ------------------------------------------
# 1080p HEVC bursts overflow the ~208KB default socket ceilings — receiver-side
# drops that read as network loss (corrupt NAL, SRT retransmit storms) even on
# perfect WiFi. Field-diagnosed 2026-07-16 on a fresh 2-core box.
if [ "$(uname)" = Linux ] && [ "$(sysctl -n net.core.rmem_max 2>/dev/null || echo 0)" -lt 8388608 ]; then
  say "Raising UDP socket buffer ceilings to 8MB (net.core.rmem_max/wmem_max)…"
  printf 'net.core.rmem_max=8388608\nnet.core.wmem_max=8388608\n' \
    | sudo tee /etc/sysctl.d/99-connected-udp.conf >/dev/null
  sudo sysctl -q -p /etc/sysctl.d/99-connected-udp.conf || true
fi

# --- 4c. Small-box auto-tune --------------------------------------------------
# The never-cut-out pusher is a real transcode. On <=2 cores the full profile
# starves SRT/srtla (ACK stalls read as loss on perfect networks) — default to
# a lean profile. Every value stays overridable in deploy.env.
CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
if [ "$CORES" -le 2 ]; then
  say "Small box (${CORES} cores): lean encode profile (X264_PRESET=superfast, PREVIEW=0, CARD_FPS=12)."
  if [ -z "${X264_PRESET:-}" ]; then persist_env X264_PRESET superfast; X264_PRESET=superfast; fi
  if [ -z "${PREVIEW:-}" ]; then persist_env PREVIEW 0; PREVIEW=0; fi
  if [ -z "${CARD_FPS:-}" ]; then persist_env CARD_FPS 12; CARD_FPS=12; fi
fi

# --- 5. Firewall ------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  say "Opening firewall (22, 80, 443/tcp; 8189/udp media; 8890/udp SRT; 8895/udp SRTLA)…"
  sudo ufw allow 22/tcp   >/dev/null 2>&1 || true
  sudo ufw allow 80/tcp   >/dev/null 2>&1 || true   # Caddy TLS challenge
  sudo ufw allow 443/tcp  >/dev/null 2>&1 || true   # WHIP signaling
  sudo ufw allow 8189/udp >/dev/null 2>&1 || true   # WebRTC media (direct to IP)
  sudo ufw allow 8890/udp >/dev/null 2>&1 || true   # SRT ingest (native HEVC)
  sudo ufw allow 8895/udp >/dev/null 2>&1 || true   # SRTLA bonding receiver
else
  say "ufw not found — ensure 80/tcp, 443/tcp, 8189/udp and 8890/udp are open to this box."
fi

# --- 5b. Web app (optional, WEB_DOMAIN) --------------------------------------
# Builds the static web app in a disposable node container with this relay
# baked in as the default, and serves it from the bundled Caddy on its own
# domain. One box, both faces: WEB_DOMAIN = the site, DOMAIN = the engine.
if [ -n "${WEB_DOMAIN:-}" ] && [ ! -d ../../apps/web ] && [ -d web-dist ]; then
  # connected-server distribution: a prebuilt generic web app is bundled; it
  # discovers its relay from the domain convention at runtime. No build.
  say "Using the bundled web app for https://${WEB_DOMAIN}"
  cat > relay/conf.d/web.caddy <<CADDY
${WEB_DOMAIN} {
	encode zstd gzip
	root * /srv/web
	try_files {path} {path}.html
	file_server
}
CADDY
elif [ -n "${WEB_DOMAIN:-}" ]; then
  say "Building the web app for https://${WEB_DOMAIN} (relay: ${DOMAIN})…"
  REPO_ROOT=$(cd ../.. && pwd)
  $DOCKER run --rm -v "$REPO_ROOT":/repo -w /repo \
    -e NEXT_PUBLIC_BRAND="$BRAND" \
    -e NEXT_PUBLIC_WHIP_URL="https://${DOMAIN}/live/whip" \
    -e NEXT_PUBLIC_HUB_HTTP="https://${DOMAIN}/hub" \
    -e NODE_OPTIONS=--max-old-space-size=1536 \
    node:22-bookworm-slim sh -c \
    "npm ci --no-audit --no-fund >/dev/null && cd apps/web && npx next build" \
    || { err "Web build failed — the relay still deploys; fix and re-run."; }
  if [ -d "$REPO_ROOT/apps/web/out" ]; then
    rm -rf web-dist && cp -r "$REPO_ROOT/apps/web/out" web-dist
    cat > relay/conf.d/web.caddy <<CADDY
${WEB_DOMAIN} {
	encode zstd gzip
	root * /srv/web
	try_files {path} {path}.html
	file_server
}
CADDY
    say "Web app staged: https://${WEB_DOMAIN} (served by the bundled Caddy)"
  fi
else
  rm -f relay/conf.d/web.caddy
fi

# --- 6. Bring up the stack --------------------------------------------------
say "Building + starting the relay (MediaMTX + BRB + hub + Caddy)…"
$DOCKER compose --env-file deploy.env -f compose.yml up -d --build
$DOCKER compose --env-file deploy.env -f compose.yml ps


cat <<DONE

✓ Done — your Connected server is running.
  Open ${WEB_DOMAIN:+https://${WEB_DOMAIN} and }the app, then claim your relay:
  web: https://${WEB_DOMAIN:-$DOMAIN}/connect   app: enter ${DOMAIN} as the relay.

  WHIP ingest:  https://${DOMAIN}/live/whip
  Studio hub:   wss://${DOMAIN}/hub/ws   (session code: ${SESSION_CODE})
  Web app:      $([ -n "${WEB_DOMAIN:-}" ] && echo "https://${WEB_DOMAIN}" || echo "not deployed (set WEB_DOMAIN in deploy.env)")

  Never-cut-out is ON: the phone publishes, the BRB supervisor owns the Twitch
  push and covers any drop with the card until reconnect (grace ${GRACE:-120}s).

  Check state:  curl -s localhost:9997/v3/paths/list
  Logs:         docker compose -f compose.yml logs -f brb
DONE
