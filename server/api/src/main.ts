// Session hub entrypoint. One process on the VPS, next to the relay:
//   ws://<host>:<PORT>/ws   — the session bus (see docs/STUDIO.md)
//   GET /healthz            — liveness
//
// Config via env (all optional in dev; set in deploy.env in prod):
//   PORT           listen port                      (default 8787)
//   SESSION_CODE   shared join code for the rig     (default "connected" + warning)
//   TWITCH_CHANNEL initial chat channel to read     (default none — set from a device)

import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { HubClientMessage, MemberPerms } from "./protocol.ts";
import { Session, OWNER_PERMS, type JoinAuth } from "./session.ts";
import { Store } from "./store.ts";
import { Auth } from "./auth.ts";
import { Brb } from "./brb.ts";
import { TwitchLink } from "./twitch-eventsub.ts";
import { RewardSounds } from "./reward-sounds.ts";
import {
  createCheckout,
  stripeEnabled,
  verifyWebhook,
  type StripeConfig,
} from "./stripe.ts";

const PORT = Number(process.env.PORT ?? 8787);
const SESSION_CODE = process.env.SESSION_CODE ?? "connected";
const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL ?? "";

// Donations (all optional — endpoints answer "disabled" until keys exist).
const STRIPE: StripeConfig = {
  secretKey: process.env.STRIPE_SECRET_KEY ?? "",
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  currency: (process.env.DONATION_CURRENCY ?? "usd").toLowerCase(),
  minCents: Number(process.env.DONATION_MIN_CENTS ?? 100),
  mediaMinCents: Number(process.env.DONATION_MEDIA_MIN_CENTS ?? 500),
  publicWebOrigin: process.env.PUBLIC_WEB_ORIGIN ?? "http://localhost:3000",
};

if (!process.env.SESSION_CODE) {
  console.warn(
    "[hub] SESSION_CODE not set — using the default. Fine on localhost; set a real code in deploy.env in production.",
  );
}

// One session today (one relay = one streamer). Keyed by code so accounts can
// multiplex later without a protocol change.
const session = new Session(TWITCH_CHANNEL);

// Team + overlay-layout persistence (SQLite under DATA_DIR).
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const store = new Store(DATA_DIR);

// BRB card customization (text + fullscreen image/video) — the relay
// supervisor fetches this when it swaps the card in.
const brb = new Brb(store, DATA_DIR);

// The owner's minimum-bits-for-voice floor lives in the kv store.
session.ttsMinBits = () => Number(store.getKv("ttsMinBits") ?? 1) || 1;
// Read-chat-aloud is opt-in and persisted; apply the owner's choice on boot.
if (store.getKv("ttsReadChat") === "true") session.setTtsSource("chat", true);
// Speak sender names before messages? Off unless the owner turned it on.
session.ttsSayNames = () => store.getKv("ttsSayNames") === "true";

// Identity: relay claim, owner login, guest code (docs/ONBOARDING.md).
const auth = new Auth(store);

// Twitch link (device-code OAuth + EventSub ws): reward redemptions with
// titles/ids — the only path that sees SOUND-EFFECT rewards (no text = no IRC
// message) — plus follows. Optional; IRC keeps working unlinked.
const twitch = new TwitchLink(store, process.env.TWITCH_CLIENT_ID ?? "");
const sounds = new RewardSounds(store, DATA_DIR);
session.suppressIrcRewards = () => twitch.linked();
twitch.onRedemption = (r) => {
  const detail = r.input ? `${r.rewardTitle}: ${r.input}` : r.rewardTitle;
  session.publishAlert(
    {
      id: `rw${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      kind: "reward",
      user: r.user,
      detail,
      rewardId: r.rewardId,
      at: new Date().toISOString(),
    },
    r.input,
    sounds.soundUrl(r.rewardId) ?? undefined,
  );
};
twitch.onFollow = (user) => {
  session.publishAlert({
    id: `fl${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    kind: "follow",
    user,
    detail: "followed",
    at: new Date().toISOString(),
  });
};
// One link, everything derived: if no chat channel was ever configured, the
// linked login IS the channel.
twitch.onLinked = () => {
  const login = twitch.login();
  if (login) session.ensureChannel(login);
};

// Relay truth: poll MediaMTX for the live path so the cockpit can show what
// viewers ACTUALLY see (BRB card vs program) instead of inferring from RTT.
const MTX_API = process.env.MTX_API ?? "http://127.0.0.1:9997";
setInterval(async () => {
  try {
    const res = await fetch(`${MTX_API}/v3/paths/get/live`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      session.setRelayStatus(false, 0);
      return;
    }
    const body = (await res.json()) as { ready?: boolean; readers?: unknown[] };
    session.setRelayStatus(body.ready === true, body.readers?.length ?? 0);
  } catch {
    // MediaMTX unreachable — say nothing rather than lie; keep last state.
  }
}, 3000);

const server = createServer((req, res) => {
  // In production Caddy mounts the hub at /hub/* and strips the prefix; when
  // the hub is reached DIRECTLY on its port (dev rigs, proxy-less installs),
  // accept the prefixed shape too so clients need no special casing.
  if (req.url === "/hub") req.url = "/";
  else if (req.url?.startsWith("/hub/")) req.url = req.url.slice(4);
  // The web app may live on a different origin (localhost dev; static-export
  // host vs relay host). Auth is the session code, not the origin — allow all.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader(
    "access-control-allow-headers",
    "content-type, x-session-code, x-owner-token",
  );
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // "Test alert" — every alert system needs one (and it exercises the full
  // donation path before Stripe lands). Auth: the session code.
  if (req.method === "POST" && req.url === "/test/donation") {
    if (req.headers["x-session-code"] !== SESSION_CODE) {
      res.writeHead(401);
      res.end();
      return;
    }
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        session.publishDonation({
          id: `d${Date.now().toString(36)}`,
          donor: String(b.donor ?? "Test Donor"),
          amountCents: Number(b.amountCents ?? 500),
          currency: String(b.currency ?? "usd"),
          message: String(b.message ?? "This is a test donation!"),
          mediaUrl:
            typeof b.mediaUrl === "string"
              ? sanitizeMediaUrl(b.mediaUrl)
              : undefined,
          at: new Date().toISOString(),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        res.writeHead(400);
        res.end();
      });
    return;
  }

  // Owner = a logged-in owner token; the deploy.env session code stays as the
  // bootstrap/recovery credential (docs/ONBOARDING.md).
  const isOwner =
    auth.isOwnerToken(req.headers["x-owner-token"] as string | undefined) ||
    req.headers["x-session-code"] === SESSION_CODE;

  // --- Identity (docs/ONBOARDING.md) ------------------------------------------
  if (req.method === "GET" && req.url === "/relay/info") {
    json(res, 200, {
      claimed: auth.claimed(),
      owner: auth.ownerUsername(),
      brand: process.env.BRAND ?? "connected",
      // SRT can't ride an HTTP proxy (Cloudflare) — the app needs the box's
      // DIRECT address. Null when unset: the app falls back to the relay
      // hostname (fine when DNS points straight at the box).
      srtHost: process.env.SRT_HOST || null,
      srtPort: Number(process.env.SRT_PORT ?? 8890),
      // SRTLA bonding receiver (BELABOX srtla_rec) — the app's bonded mode
      // sends its group here; plain SRT stays on srtPort.
      srtlaPort: Number(process.env.SRTLA_PORT ?? 8895),
    });
    return;
  }

  if (req.method === "POST" && req.url === "/account/claim") {
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        if (auth.claimed()) {
          json(res, 409, { error: "This relay already has a main account." });
          return;
        }
        const token = auth.claim(String(b.username ?? ""), String(b.password ?? ""));
        if (!token) {
          json(res, 400, {
            error: "Pick a username and a password of at least 6 characters.",
          });
          return;
        }
        json(res, 200, { token, username: auth.ownerUsername() });
      })
      .catch(() => deny(res, 400));
    return;
  }

  if (req.method === "POST" && req.url === "/account/login") {
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const token = auth.login(String(b.username ?? ""), String(b.password ?? ""));
        if (!token) {
          json(res, 401, { error: "Wrong username or password." });
          return;
        }
        json(res, 200, { token, username: auth.ownerUsername() });
      })
      .catch(() => deny(res, 400));
    return;
  }

  // PUBLIC + gated by the guest code: joining as a guest.
  if (req.method === "POST" && req.url === "/guest/join") {
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        if (!auth.claimed()) {
          json(res, 409, { error: "This relay has no main account yet." });
          return;
        }
        const code = auth.guestCode();
        if (!code || String(b.guestCode ?? "") !== code) {
          json(res, 401, { error: "Wrong guest code." });
          return;
        }
        const member = store.createDirectMember(
          String(b.name ?? "").trim(),
          auth.guestDefaults(),
        );
        json(res, 200, { token: member.token, name: member.name, perms: member.perms });
      })
      .catch(() => deny(res, 400));
    return;
  }

  // Owner-side guest management: read config, rotate the code, set defaults.
  if (req.method === "GET" && req.url === "/guest/config") {
    if (!isOwner) return deny(res);
    json(res, 200, { code: auth.guestCode(), defaults: auth.guestDefaults() });
    return;
  }
  if (req.method === "POST" && req.url === "/guest/code") {
    if (!isOwner) return deny(res);
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        json(res, 200, {
          code: auth.rotateGuestCode(
            typeof b.code === "string" ? b.code : undefined,
          ),
        });
      })
      .catch(() => deny(res, 400));
    return;
  }
  if (req.method === "POST" && req.url === "/guest/defaults") {
    if (!isOwner) return deny(res);
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        json(res, 200, {
          defaults: auth.setGuestDefaults((b.perms ?? {}) as Partial<MemberPerms>),
        });
      })
      .catch(() => deny(res, 400));
    return;
  }

  // --- Team: the owner invites, members claim. -------------------------------
  if (req.method === "POST" && req.url === "/team/invites") {
    if (!isOwner) return deny(res);
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const invite = store.createInvite(
          (b.perms ?? {}) as Partial<MemberPerms>,
          typeof b.name === "string" ? b.name : undefined,
        );
        json(res, 200, invite);
      })
      .catch(() => deny(res, 400));
    return;
  }

  if (req.method === "GET" && req.url === "/team") {
    if (!isOwner) return deny(res);
    json(res, 200, {
      members: store.listMembers().map(({ token: _t, ...m }) => m), // tokens stay secret
      invites: store.listInvites(),
    });
    return;
  }

  if (req.method === "POST" && req.url === "/team/revoke") {
    if (!isOwner) return deny(res);
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        if (typeof b.memberId === "string") store.removeMember(b.memberId);
        if (typeof b.inviteCode === "string") store.deleteInvite(b.inviteCode);
        json(res, 200, { ok: true });
      })
      .catch(() => deny(res, 400));
    return;
  }

  if (req.method === "POST" && req.url === "/team/perms") {
    if (!isOwner) return deny(res);
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const ok =
          typeof b.memberId === "string" &&
          store.setMemberPerms(b.memberId, b.perms as MemberPerms);
        json(res, ok ? 200 : 404, { ok });
      })
      .catch(() => deny(res, 400));
    return;
  }

  // PUBLIC: an invited person turns their invite code into a personal token.
  if (req.method === "POST" && req.url === "/team/claim") {
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const member = store.claimInvite(
          String(b.code ?? ""),
          String(b.name ?? "").trim(),
        );
        if (!member) {
          json(res, 404, { error: "That invite doesn't exist (or was already used)." });
          return;
        }
        json(res, 200, {
          token: member.token,
          name: member.name,
          perms: member.perms,
        });
      })
      .catch(() => deny(res, 400));
    return;
  }

  // Member self-service: the bandwidth-share opt-in (recorded now; the SRTLA
  // bonding phase consumes it).
  if (req.method === "POST" && req.url === "/team/me") {
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const ok = store.setMemberShare(
          String(b.token ?? ""),
          b.shareBandwidth === true,
        );
        json(res, ok ? 200 : 401, { ok });
      })
      .catch(() => deny(res, 400));
    return;
  }

  // --- Overlay layout: the owner's web editor saves it; the native app reads
  // it and burns the SAME layout into the broadcast. --------------------------
  if (req.url === "/overlays" && (req.method === "GET" || req.method === "PUT")) {
    if (!isOwner) return deny(res);
    if (req.method === "GET") {
      const raw = store.getKv("overlays");
      if (!raw) {
        json(res, 404, { error: "No layout saved yet." });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(raw);
      return;
    }
    readRaw(req)
      .then((raw) => {
        JSON.parse(raw); // must at least be JSON
        store.setKv("overlays", raw.slice(0, 64_000));
        json(res, 200, { ok: true });
      })
      .catch(() => deny(res, 400));
    return;
  }

  // --- Deliberate-end signal: the app calls this as the streamer presses End
  // Stream; the BRB supervisor checks it before treating a vanished uplink as
  // a clean end. Removes ALL guessing — a dying connection's stray goodbye
  // can never end the broadcast again. ---------------------------------------
  if (req.method === "POST" && req.url === "/stream/end") {
    if (!isOwner) return deny(res);
    store.setKv("streamEndedAt", new Date().toISOString());
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && req.url === "/stream/end") {
    json(res, 200, {
      endedAt: store.getKv("streamEndedAt"),
      // Stream protection: with this on, the relay NEVER auto-ends the
      // broadcast — the BRB card holds until the streamer returns or
      // deliberately ends. (Phone restarts, hour-long dead zones: covered.)
      neverEnd: store.getKv("neverEnd") === "true",
    });
    return;
  }
  // --- Voice (TTS) config: the owner's minimum bits before a cheer is read
  // aloud. Below the floor the alert still shows — it's just silent. --------
  if (req.method === "GET" && req.url === "/tts/config") {
    json(res, 200, {
      minBits: Number(store.getKv("ttsMinBits") ?? 1) || 1,
      readChat: store.getKv("ttsReadChat") === "true",
      sayNames: store.getKv("ttsSayNames") === "true",
    });
    return;
  }
  if (req.method === "POST" && req.url === "/tts/config") {
    if (!isOwner) return deny(res);
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        let minBits = Number(store.getKv("ttsMinBits") ?? 1) || 1;
        if (b.minBits !== undefined) {
          const raw = Math.floor(Number(b.minBits));
          minBits =
            Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 1_000_000) : 1;
          store.setKv("ttsMinBits", String(minBits));
        }
        let readChat = store.getKv("ttsReadChat") === "true";
        if (b.readChat !== undefined) {
          readChat = b.readChat === true;
          store.setKv("ttsReadChat", String(readChat));
          session.setTtsSource("chat", readChat);
        }
        let sayNames = store.getKv("ttsSayNames") === "true";
        if (b.sayNames !== undefined) {
          sayNames = b.sayNames === true;
          store.setKv("ttsSayNames", String(sayNames));
        }
        json(res, 200, { minBits, readChat, sayNames });
      })
      .catch(() => deny(res, 400));
    return;
  }

  // The RTMP stream key, for the BRB pusher. NEVER public: reachable only
  // from the box itself (a reverse proxy always stamps x-forwarded-for, so a
  // proxied request can't masquerade as local) — or with owner auth.
  if (req.method === "GET" && req.url === "/stream/key") {
    const proxied = req.headers["x-forwarded-for"] !== undefined;
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress ?? "",
    );
    if (!((local && !proxied) || isOwner)) return deny(res);
    const key = twitch.cachedStreamKey();
    // Serve the cache instantly; freshen behind the scenes so rotation is
    // picked up by the NEXT pusher start.
    if (twitch.linked()) void twitch.refreshStreamKey();
    if (!key) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(key);
    return;
  }

  // --- Twitch link (device-code OAuth) + per-reward sound effects ----------
  if (req.method === "GET" && req.url === "/twitch/link") {
    if (!isOwner) return deny(res);
    json(res, 200, twitch.status());
    return;
  }
  if (req.method === "POST" && req.url === "/twitch/client") {
    if (!isOwner) return deny(res);
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        twitch.setClientId(String(b.clientId ?? ""));
        json(res, 200, twitch.status());
      })
      .catch(() => deny(res, 400));
    return;
  }
  if (req.method === "POST" && req.url === "/twitch/link/start") {
    if (!isOwner) return deny(res);
    twitch
      .startLink()
      .then((pending) => json(res, 200, pending))
      .catch((e) => json(res, 400, { error: String(e?.message ?? "couldn't start") }));
    return;
  }
  if (req.method === "DELETE" && req.url === "/twitch/link") {
    if (!isOwner) return deny(res);
    twitch.unlink().then(
      () => json(res, 200, twitch.status()),
      () => json(res, 200, twitch.status()),
    );
    return;
  }

  if (req.method === "GET" && req.url === "/rewards") {
    if (!isOwner) return deny(res);
    twitch.rewards().then((list) => {
      const map = sounds.all();
      const merged = list.map((r) => ({
        ...r,
        soundUrl: sounds.soundUrl(r.id),
      }));
      // Sounds mapped to rewards Helix didn't return (unlinked, or deleted on
      // Twitch) still render — deletable, and they still fire if redeemed.
      for (const [id, meta] of Object.entries(map)) {
        if (!merged.some((r) => r.id === id)) {
          merged.push({
            id,
            title: meta.title || "(saved sound)",
            cost: 0,
            enabled: true,
            soundUrl: sounds.soundUrl(id),
          });
        }
      }
      json(res, 200, { linked: twitch.linked(), rewards: merged });
    });
    return;
  }

  {
    const soundMatch = req.url?.split("?")[0].match(/^\/rewards\/sound\/([A-Za-z0-9-]{1,64})$/);
    if (soundMatch) {
      const id = soundMatch[1];
      if (req.method === "GET") {
        sounds.serve(id, req, res);
        return;
      }
      if (req.method === "POST") {
        if (!isOwner) return deny(res);
        const title = new URL(req.url ?? "", "http://x").searchParams.get("title") ?? "";
        sounds
          .upload(id, title, req)
          .then((meta) => {
            if (!meta) {
              json(res, 415, { error: "Upload an audio file (mp3, wav, ogg…)." });
              return;
            }
            json(res, 200, { ...meta, soundUrl: sounds.soundUrl(id) });
          })
          .catch((e) => json(res, 413, { error: String(e?.message ?? "upload failed") }));
        return;
      }
      if (req.method === "DELETE") {
        if (!isOwner) return deny(res);
        sounds.remove(id);
        json(res, 200, { ok: true });
        return;
      }
    }
  }

  // Fire the reward path without Twitch — for testing the full chain (alert
  // card + sound in the broadcast) and for the settings UI's test button.
  if (req.method === "POST" && req.url === "/test/reward") {
    if (!isOwner) return deny(res);
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const rewardId = String(b.rewardId ?? "");
        const title = String(b.title ?? "Test reward");
        const input = String(b.input ?? "");
        session.publishAlert(
          {
            id: `rwt${Date.now().toString(36)}`,
            kind: "reward",
            user: String(b.user ?? "Test viewer"),
            detail: input ? `${title}: ${input}` : title,
            rewardId: rewardId || undefined,
            at: new Date().toISOString(),
          },
          input,
          rewardId ? sounds.soundUrl(rewardId) ?? undefined : undefined,
        );
        json(res, 200, { ok: true });
      })
      .catch(() => deny(res, 400));
    return;
  }

  if (req.method === "GET" && req.url === "/stream/protection") {
    json(res, 200, { neverEnd: store.getKv("neverEnd") === "true" });
    return;
  }
  if (req.method === "POST" && req.url === "/stream/protection") {
    if (!isOwner) return deny(res);
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        store.setKv("neverEnd", b.neverEnd === true ? "true" : "false");
        json(res, 200, { neverEnd: b.neverEnd === true });
      })
      .catch(() => deny(res, 400));
    return;
  }

  // --- BRB card: owner customizes it in the app; the relay supervisor fetches
  // it (public reads — the card is broadcast to viewers anyway). -------------
  if (req.method === "GET" && req.url === "/brb/config") {
    json(res, 200, brb.meta());
    return;
  }
  if (req.method === "GET" && req.url === "/brb/text") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(brb.meta().text);
    return;
  }
  // Preview URLs cache-bust with ?v=… — match on the path, not the raw url.
  if (req.method === "GET" && req.url?.split("?")[0] === "/brb/media") {
    brb.serveMedia(req, res);
    return;
  }
  if (req.method === "PUT" && req.url === "/brb/config") {
    if (!isOwner) return deny(res);
    readJson(req)
      .then((body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        json(res, 200, brb.setText(String(b.text ?? "")));
      })
      .catch(() => deny(res, 400));
    return;
  }
  if (req.method === "POST" && req.url === "/brb/media") {
    if (!isOwner) return deny(res);
    brb
      .upload(req)
      .then((meta) => {
        if (!meta) {
          json(res, 415, { error: "Upload an image or a video." });
          return;
        }
        json(res, 200, meta);
      })
      .catch((e) => {
        json(res, 413, { error: String(e?.message ?? "upload failed") });
      });
    return;
  }
  if (req.method === "DELETE" && req.url === "/brb/media") {
    if (!isOwner) return deny(res);
    json(res, 200, brb.removeMedia());
    return;
  }

  // Donor-facing config for the /donate page.
  if (req.method === "GET" && req.url === "/donations/config") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        enabled: stripeEnabled(STRIPE),
        currency: STRIPE.currency,
        minCents: STRIPE.minCents,
        mediaMinCents: STRIPE.mediaMinCents,
      }),
    );
    return;
  }

  // PUBLIC: a donor starts a payment. Returns Stripe's hosted checkout URL.
  if (req.method === "POST" && req.url === "/donations/checkout") {
    if (!stripeEnabled(STRIPE)) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Donations aren't set up on this relay." }));
      return;
    }
    readJson(req)
      .then(async (body) => {
        const b = (body ?? {}) as Record<string, unknown>;
        const amountCents = Math.floor(Number(b.amountCents));
        if (!Number.isFinite(amountCents) || amountCents < STRIPE.minCents) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Amount is below the minimum." }));
          return;
        }
        const mediaUrl =
          amountCents >= STRIPE.mediaMinCents && typeof b.mediaUrl === "string"
            ? sanitizeMediaUrl(b.mediaUrl)
            : undefined;
        const url = await createCheckout(STRIPE, {
          donor: String(b.donor ?? "Anonymous").trim() || "Anonymous",
          message: String(b.message ?? "").trim(),
          amountCents,
          mediaUrl,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ url }));
      })
      .catch((e) => {
        console.error("[donations] checkout failed:", e);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Couldn't start the payment." }));
      });
    return;
  }

  // Stripe calls this when a payment completes. Signature-verified.
  if (req.method === "POST" && req.url === "/webhooks/stripe") {
    readRaw(req)
      .then((raw) => {
        const event = verifyWebhook(
          raw,
          req.headers["stripe-signature"] as string | undefined,
          STRIPE.webhookSecret,
        );
        if (!event) {
          res.writeHead(400);
          res.end();
          return;
        }
        if (event.type === "checkout.session.completed") {
          const o = event.data.object;
          session.publishDonation({
            id: `d-${o.id}`,
            donor: o.metadata?.donor || "Anonymous",
            amountCents: o.amount_total ?? 0,
            currency: o.currency ?? STRIPE.currency,
            message: o.metadata?.message ?? "",
            mediaUrl: o.metadata?.mediaUrl || undefined,
            at: new Date().toISOString(),
          });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      })
      .catch(() => {
        res.writeHead(400);
        res.end();
      });
    return;
  }

  res.writeHead(404);
  res.end();
});

/** Mediashare links: YouTube only for now — a URL we know how to embed and
    bound. Anything else is dropped, not trusted. */
function sanitizeMediaUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
      return u.toString().slice(0, 400);
    }
  } catch {
    // fall through
  }
  return undefined;
}

function readRaw(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 128_000) reject(new Error("too large"));
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function json(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function deny(res: import("node:http").ServerResponse, status = 401): void {
  res.writeHead(status);
  res.end();
}

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 64_000) reject(new Error("too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Same dual-shape story for the websocket: /ws behind the proxy, /hub/ws when
// a client dials the port directly.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/ws" || path === "/hub/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws: WebSocket) => {
  let joined = false;

  // The first message must be a join with the right code; anything else drops.
  ws.on("message", (data) => {
    let msg: HubClientMessage;
    try {
      msg = JSON.parse(String(data)) as HubClientMessage;
    } catch {
      return;
    }

    if (!joined) {
      if (msg.type !== "join") {
        ws.close(4001, "unauthorized");
        return;
      }
      // Owner (logged-in token OR the bootstrap session code) or member/guest.
      let joinAuth: JoinAuth | null = null;
      if (msg.code === SESSION_CODE || auth.isOwnerToken(msg.token)) {
        joinAuth = { owner: true, perms: OWNER_PERMS };
      } else if (msg.token) {
        const member = store.memberByToken(msg.token);
        if (member) {
          store.touchMember(member.id);
          joinAuth = { owner: false, perms: member.perms, memberId: member.id };
        }
      }
      if (!joinAuth) {
        ws.send(
          JSON.stringify({ type: "error", message: "Wrong session code or token." }),
        );
        ws.close(4001, "unauthorized");
        return;
      }
      joined = true;
      session.join(ws, msg.role, msg.name, joinAuth);
      return;
    }
    session.handle(ws, msg);
  });

  ws.on("close", () => session.leave(ws));
  ws.on("error", () => ws.close());
});

// Heartbeat: drop dead connections so the member list stays honest.
const alive = new WeakMap<WebSocket, boolean>();
wss.on("connection", (ws: WebSocket) => {
  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`[hub] listening on :${PORT} (ws path /ws)`);
});

export { session };
