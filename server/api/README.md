# @connected/api — the studio session hub

The websocket event bus behind the studio layer (docs/STUDIO.md): device
roles, server-side Twitch chat, the shared TTS queue (mute/skip from any
phone), and Stripe donations. One process, one dependency (`ws`), runs the
TypeScript source directly on Node 26.

## Run it

```sh
# dev (from the repo root)
npm run hub          # = node --watch server/api/src/main.ts on :8787

# prod: part of the compose stack — server/infra/setup.sh brings it up and
# Caddy exposes it at https://<DOMAIN>/hub/* (ws at /hub/ws).
```

## Config (env / deploy.env)

| Var | Default | What |
|---|---|---|
| `PORT` | `8787` | listen port |
| `SESSION_CODE` | `connected` (+warning) | the rig's join code; setup.sh generates one |
| `TWITCH_CHANNEL` | — | chat channel to read at boot (devices can set it too) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | — | donations off until both set |
| `DONATION_CURRENCY` | `usd` | |
| `DONATION_MIN_CENTS` | `100` | |
| `DONATION_MEDIA_MIN_CENTS` | `500` | mediashare attach threshold |
| `PUBLIC_WEB_ORIGIN` | `https://<DOMAIN>` | where Stripe returns donors (`/donate`) |

## Endpoints

- `GET /healthz` — liveness
- `WS /ws` — the session bus; first message must be `{type:"join", code, role, name}`; shapes in `@connected/protocol`
- `GET /donations/config` — public, for the /donate page
- `POST /donations/checkout` — public; returns Stripe's hosted checkout URL
- `POST /webhooks/stripe` — signature-verified; `checkout.session.completed` → donation on the bus
- `POST /test/donation` — the "test alert" button (auth: `x-session-code` header)

## Design notes

- **The queue lives here, not on a device** — that's what makes cross-device
  TTS controls possible. Devices are mouths; the hub is the brain.
- **Donations jump chat** in the queue; deep chat backlogs drop instead of
  running minutes behind (`tts-queue.ts`).
- **No `stripe` npm dep**: one form-encoded POST (Checkout) + one HMAC verify
  (webhook) — see `stripe.ts`.
- `src/protocol.ts` re-exports `packages/protocol` via a relative path because
  Node's native TS loading refuses `.ts` files under `node_modules`.

## Still to come (the original scope of this package)

Accounts + per-streamer stream keys/ingest paths, Twitch OAuth (EventSub
alerts, chat send, mod actions), mediashare queue with approve/skip, guest
bonding tokens (Phase 3), relay telemetry + control. SQLite lands with
accounts; today the hub is deliberately stateless.
