# packages/protocol — Shared types

One source of truth for everything that crosses a boundary, so web, mobile, companion, and server never drift.

- **Control messages** — start/stop, bitrate ceiling, simulcast targets, force BRB.
- **Telemetry schema** — per-link stats, resolution, uptime.
- **Guest-token schema** — issue/redeem/expire.
- **Account / stream-key shapes.**

Authored in TypeScript; generate Dart + Rust bindings for the native side. Changing a message here updates every client and the server at once.
