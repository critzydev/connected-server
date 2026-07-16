// Twitch link via DEVICE CODE + EventSub over WebSocket — the self-host-shaped
// OAuth: no public callback URL, no client secret. The owner pastes a client id
// once (or ships TWITCH_CLIENT_ID in deploy.env), presses Link, and the
// BROADCASTER types the short code at twitch.tv/activate. Tokens live in the
// kv store; a refresh loop keeps them alive.
//
// What rides EventSub (anonymous IRC can't see these):
//   channel.channel_points_custom_reward_redemption.add v1 — EVERY redemption,
//     with the reward TITLE and id (sound-effect rewards have no text and are
//     invisible to IRC; this is the only way they reach the app).
//   channel.follow v2 — the broadcaster token doubles as moderator.
//
// Scopes: channel:read:redemptions moderator:read:followers
//         channel:read:stream_key (the relay fetches the RTMP key itself — the
//         streamer links once and never copy-pastes a stream key)

import type { Store } from "./store.ts";

const ID_BASE = "https://id.twitch.tv/oauth2";
const HELIX = "https://api.twitch.tv/helix";
const EVENTSUB_WS = "wss://eventsub.wss.twitch.tv/ws";
const SCOPES =
  "channel:read:redemptions moderator:read:followers channel:read:stream_key";

export interface Redemption {
  rewardId: string;
  rewardTitle: string;
  user: string;
  input: string;
  cost: number;
}

export interface LinkStatus {
  clientId: boolean;
  linked: boolean;
  login: string;
  /** Present while a device-code login is waiting for the broadcaster. */
  pending?: { userCode: string; verificationUri: string; expiresAt: string };
  /** Last link/subscription failure, for the settings UI. */
  error?: string;
  eventsubConnected: boolean;
}

interface Tokens {
  access: string;
  refresh: string;
}

export class TwitchLink {
  onRedemption: (r: Redemption) => void = () => {};
  onFollow: (user: string) => void = () => {};
  /** Fires once a device-code login completes (tokens + user stored). */
  onLinked: () => void = () => {};

  private store: Store;
  private ws: import("ws").WebSocket | null = null;
  private wsConnected = false;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: LinkStatus["pending"] & { deviceCode?: string } | undefined;
  private lastError = "";
  private stopped = false;

  constructor(store: Store, envClientId: string) {
    this.store = store;
    // deploy.env wins only when nothing was saved from the UI yet.
    if (envClientId && !store.getKv("twitchClientId")) {
      store.setKv("twitchClientId", envClientId);
    }
    if (this.tokens()) this.connectEventSub();
    // Twitch requires hourly validation of user tokens; it doubles as our
    // token-health check (refresh on failure) and picks up a rotated stream
    // key within the hour.
    setInterval(() => {
      if (this.tokens()) {
        void this.validateOrRefresh().then((ok) => {
          if (ok) void this.refreshStreamKey();
        });
      }
    }, 3_600_000).unref?.();
  }

  // --- Public state ---------------------------------------------------------

  clientId(): string {
    return this.store.getKv("twitchClientId") ?? "";
  }

  setClientId(id: string): void {
    this.store.setKv("twitchClientId", id.trim().slice(0, 100));
  }

  linked(): boolean {
    return !!this.tokens();
  }

  login(): string {
    const raw = this.store.getKv("twitchUser");
    if (!raw) return "";
    try {
      return (JSON.parse(raw) as { login?: string }).login ?? "";
    } catch {
      return "";
    }
  }

  broadcasterId(): string {
    const raw = this.store.getKv("twitchUser");
    if (!raw) return "";
    try {
      return (JSON.parse(raw) as { id?: string }).id ?? "";
    } catch {
      return "";
    }
  }

  status(): LinkStatus {
    return {
      clientId: !!this.clientId(),
      linked: this.linked(),
      login: this.login(),
      pending: this.pending
        ? {
            userCode: this.pending.userCode,
            verificationUri: this.pending.verificationUri,
            expiresAt: this.pending.expiresAt,
          }
        : undefined,
      error: this.lastError || undefined,
      eventsubConnected: this.wsConnected,
    };
  }

  // --- Device-code login ------------------------------------------------------

  /** Start (or restart) the device flow. Returns the code to hand to the
      broadcaster, or throws with a human message. */
  async startLink(): Promise<NonNullable<LinkStatus["pending"]>> {
    const clientId = this.clientId();
    if (!clientId) throw new Error("Set a Twitch client id first.");
    this.lastError = "";
    const res = await fetch(`${ID_BASE}/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scopes: SCOPES }),
    });
    if (!res.ok) {
      throw new Error(
        `Twitch rejected the client id (HTTP ${res.status}) — check it on dev.twitch.tv.`,
      );
    }
    const body = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval?: number;
    };
    this.pending = {
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
      deviceCode: body.device_code,
    };
    this.pollForToken(clientId, body.device_code, (body.interval ?? 5) * 1000, Date.now() + body.expires_in * 1000);
    return { userCode: body.user_code, verificationUri: body.verification_uri, expiresAt: this.pending.expiresAt };
  }

  private pollForToken(clientId: string, deviceCode: string, intervalMs: number, deadline: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const poll = async () => {
      if (this.stopped || this.pending?.deviceCode !== deviceCode) return;
      if (Date.now() > deadline) {
        this.pending = undefined;
        this.lastError = "The link code expired before it was entered.";
        return;
      }
      try {
        const res = await fetch(`${ID_BASE}/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            scopes: SCOPES,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });
        const body = (await res.json()) as Record<string, unknown>;
        if (res.ok && typeof body.access_token === "string") {
          this.saveTokens({
            access: body.access_token,
            refresh: String(body.refresh_token ?? ""),
          });
          this.pending = undefined;
          await this.fetchUser();
          await this.refreshStreamKey();
          this.connectEventSub();
          this.onLinked();
          return;
        }
        // "authorization_pending" / "slow_down" → keep waiting.
      } catch {
        // transient — keep polling
      }
      this.pollTimer = setTimeout(poll, intervalMs);
      this.pollTimer.unref?.();
    };
    this.pollTimer = setTimeout(poll, intervalMs);
    this.pollTimer.unref?.();
  }

  async unlink(): Promise<void> {
    const t = this.tokens();
    if (t) {
      // Best-effort revoke; local state clears regardless.
      await fetch(`${ID_BASE}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.clientId(), token: t.access }),
      }).catch(() => {});
    }
    this.store.setKv("twitchTokens", "");
    this.store.setKv("twitchUser", "");
    this.store.setKv("twitchStreamKey", "");
    this.pending = undefined;
    this.closeWs();
  }

  // --- Stream key (channel:read:stream_key) ----------------------------------
  // The relay's RTMP push needs the key; with the link in place we fetch it
  // from Helix instead of making a human copy-paste it. Cached in kv so the
  // BRB supervisor gets an instant answer even if Helix is slow/down.

  cachedStreamKey(): string {
    return this.store.getKv("twitchStreamKey") ?? "";
  }

  async refreshStreamKey(): Promise<string> {
    const id = this.broadcasterId();
    if (!id) return this.cachedStreamKey();
    const data = await this.helix(`/streams/key?broadcaster_id=${id}`);
    const key = String(
      (data?.data as Array<Record<string, unknown>> | undefined)?.[0]?.stream_key ?? "",
    );
    if (key) this.store.setKv("twitchStreamKey", key);
    return key || this.cachedStreamKey();
  }

  // --- Tokens -----------------------------------------------------------------

  private tokens(): Tokens | null {
    const raw = this.store.getKv("twitchTokens");
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as Tokens;
      return t.access ? t : null;
    } catch {
      return null;
    }
  }

  private saveTokens(t: Tokens): void {
    this.store.setKv("twitchTokens", JSON.stringify(t));
    this.lastError = "";
  }

  private async fetchUser(): Promise<void> {
    const data = await this.helix("/users");
    const user = (data?.data as Array<Record<string, string>> | undefined)?.[0];
    if (user?.id) {
      this.store.setKv(
        "twitchUser",
        JSON.stringify({ id: user.id, login: user.login, name: user.display_name }),
      );
    }
  }

  private async validateOrRefresh(): Promise<boolean> {
    const t = this.tokens();
    if (!t) return false;
    const res = await fetch(`${ID_BASE}/validate`, {
      headers: { authorization: `OAuth ${t.access}` },
    }).catch(() => null);
    if (res?.ok) return true;
    return this.refresh();
  }

  private async refresh(): Promise<boolean> {
    const t = this.tokens();
    if (!t?.refresh) return false;
    try {
      const res = await fetch(`${ID_BASE}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId(),
          grant_type: "refresh_token",
          refresh_token: t.refresh,
        }),
      });
      if (!res.ok) throw new Error(`refresh ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.access_token !== "string") throw new Error("no token");
      this.saveTokens({
        access: body.access_token,
        refresh: String(body.refresh_token ?? t.refresh),
      });
      return true;
    } catch {
      // Refresh dead (password change, app revoked) — needs a re-link.
      this.lastError = "The Twitch link expired — link again.";
      this.store.setKv("twitchTokens", "");
      this.closeWs();
      return false;
    }
  }

  /** Helix GET with one automatic refresh-and-retry on 401. */
  async helix(path: string): Promise<Record<string, unknown> | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = this.tokens();
      if (!t) return null;
      const res = await fetch(`${HELIX}${path}`, {
        headers: {
          authorization: `Bearer ${t.access}`,
          "client-id": this.clientId(),
        },
      }).catch(() => null);
      if (!res) return null;
      if (res.status === 401 && attempt === 0) {
        if (!(await this.refresh())) return null;
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    }
    return null;
  }

  /** The channel's custom rewards (Helix; needs affiliate/partner). */
  async rewards(): Promise<Array<{ id: string; title: string; cost: number; enabled: boolean }>> {
    const id = this.broadcasterId();
    if (!id) return [];
    const data = await this.helix(`/channel_points/custom_rewards?broadcaster_id=${id}`);
    const list = (data?.data as Array<Record<string, unknown>> | undefined) ?? [];
    return list.map((r) => ({
      id: String(r.id ?? ""),
      title: String(r.title ?? ""),
      cost: Number(r.cost ?? 0),
      enabled: r.is_enabled !== false,
    }));
  }

  // --- EventSub over WebSocket ---------------------------------------------------

  private connectEventSub(url: string = EVENTSUB_WS): void {
    if (this.stopped) return;
    this.closeWs(false);
    void import("ws").then(({ WebSocket }) => {
      if (this.stopped || !this.tokens()) return;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on("message", (data: unknown) => {
        if (this.ws !== ws) return;
        this.onWsMessage(String(data));
      });
      ws.on("close", () => {
        if (this.ws !== ws) return;
        this.wsConnected = false;
        this.scheduleReconnect();
      });
      ws.on("error", () => {
        if (this.ws !== ws) return;
        this.wsConnected = false;
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(delayMs = 5_000): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.tokens()) this.connectEventSub();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private armKeepalive(seconds: number): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    // A silent EventSub socket is dead — Twitch promises a message at least
    // every keepalive interval.
    this.keepaliveTimer = setTimeout(() => {
      this.closeWs(false);
      this.scheduleReconnect(1_000);
    }, (seconds + 10) * 1000);
    this.keepaliveTimer.unref?.();
  }

  private onWsMessage(raw: string): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const type = msg?.metadata?.message_type;
    if (type === "session_welcome") {
      const session = msg.payload?.session;
      this.wsConnected = true;
      this.armKeepalive(Number(session?.keepalive_timeout_seconds ?? 10));
      void this.subscribeAll(String(session?.id ?? ""));
      return;
    }
    if (type === "session_keepalive") {
      this.armKeepalive(10);
      return;
    }
    if (type === "session_reconnect") {
      const url = msg.payload?.session?.reconnect_url;
      if (typeof url === "string" && url) this.connectEventSub(url);
      return;
    }
    if (type === "notification") {
      this.armKeepalive(10);
      this.onNotification(
        String(msg.payload?.subscription?.type ?? ""),
        (msg.payload?.event ?? {}) as Record<string, any>,
      );
    }
  }

  /** Exposed for tests: parse one EventSub notification into callbacks. */
  onNotification(subType: string, event: Record<string, any>): void {
    if (subType === "channel.channel_points_custom_reward_redemption.add") {
      this.onRedemption({
        rewardId: String(event.reward?.id ?? ""),
        rewardTitle: String(event.reward?.title ?? ""),
        user: String(event.user_name ?? event.user_login ?? "someone"),
        input: String(event.user_input ?? ""),
        cost: Number(event.reward?.cost ?? 0),
      });
      return;
    }
    if (subType === "channel.follow") {
      this.onFollow(String(event.user_name ?? event.user_login ?? "someone"));
    }
  }

  private async subscribeAll(sessionId: string): Promise<void> {
    if (!sessionId) return;
    const broadcaster = this.broadcasterId() || (await this.fetchUser(), this.broadcasterId());
    if (!broadcaster) {
      this.lastError = "Couldn't resolve the Twitch account.";
      return;
    }
    const subs = [
      {
        type: "channel.channel_points_custom_reward_redemption.add",
        version: "1",
        condition: { broadcaster_user_id: broadcaster },
      },
      {
        type: "channel.follow",
        version: "2",
        condition: { broadcaster_user_id: broadcaster, moderator_user_id: broadcaster },
      },
    ];
    for (const sub of subs) {
      const ok = await this.subscribe(sessionId, sub);
      if (!ok && sub.type !== "channel.follow") {
        // Rewards are the load-bearing subscription; surface its failure.
        this.lastError = "Twitch refused the rewards subscription — re-link may be needed.";
      }
    }
  }

  private async subscribe(
    sessionId: string,
    sub: { type: string; version: string; condition: Record<string, string> },
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = this.tokens();
      if (!t) return false;
      const res = await fetch(`${HELIX}/eventsub/subscriptions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${t.access}`,
          "client-id": this.clientId(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...sub, transport: { method: "websocket", session_id: sessionId } }),
      }).catch(() => null);
      if (!res) return false;
      if (res.status === 401 && attempt === 0) {
        if (!(await this.refresh())) return false;
        continue;
      }
      // 409 = already subscribed on this session — fine.
      return res.ok || res.status === 409;
    }
    return false;
  }

  private closeWs(clearConnected = true): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (clearConnected) this.wsConnected = false;
    try {
      ws?.close();
    } catch {}
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.closeWs();
  }
}
