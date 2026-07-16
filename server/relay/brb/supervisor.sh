#!/bin/sh
# Connected BRB supervisor — the "never cut out" engine.
#
# A streaming SESSION begins when the phone starts publishing. During a session a
# single persistent PUSHER (ffmpeg) holds the output connection (Twitch RTMP) open.
# It is fed over a local UDP bus by exactly one FEEDER:
#   - LIVE feeder: the phone's stream (from MediaMTX) -> UDP bus   (phone present)
#   - BRB  feeder: a "Reconnecting…" card             -> UDP bus   (phone dropped)
# Because the pusher reads a connectionless UDP bus, swapping feeders is just a ~1s
# data gap — the pusher (and the Twitch broadcast) never closes mid-session.
#
# How a session ENDS — the two goodbyes look different at the relay:
#   - CLEAN END: the streamer taps End Stream -> the app sends a WHIP DELETE and
#     the live path vanishes instantly (while bytes were still flowing). We show
#     the card only END_LINGER seconds (flap insurance), then stop the broadcast.
#   - RUDE DROP: signal died -> the WebRTC session stays "ready" but bytes stall.
#     We cover with the card for up to GRACE seconds; only a drop longer than
#     GRACE ends the broadcast.
#
#   idle ──phone up──▶ live ──rude drop──▶ brb(GRACE) ──reconnect──▶ live
#                       │                    │ (deadline passes) ─▶ idle (broadcast ends)
#                       └──clean end───▶ brb(END_LINGER) ─┘
#
# All endpoints are env-injected so the same script runs in the lab and in prod.
set -u

API=${API:-http://127.0.0.1:9997}              # MediaMTX API base
LIVE_PATH=${LIVE_PATH:-live}                   # path the phone publishes to
LIVE_INPUT=${LIVE_INPUT:-rtsp://127.0.0.1:8554/live}
LIVE_INPUT_OPTS=${LIVE_INPUT_OPTS--rtsp_transport tcp}   # default only if UNSET
UDP=${UDP:-udp://127.0.0.1:5001}               # internal bus pusher<-feeders
# Bus tuning: 1080p HEVC keyframe bursts overflow ffmpeg's default UDP
# buffers even on loopback — dropped packets = corrupt NAL units = the pusher
# encoding garbage (field-diagnosed 2026-07-02: "Invalid NAL unit" spam while
# viewers saw low-bitrate mush). Deep fifo on the read side, mpegts-sized
# writes, and a large SO_RCVBUF (host needs net.core.rmem_max raised).
UDP_IN="${UDP}?fifo_size=65536&overrun_nonfatal=1&buffer_size=8388608"
UDP_OUT="${UDP}?pkt_size=1316&buffer_size=1048576"
# Output resolution, in order:
#   1. OUT env (a full output URL — custom ingests, tests)
#   2. TWITCH_STREAM_KEY env (deploy.env, the classic path)
#   3. the hub's /stream/key — fetched from Twitch via the owner's linked
#      account (channel:read:stream_key), so a linked relay needs NO pasted
#      key at all. Re-resolved at every pusher (re)start = rotation-proof.
OUT=${OUT:-}
TWITCH_STREAM_KEY=${TWITCH_STREAM_KEY:-}
OUT_EFF=""
resolve_out() {
  if [ -n "$OUT" ]; then OUT_EFF="$OUT"; return 0; fi
  if [ -n "$TWITCH_STREAM_KEY" ]; then
    OUT_EFF="rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}"; return 0
  fi
  if [ -n "$HUB" ]; then
    KEY=$(curl -s -m 3 "$HUB/stream/key" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$KEY" ]; then
      OUT_EFF="rtmp://live.twitch.tv/app/${KEY}"; return 0
    fi
  fi
  return 1
}
FONT=${FONT:-/host-fonts/truetype/dejavu/DejaVuSans-Bold.ttf}
BRB_TEXT=${BRB_TEXT:-Reconnecting…}
BRB_BG=${BRB_BG:-0x140a23}                     # BRB card background (per-brand themeable)
BRB_FG=${BRB_FG:-0xEDE8FF}                     # BRB card text color
BRB_MEDIA=${BRB_MEDIA:-}                       # optional image/video card (overrides the text card)
HUB=${HUB:-http://127.0.0.1:8787}              # session hub; owner-set card (text/image/video) wins. "" disables.
W=${W:-1280}; H=${H:-720}; FPS=${FPS:-30}
VBITRATE=${VBITRATE:-4500k}
# Small-box levers (setup.sh auto-tunes these on <=2 cores): the card feeder
# may run below stream fps — the pusher's fps filter duplicates back up — and
# the guest preview encode can be skipped entirely.
CARD_FPS=${CARD_FPS:-$FPS}
PREVIEW=${PREVIEW:-1}
GRACE=${GRACE:-120}                            # seconds a DROPPED phone may be gone before the broadcast ends
END_LINGER=${END_LINGER:-10}                   # seconds after a CLEAN unpublish before the broadcast ends
STALL_SECS=${STALL_SECS:-3}                    # WebRTC: ready-but-no-bytes this long = a real drop
# SRT drops must NOT trip the card while the latency window can still heal
# them: the receiver keeps playing buffered content for up to the window, and
# a blip shorter than it retransmits invisibly. Keep this ABOVE the app's max
# delay-window slider (8 s).
SRT_STALL_SECS=${SRT_STALL_SECS:-4}

# Card canvas: half the output — the pusher upscales to WxH, and half-res
# keeps every card feeder trivially realtime.
CW=$(( W / 2 )); CW=$(( CW - CW % 2 ))
CH=$(( H / 2 )); CH=$(( CH - CH % 2 ))
MEZ=/tmp/brb-card-mez.mp4

PUSHER_PID=0; BRB_PID=0; LIVE_PID=0; PREVIEW_PID=0
log() { echo "[brb $(date -u +%H:%M:%S)] $*"; }
now() { date +%s; }
alive() { [ "$1" -ne 0 ] && kill -0 "$1" 2>/dev/null; }

# Persistent pusher: UDP bus -> normalize to constant WxH/FPS -> output. Lives for the whole session.
# No zerolatency tune: it kills lookahead+B-frames (a big quality hit at the
# same bitrate) to save milliseconds nobody gets back — the SRT window and
# Twitch's own delay dwarf it. bufsize 2x smooths quality pulses (VBV).
# Timestamps: TRUST THE SOURCE. The phone's PTS are a perfect 30 fps grid;
# wallclock-stamping them by packet arrival (the old approach) turned network
# micro-jitter into fps-filter dup/drop judder. Feeder swaps (live <-> BRB
# card) jump the timeline, but ffmpeg's MPEG-TS discontinuity correction
# splices ANY backward jump (and forward jumps > dts_delta_threshold) into a
# continuous timeline by design — that's the seamless-swap mechanism now.
# aresample=async=1 patches the audio seam at each splice.
# -re: Twitch must receive a REALTIME stream no matter how bursty our input
# is — the app's reconnect replay delivers seconds of content at once, and
# unpaced that timeline jump makes Twitch close the ingest (Broken pipe,
# field-diagnosed 2026-07-02). -re plays the deep UDP fifo out at 1x.
start_pusher() {
  if ! resolve_out; then
    # No key anywhere yet (fresh box, Twitch not linked). Stay quiet-ish: the
    # supervisor's poll loop retries; the moment a key exists we push.
    [ "${KEY_WARNED:-0}" = 1 ] || log "no stream key yet — link Twitch in Settings (or set TWITCH_STREAM_KEY); retrying"
    KEY_WARNED=1
    PUSHER_PID=0
    return 1
  fi
  KEY_WARNED=0
  BUFSIZE="$(( ${VBITRATE%k} * 2 ))k"
  ffmpeg -hide_banner -loglevel warning -nostdin \
    -re \
    -fflags +genpts -dts_delta_threshold 2 -thread_queue_size 1024 \
    -f mpegts -i "$UDP_IN" \
    -vf "scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuv420p" \
    -af "aresample=async=1" \
    -c:v libx264 -preset "${X264_PRESET:-faster}" -g $((FPS*2)) -keyint_min "$FPS" \
    -b:v "$VBITRATE" -maxrate "$VBITRATE" -bufsize "$BUFSIZE" \
    -c:a aac -b:a 160k -ar 44100 \
    -f flv "$OUT_EFF" &
  PUSHER_PID=$!
}

has_audio() { ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$1" 2>/dev/null | grep -q audio; }

CARD_CACHE=/tmp/brb-card-media
TEXT_FILE=/tmp/brb-card-text

# Decide what the card shows RIGHT NOW. Priority:
#   1. the hub's owner-set card (fetched fresh at every swap, so edits made in
#      the app apply on the very next drop; media is mtime-cached so an
#      unchanged file is a 304, not a re-download)
#   2. the env-provided BRB_MEDIA file
#   3. the synthesized color+text card
# Text always goes through TEXT_FILE (drawtext textfile= needs no escaping).
resolve_card() {
  CARD_KIND=text; CARD_FILE=""
  printf '%s' "$BRB_TEXT" > "$TEXT_FILE"
  if [ -n "$HUB" ]; then
    KIND=$(curl -s -m 2 "$HUB/brb/config" 2>/dev/null | sed -n 's/.*"kind":"\([a-z]*\)".*/\1/p')
    HUB_TEXT=$(curl -s -m 2 "$HUB/brb/text" 2>/dev/null)
    [ -n "$HUB_TEXT" ] && printf '%s' "$HUB_TEXT" > "$TEXT_FILE"
    if [ "$KIND" = image ] || [ "$KIND" = video ]; then
      curl -s -m 20 -z "$CARD_CACHE" -o "$CARD_CACHE" "$HUB/brb/media" 2>/dev/null || true
      if [ -s "$CARD_CACHE" ]; then CARD_KIND=$KIND; CARD_FILE=$CARD_CACHE; fi
    fi
  fi
  if [ "$CARD_KIND" = text ] && [ -n "$BRB_MEDIA" ]; then
    if [ -r "$BRB_MEDIA" ]; then
      case "$BRB_MEDIA" in
        *.png|*.PNG|*.jpg|*.JPG|*.jpeg|*.JPEG|*.webp|*.WEBP|*.bmp|*.BMP) CARD_KIND=image ;;
        *) CARD_KIND=video ;;
      esac
      CARD_FILE=$BRB_MEDIA
    else
      log "BRB_MEDIA '$BRB_MEDIA' missing/unreadable -> using the text card"
    fi
  fi
}

# Uploaded VIDEO cards become a card-sized H264 mezzanine ONCE per upload:
# looping the raw file re-decodes it forever, and a phone video (4K/60fps)
# falls below realtime exactly like the raw-image case did (16fps card =
# player spinners). Source fps (15/24/30/60/VFR) is normalized to $FPS here,
# once. Atomic tmp+mv so a swap never reads a half-written file; prewarmed in
# the background at session start so a drop never waits on a transcode.
build_mez() {
  [ "$CARD_KIND" = video ] || return 0
  [ -f "$MEZ" ] && [ ! "$CARD_FILE" -nt "$MEZ" ] && return 0
  MEZ_FIT="scale=${CW}:${CH}:force_original_aspect_ratio=decrease,pad=${CW}:${CH}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuv420p"
  if has_audio "$CARD_FILE"; then
    ffmpeg -hide_banner -loglevel error -nostdin -y -i "$CARD_FILE" \
      -vf "$MEZ_FIT" -c:v libx264 -preset veryfast -crf 20 -g $((FPS*2)) \
      -c:a aac -b:a 160k -ar 44100 -movflags +faststart /tmp/.brb-mez.tmp.mp4 \
      && mv /tmp/.brb-mez.tmp.mp4 "$MEZ"
  else
    ffmpeg -hide_banner -loglevel error -nostdin -y -i "$CARD_FILE" \
      -vf "$MEZ_FIT" -c:v libx264 -preset veryfast -crf 20 -g $((FPS*2)) \
      -an -movflags +faststart /tmp/.brb-mez.tmp.mp4 \
      && mv /tmp/.brb-mez.tmp.mp4 "$MEZ"
  fi
}

# BRB card feeder -> UDP bus. Three flavors (see resolve_card):
#   text  -> synthesized color card + text + silence (the classic)
#   image -> the image + silence
#   video -> the video looped forever, its own audio if it has any
# setpts/asetpts rewrite loop-reset timestamps so the mpegts mux stays monotonic.
SRC_CODEC=h264   # updated by poll_live: srtConn publishes HEVC

start_brb() {
  resolve_card
  build_mez
  # Match the live stream's codec — an H264 card spliced into an HEVC session
  # wedges the pusher's decoder ('Invalid NAL unit' spam, nothing reaches the
  # broadcast; field-diagnosed 2026-07-02). x265 ultrafast is cheap for a
  # static card.
  CARD_V="libx264"; CARD_PRESET="veryfast"
  if [ "$SRC_CODEC" = hevc ]; then CARD_V="libx265"; CARD_PRESET="ultrafast"; fi
  log "BRB card: ${CARD_KIND}${CARD_FILE:+ ($CARD_FILE)}"
  FIT="scale=${CW}:${CH}:force_original_aspect_ratio=decrease,pad=${CW}:${CH}:(ow-iw)/2:(oh-ih)/2,fps=${CARD_FPS},setpts=N/(${CARD_FPS}*TB),format=yuv420p"
  case "$CARD_KIND" in
    image)
      # Pre-scale ONCE: -loop 1 re-decodes the source image every frame, and
      # a phone-camera-sized upload caps that at ~16fps (field-measured) —
      # an underfed bus and player spinners. A card-sized PNG decodes free.
      ffmpeg -hide_banner -loglevel error -nostdin -y -i "$CARD_FILE" \
        -vf "scale=${CW}:${CH}:force_original_aspect_ratio=decrease" \
        -frames:v 1 /tmp/brb-card-small.png
      ffmpeg -hide_banner -loglevel error -nostdin \
        -re -loop 1 -framerate "$CARD_FPS" -i /tmp/brb-card-small.png \
        -f lavfi -i "anullsrc=r=44100:cl=stereo" \
        -vf "$FIT" \
        -c:v "$CARD_V" -preset "$CARD_PRESET" -tune zerolatency -g $((CARD_FPS*2)) -r "$CARD_FPS" \
        -c:a aac -b:a 160k -ar 44100 \
        -f mpegts "$UDP_OUT" &
      ;;
    video)
      CARD_SRC="$CARD_FILE"
      if [ -f "$MEZ" ] && [ ! "$CARD_FILE" -nt "$MEZ" ]; then CARD_SRC="$MEZ"; fi
      if has_audio "$CARD_SRC"; then
        ffmpeg -hide_banner -loglevel error -nostdin \
          -re -stream_loop -1 -i "$CARD_SRC" \
          -vf "$FIT" -af "aresample=44100,asetpts=N/SR/TB" \
          -c:v "$CARD_V" -preset "$CARD_PRESET" -tune zerolatency -g $((CARD_FPS*2)) -r "$CARD_FPS" \
          -c:a aac -b:a 160k -ar 44100 \
          -f mpegts "$UDP_OUT" &
      else
        ffmpeg -hide_banner -loglevel error -nostdin \
          -re -stream_loop -1 -i "$CARD_SRC" \
          -f lavfi -i "anullsrc=r=44100:cl=stereo" \
          -map 0:v:0 -map 1:a:0 \
          -vf "$FIT" \
          -c:v "$CARD_V" -preset "$CARD_PRESET" -tune zerolatency -g $((CARD_FPS*2)) -r "$CARD_FPS" \
          -c:a aac -b:a 160k -ar 44100 \
          -f mpegts "$UDP_OUT" &
      fi
      ;;
    *)
      ffmpeg -hide_banner -loglevel error -nostdin -re \
        -f lavfi -i "color=c=${BRB_BG}:s=${W}x${H}:r=${CARD_FPS}" \
        -f lavfi -i "anullsrc=r=44100:cl=stereo" \
        -vf "drawtext=fontfile=${FONT}:textfile=${TEXT_FILE}:fontcolor=${BRB_FG}:fontsize=54:x=(w-tw)/2:y=(h-th)/2" \
        -c:v "$CARD_V" -preset "$CARD_PRESET" -tune zerolatency -g $((CARD_FPS*2)) -r "$CARD_FPS" -pix_fmt yuv420p \
        -c:a aac -b:a 160k -ar 44100 \
        -f mpegts "$UDP_OUT" &
      ;;
  esac
  BRB_PID=$!
}

# Live feeder: phone stream from MediaMTX -> UDP bus. Video copied (cheap), audio -> AAC
# (mpegts can't carry Opus). The pusher does the single normalize/encode.
start_live() {
  # shellcheck disable=SC2086
  ffmpeg -hide_banner -loglevel error -nostdin $LIVE_INPUT_OPTS -i "$LIVE_INPUT" \
    -c:v copy -c:a aac -b:a 160k -ar 44100 \
    -f mpegts "$UDP_OUT" &
  LIVE_PID=$!
}

# Guest program preview: browsers can't decode the SRT path's HEVC (or AAC)
# over WebRTC, so the studio/guest WHEP preview plays a small H264+Opus
# republish instead — one cheap 540p encode, uniform across transports.
start_preview() {
  if [ "$PREVIEW" = 0 ]; then PREVIEW_PID=0; return 0; fi
  # shellcheck disable=SC2086
  ffmpeg -hide_banner -loglevel error -nostdin $LIVE_INPUT_OPTS -i "$LIVE_INPUT" \
    -vf "scale=-2:540,fps=30" \
    -c:v libx264 -preset ultrafast -tune zerolatency -b:v 1200k -g 60 \
    -c:a libopus -b:a 96k -ar 48000 \
    -f rtsp rtsp://127.0.0.1:8554/preview &
  PREVIEW_PID=$!
}

kill_pid() { [ "$1" -ne 0 ] && kill "$1" 2>/dev/null; }

# Every poll classifies the uplink as one of:
#   up      — path ready AND bytesReceived grew within STALL_SECS
#   stalled — path ready but bytes frozen: a rude drop ("ready" outlives a dead
#             uplink ~30s until ICE times out — measured on prod 2026-07-02;
#             bytes are the truth)
#   gone    — MediaMTX says nobody is publishing (a clean WHIP DELETE lands here
#             instantly, while bytes were still flowing)
#   err     — the API itself didn't answer; assume the worst but never treat an
#             API hiccup as a clean end
LAST_BYTES=""; LAST_CHANGE=0; LINK=gone; BYTE_AGE=999

poll_live() {
  if command -v curl >/dev/null 2>&1; then BODY=$(curl -s -m 3 "$API/v3/paths/get/$LIVE_PATH" 2>/dev/null)
  else BODY=$(wget -qO- -T 3 "$API/v3/paths/get/$LIVE_PATH" 2>/dev/null); fi
  if [ -z "$BODY" ]; then LINK=err; return; fi
  NOW_S=$(now)
  if [ "$LAST_CHANGE" -gt 0 ]; then BYTE_AGE=$(( NOW_S - LAST_CHANGE )); else BYTE_AGE=999; fi
  if ! echo "$BODY" | grep -q '"ready":[ ]*true'; then LINK=gone; return; fi
  # Source-aware stall threshold: SRT's latency window keeps playing (and can
  # retransmit) long past WebRTC's 3 s — swapping the card early AMPUTATES
  # content the window still owns (field-observed 2026-07-02).
  THRESH=$STALL_SECS
  case "$BODY" in *'"type":"srtConn"'*) THRESH=$SRT_STALL_SECS; SRC_CODEC=hevc ;; esac
  BYTES=$(echo "$BODY" | sed -n 's/.*"bytesReceived":\([0-9]*\).*/\1/p')
  # First sighting seeds the baseline but does NOT count as flowing — a zombie
  # session (rude drop, ICE not yet timed out) must never start a session on a
  # cold supervisor start (learned on prod 2026-07-02).
  if [ -z "$LAST_BYTES" ]; then LAST_BYTES="$BYTES"; LAST_CHANGE=0; LINK=stalled; return; fi
  if [ "$BYTES" != "$LAST_BYTES" ]; then LAST_BYTES="$BYTES"; LAST_CHANGE=$NOW_S; BYTE_AGE=0; fi
  if [ $(( NOW_S - LAST_CHANGE )) -lt "$THRESH" ]; then LINK=up; else LINK=stalled; fi
}

# Did the streamer PRESS End (hub signal ≤25s ago)? Falls back to the
# byte-age heuristic (gone while bytes were fresh) when no hub is configured
# or reachable.
deliberate_end() {
  if [ -n "$HUB" ]; then
    ENDED_AT=$(curl -s -m 1 "$HUB/stream/end" 2>/dev/null | sed -n 's/.*"endedAt":"\([^"]*\)".*/\1/p')
    if [ -n "$ENDED_AT" ]; then
      ENDED_EPOCH=$(date -u -d "$ENDED_AT" +%s 2>/dev/null || echo 0)
      [ $(( $(now) - ENDED_EPOCH )) -le 25 ] && return 0
      return 1
    fi
    # Hub reachable path failed or never-signalled: heuristic below.
  fi
  [ "$BYTE_AGE" -le 2 ]
}

# Stream protection: owner-set "never end by itself" (hub setting). While on,
# grace expiry re-arms instead of ending — the card holds until the streamer
# returns or deliberately ends. Phone restarts and hour-long dead zones are
# covered; only End Stream (or the relay operator) closes the broadcast.
never_end() {
  [ -n "$HUB" ] || return 1
  curl -s -m 1 "$HUB/stream/end" 2>/dev/null | grep -q '"neverEnd":true'
}

session_end() {
  log "session END ($1) -> stopping broadcast"
  kill_pid "$PUSHER_PID"; kill_pid "$LIVE_PID"; kill_pid "$BRB_PID"; kill_pid "$PREVIEW_PID"
  PUSHER_PID=0; LIVE_PID=0; BRB_PID=0; PREVIEW_PID=0
}
cleanup() { session_end "supervisor shutdown"; exit 0; }
trap cleanup INT TERM

state=idle
brb_since=0; brb_deadline=$GRACE; brb_reason="grace expired"
# Never log the output URL verbatim — it carries the stream key.
if resolve_out; then OUT_DESC="${OUT_EFF%%/app/*}/app/***"; else OUT_DESC="(no key yet — Twitch link or TWITCH_STREAM_KEY)"; fi
log "supervisor up (idle) -> ${OUT_DESC}   grace=${GRACE}s linger=${END_LINGER}s stall=${STALL_SECS}s/srt:${SRT_STALL_SECS}s media=${BRB_MEDIA:-none}"

while true; do
  poll_live
  case "$state" in
    idle)
      if [ "$LINK" = up ]; then
        log "phone UP -> session START (live)"
        # Prewarm the card (hub fetch + video mezzanine) so a drop never
        # waits on a download or transcode. Subshell: no global side effects.
        ( resolve_card && build_mez ) >/dev/null 2>&1 &
        start_live; start_preview; sleep 1; start_pusher; state=live
      fi ;;
    live)
      case "$LINK" in
        up)
          if ! alive "$PUSHER_PID"; then
            # PID 0 = never started (waiting on a stream key) — retry quietly.
            [ "$PUSHER_PID" -ne 0 ] && log "pusher died -> restart"
            start_pusher || true
          fi
          alive "$LIVE_PID"   || { log "live feeder died -> restart"; start_live; }
          alive "$PREVIEW_PID" || start_preview ;;
        gone)
          # Clean end ONLY on the app's deliberate-end signal (hub
          # /stream/end within 25s; no-hub relays fall back to byte-age) —
          # a dying connection's stray goodbye must never end the broadcast.
          if deliberate_end; then
            log "phone UNPUBLISHED (deliberate end) -> ending in ${END_LINGER}s unless it returns"
            kill_pid "$LIVE_PID"; LIVE_PID=0; start_brb
            brb_since=$(now); brb_deadline=$END_LINGER; brb_reason="clean end"; state=brb
          else
            log "phone DROP (path gone, no end signal) -> BRB (grace ${GRACE}s)"
            kill_pid "$LIVE_PID"; LIVE_PID=0; start_brb
            brb_since=$(now); brb_deadline=$GRACE; brb_reason="grace expired"; state=brb
          fi ;;
        stalled|err)
          log "phone DROP -> BRB (grace ${GRACE}s)"
          kill_pid "$LIVE_PID"; LIVE_PID=0; start_brb
          brb_since=$(now); brb_deadline=$GRACE; brb_reason="grace expired"; state=brb ;;
      esac ;;
    brb)
      if [ "$LINK" = up ]; then
        log "phone RECONNECTED -> live"
        kill_pid "$BRB_PID"; BRB_PID=0; start_live; start_preview; state=live
      else
        if ! alive "$PUSHER_PID"; then
          [ "$PUSHER_PID" -ne 0 ] && log "pusher died -> restart"
          start_pusher || true
        fi
        alive "$BRB_PID"    || { log "BRB feeder died -> restart"; start_brb; }
        # The streamer can END from anywhere, anytime — even mid-card with a
        # dead uplink (post-restart, out of range). The beacon always wins.
        if [ "$brb_reason" != "clean end" ] && deliberate_end; then
          log "deliberate end signalled during BRB -> ending in ${END_LINGER}s unless the phone returns"
          brb_deadline=$END_LINGER; brb_since=$(now); brb_reason="clean end"
        fi
        if [ $(( $(now) - brb_since )) -ge "$brb_deadline" ]; then
          if [ "$brb_reason" = "grace expired" ] && never_end; then
            log "grace reached but stream protection is ON -> holding the card, staying live"
            brb_since=$(now)
          else
            session_end "$brb_reason"; state=idle
          fi
        fi
      fi ;;
  esac
  sleep 1
done
