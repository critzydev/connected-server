# Connected Server

Your own streaming server: **phone → your server → Twitch**, built so your
stream never cuts out. If your phone loses signal, viewers see your
Be-right-back screen — for as long as it takes — and the broadcast only ends
when **you** end it.

You get: a rock-solid HEVC ingest with connection bonding (use WiFi +
cellular + your crew's phones at the same time), a web studio for your crew
(chat, alerts, TTS, moderation), and a
customizable Be-right-back screen — all on a $5/month server you control.

## What you need

1. **A VPS** — a cheap cloud server: 2+ cores, 4GB RAM, Ubuntu 24.04.
   (OVH, Hetzner, and DigitalOcean all have one for around $5/month.
   2 cores runs a lean 720p profile automatically; get 4+ cores for
   full 1080p output quality.)
2. **A domain you own** — e.g. `mystream.com`.
3. **Your Twitch stream key** — Twitch → Creator Dashboard → Settings →
   Stream → copy the key.

## Setup (one command)

Connect to your server (`ssh ubuntu@YOUR_SERVER_IP`) and run:

```sh
git clone https://github.com/critzydev/connected-server && cd connected-server/server/infra && sudo ./first-boot.sh && ./setup.sh
```

The setup asks you two questions:

1. **Your domain** (e.g. `mystream.com`)
2. **Your Twitch stream key**

…then shows you **two DNS records** to create wherever your domain lives
(on Cloudflare: set proxy status to *DNS only* — the orange cloud OFF).
Create them, press Enter, and it finishes everything: firewall, HTTPS
certificates, the streaming engine, the studio, the never-cut-out
supervisor. When it prints **Done**, your server is live:

- **`https://yourdomain.com`** — your web studio (crew login, chat, alerts,
  and more)
- **`connected.yourdomain.com`** — what you enter as the relay in the
  Connected app

## First stream

1. Open `https://yourdomain.com/connect` → create your account (the first
   account claims the server — you're the owner).
2. In the Connected app: enter `connected.yourdomain.com` as your relay and
   log in.
3. Go live. If your phone ever loses signal mid-stream, viewers see your
   Be-right-back screen and the broadcast survives until you're back —
   that's the point of the whole thing.

Recommended first settings (web → Settings, or the app):
- **Be-right-back screen** → *Never end by itself* → ON
- Upload a custom BRB image or looping video
- Team page → create invite links for your crew

## Updating

```sh
cd connected-server && ./update.sh
```

Your settings, account, and uploads survive updates.

## If something breaks

- Status: `docker compose -f server/infra/compose.yml ps`
- The never-cut-out engine's log: `docker logs connected-brb -f`
- Re-running `./setup.sh` is always safe.
