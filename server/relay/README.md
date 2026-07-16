# server/relay — Ingest relay

The ace. Receives the stream, protects it, forwards it to Twitch. Same box across all phases.

- **Core:** MediaMTX — WHIP/WebRTC in (Phase 1), SRT/SRTLA in (Phase 2+), RTMP/HEVC out to Twitch.
- **Wrap (FFmpeg + supervisor):**
  - ~7s ingest **buffer**.
  - **BRB/standby**: input loss → standby loop to Twitch → seamless cut back on reconnect (keeps the session alive).
  - **Simulcast** to YouTube/Kick (stream copy).
  - **Recording / VODs** to disk.
  - Minimal WebRTC-H.264 → RTMP remux (avoid full transcode).
- **Keep passthrough** (no transcode) to stay on the cheap VPS. Server-side overlays would force a transcode → bigger VPS.

See [docs/SERVER.md](../../docs/SERVER.md). Deployed via `server/infra`.
