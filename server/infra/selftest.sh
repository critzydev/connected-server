#!/usr/bin/env bash
# Publish gate for the connected-server distribution: exercises the fresh-VPS
# setup path with stubbed system commands, so a broken installer can't reach
# GitHub again (the 2026-07-16 install shipped three bugs this would've caught:
# silent SIGPIPE death, docker unreachable for the invoking user, and a missing
# /relay/info route). Run directly or let publish-server.sh run it.
set -euo pipefail
cd "$(dirname "$0")"

PASS=0
ok()   { PASS=$((PASS + 1)); printf '  ok  %s\n' "$*"; }
fail() { printf 'SELFTEST FAIL: %s\n' "$*" >&2; exit 1; }

# --- 1. Syntax ---------------------------------------------------------------
bash -n setup.sh      || fail "setup.sh does not parse"
bash -n first-boot.sh || fail "first-boot.sh does not parse"
ok "scripts parse"

# --- 2. Regression canaries (one per shipped bug) ----------------------------
# `tr ... </dev/urandom | head` SIGPIPEs under pipefail and killed the whole
# install with no output. The safe shape reads a finite amount first.
if grep -nE 'tr[^|#]*</dev/urandom[[:space:]]*\|' setup.sh first-boot.sh \
   | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#'; then
  fail "urandom-into-pipe pattern found (dies of SIGPIPE under pipefail)"
fi
ok "no urandom SIGPIPE pattern"

grep -q 'usermod -aG docker' first-boot.sh \
  || fail "first-boot.sh must add the invoking user to the docker group"
grep -q 'DOCKER="sudo docker"' setup.sh \
  || fail "setup.sh must fall back to sudo docker (fresh box, group not active yet)"
ok "docker access story present"

grep -q 'handle /relay/info' relay/Caddyfile \
  || fail "Caddyfile missing the /relay/info route (the app cannot discover the relay)"
grep -q 'import /etc/caddy/conf.d' relay/Caddyfile \
  || fail "Caddyfile missing conf.d import (web app fragment never loads)"
ok "Caddyfile routes present"

grep -q '8890/udp' setup.sh || fail "setup.sh missing SRT firewall rule (8890/udp)"
grep -q '8895/udp' setup.sh || fail "setup.sh missing SRTLA firewall rule (8895/udp)"
ok "firewall covers SRT + SRTLA"

grep -q 'rmem_max' setup.sh \
  || fail "setup.sh missing UDP buffer sysctl (receiver-side loss at 1080p)"
grep -q 'TWITCH_CHANNEL=' setup.sh \
  || fail "wizard must write TWITCH_CHANNEL (no channel = dead studio chat/alerts)"

# update.sh: the public repo is force-pushed each release, so `git pull` breaks
# — the one-command updater must exist and use fetch+reset.
UPD=update.sh; [ -f "$UPD" ] || UPD=../../update.sh
[ -f "$UPD" ] || fail "update.sh missing"
bash -n "$UPD" || fail "update.sh does not parse"
grep -q 'reset --hard' "$UPD" || fail "update.sh must fetch+reset (pull breaks on force-push)"
if [ -f publish-server.sh ]; then
  grep -q 'update.sh' publish-server.sh || fail "publish-server.sh must ship update.sh at the repo root"
fi
ok "one-command updater present"
grep -q 'X264_PRESET=' compose.yml || fail "compose.yml must pass X264_PRESET to brb"
grep -q 'PREVIEW=' compose.yml     || fail "compose.yml must pass PREVIEW to brb"
grep -q 'CARD_FPS=' compose.yml    || fail "compose.yml must pass CARD_FPS to brb"
grep -q 'CARD_FPS' ../relay/brb/supervisor.sh || fail "supervisor.sh missing CARD_FPS knob"
ok "small-box tuning knobs present"

# --- 3. Functional dry-run: the connected-server layout, stubbed system ------
# Mimics a fresh box: bundled web-dist, no apps/web, docker/sudo/ufw stubbed.
run_setup() { # run_setup <mode: plain|sudo-fallback> -> sandbox dir in $SBX
  SBX=$(mktemp -d)
  mkdir -p "$SBX/repo/server" "$SBX/bin"
  cp -R "$PWD" "$SBX/repo/server/infra"
  rm -rf "$SBX/repo/server/infra/web-dist" "$SBX/repo/server/infra/deploy.env"
  mkdir -p "$SBX/repo/server/infra/web-dist" "$SBX/repo/server/infra/relay/conf.d"
  cat > "$SBX/repo/server/infra/deploy.env" <<'ENV'
DOMAIN=connected.selftest.invalid
WEB_DOMAIN=selftest.invalid
TWITCH_STREAM_KEY=live_selftest_key
BRAND=connected
PUBLIC_IP=203.0.113.7
ENV
  cat > "$SBX/bin/docker" <<STUB
#!/usr/bin/env bash
echo "docker \$*" >> "$SBX/calls.log"
if [ "\${1:-}" = info ]; then
  [ "$1" = sudo-fallback ] && [ -z "\${SELFTEST_VIA_SUDO:-}" ] && exit 1
  exit 0
fi
exit 0
STUB
  cat > "$SBX/bin/sudo" <<STUB
#!/usr/bin/env bash
[ "\${1:-}" = -n ] && shift
echo "sudo \$*" >> "$SBX/calls.log"
SELFTEST_VIA_SUDO=1 exec "\$@"
STUB
  printf '#!/usr/bin/env bash\nexit 0\n' > "$SBX/bin/ufw"
  if [ "$1" = small-box ]; then
    printf '#!/usr/bin/env bash\necho 2\n' > "$SBX/bin/nproc"
    chmod +x "$SBX/bin/nproc"
  fi
  chmod +x "$SBX/bin/docker" "$SBX/bin/sudo" "$SBX/bin/ufw"
  PATH="$SBX/bin:$PATH" bash "$SBX/repo/server/infra/setup.sh" \
    </dev/null > "$SBX/out.log" 2>&1 || fail "setup.sh exited $? in $1 mode ($(tail -3 "$SBX/out.log" | tr '\n' ' '))"
}

check_run() { # check_run <mode>
  local env_file="$SBX/repo/server/infra/deploy.env"
  grep -qE '^SESSION_CODE=[a-z0-9]{10}$' "$env_file" || fail "$1: SESSION_CODE not generated/persisted"
  grep -q '^PUBLIC_IP=203.0.113.7$' "$env_file"      || fail "$1: PUBLIC_IP not persisted for compose"
  grep -q '^BRB_BG=' "$env_file"                     || fail "$1: BRB_BG not persisted for compose"
  grep -q 'compose --env-file deploy.env -f compose.yml up -d --build' "$SBX/calls.log" \
    || fail "$1: compose up never invoked with --env-file"
  grep -q 'selftest.invalid' "$SBX/repo/server/infra/relay/conf.d/web.caddy" \
    || fail "$1: web app Caddy fragment not written"
  grep -q 'https://selftest.invalid' "$SBX/out.log"  || fail "$1: done-message missing web URL"
  grep -q 'selftest.invalidselftest.invalid' "$SBX/out.log" \
    && fail "$1: done-message duplicates the web domain"
  if [ "$1" = small-box ]; then
    grep -q '^X264_PRESET=superfast$' "$env_file" || fail "$1: lean preset not persisted"
    grep -q '^PREVIEW=0$' "$env_file"             || fail "$1: preview not disabled"
    grep -q '^CARD_FPS=12$' "$env_file"           || fail "$1: card fps not reduced"
  else
    if grep -q '^PREVIEW=' "$env_file"; then fail "$1: lean profile applied on a big box"; fi
  fi
  rm -rf "$SBX"
}

run_setup plain;         check_run plain;         ok "dry-run (docker reachable)"
run_setup sudo-fallback; check_run sudo-fallback; ok "dry-run (sudo fallback, fresh-box one-liner)"
run_setup small-box;     check_run small-box;     ok "dry-run (2-core box gets the lean profile)"

# --- 4. Non-interactive without config must fail loudly, not silently --------
SBX=$(mktemp -d)
mkdir -p "$SBX/repo/server"
cp -R "$PWD" "$SBX/repo/server/infra"
rm -f "$SBX/repo/server/infra/deploy.env"
if bash "$SBX/repo/server/infra/setup.sh" </dev/null > "$SBX/out.log" 2>&1; then
  fail "setup.sh without deploy.env should exit non-zero"
fi
grep -q 'Missing deploy.env' "$SBX/out.log" || fail "missing-config error not shown"
rm -rf "$SBX"
ok "missing config fails loudly"

printf 'SELFTEST PASS (%d checks)\n' "$PASS"
