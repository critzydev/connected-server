# Connected BRB relay — "never cut out"

The engine that keeps a stream on Twitch even when the phone's signal drops. Built and
lab-validated 2026-06-29; **live on prod since 2026-07-02** (ingest-only MediaMTX + the
supervisor container).

## How it works
A streaming **session** begins when the phone starts publishing to MediaMTX (`live` path).
During a session:

- A single **pusher** (ffmpeg) holds the Twitch RTMP connection open and re-encodes a local
  **UDP bus** → Twitch. It never restarts mid-session.
- Exactly one **feeder** writes to that bus at a time:
  - **live feeder** — phone stream from MediaMTX (`rtsp://…/live`, video copied, audio→AAC)
  - **BRB feeder** — a "Reconnecting…" card (synthesized color+text, or your own
    image/looping video via `BRB_MEDIA`) + silence (video audio kept if present)
- The **supervisor** polls the MediaMTX API and classifies the uplink every second:
  - **up** — path ready and `bytesReceived` growing.
  - **stalled** — ready but bytes frozen ≥ `STALL_SECS`: a **rude drop** (a dead WebRTC
    uplink stays "ready" ~30s until ICE times out; bytes are the truth). Card covers for
    up to `GRACE` seconds.
  - **gone** — nobody publishing: a **clean end** (the app's WHIP DELETE lands instantly,
    while bytes were still flowing). Broadcast closes after `END_LINGER` seconds
    (flap insurance — if the phone republishes within the linger, the session resumes).

```
idle ──phone up──▶ live ──rude drop──▶ brb(GRACE) ──reconnect──▶ live
                    │                    │ (deadline passes) ─▶ idle (broadcast ends)
                    └──clean end───▶ brb(END_LINGER) ─┘
```

**Why a UDP bus:** a normal MediaMTX reader EOFs (and the process exits) the instant its
publisher disconnects — so it can't survive a source swap. A connectionless UDP bus has no
EOF, so swapping feeders is just a ~1s data gap; the pusher (and the Twitch broadcast) stays
up. This is the load-bearing trick. It costs **one transcode** at the pusher (the price of
seamless source switching — see `../../../CLAUDE.md` Conventions).

## Run
`Dockerfile` bakes ffmpeg/ffprobe + DejaVu (no host-font mount needed). Env knobs
(`supervisor.sh` reads them): `API`, `LIVE_PATH`, `LIVE_INPUT`, `LIVE_INPUT_OPTS`, `UDP`,
`OUT`, `FONT`, `W/H/FPS`, `VBITRATE`, `GRACE`, `END_LINGER`, `STALL_SECS`, `BRB_TEXT`,
`BRB_BG`, `BRB_FG`, `BRB_MEDIA`. The fresh-VPS path wires all of these from `deploy.env`
(see `server/infra/`); any box can also run the same image standalone.

## Lab notes (gotchas found)
- The stock mediamtx image has **no fonts** → the portable Dockerfile bakes DejaVu instead.
- Busybox shells have no `exec -a` — don't name ffmpeg procs that way; match by args.
- `${VAR:-default}` treats an empty override as unset; use `${VAR-default}` where an explicit
  empty value must be honored (e.g. `LIVE_INPUT_OPTS`).
- A rude WebRTC drop leaves the path "ready" ~31s (ICE timeout) — readiness alone is a lie;
  the byte-stall detector exists because of this (measured on prod 2026-07-02).
- A clean WHIP DELETE is the *only* way the path goes from flowing→gone in one poll; that's
  what makes fast-end detection safe. API-unreachable (`err`) is deliberately treated like a
  drop, never like a clean end.
