// A streaming session: the devices in the rig, the shared TTS queue, the
// mediashare queue, and the event fan-out — now permission-aware.
//
// Auth model (docs/STUDIO.md): the SESSION CODE is the owner's rig — his own
// phones, full power, and the ONLY identity that can hold the streamer role.
// Invited team members join with a personal token and get exactly the
// permissions the owner granted (chat / program / alerts / tts). Fan-out is
// filtered per member: no chat perm, no chat events — enforced here, not
// hidden in the UI.

import type { WebSocket } from "ws";
import type {
  AlertEvent,
  ChatEvent,
  DeviceRole,
  DonationEvent,
  HubClientMessage,
  HubServerMessage,
  MediaShareItem,
  MemberPerms,
  SessionMember,
  TtsItem,
  TtsSource,
} from "./protocol.ts";
import { TtsQueue } from "./tts-queue.ts";
import { TwitchChatReader } from "./twitch-chat.ts";

export const OWNER_PERMS: MemberPerms = {
  chat: true,
  program: true,
  alerts: true,
  tts: true,
};

export interface JoinAuth {
  owner: boolean;
  perms: MemberPerms;
  /** Team-member id (for last-seen bookkeeping), absent for owner devices. */
  memberId?: string;
}

interface Connection {
  member: SessionMember;
  auth: JoinAuth;
  /** Volunteered as the session's voice (tts.here) — role-independent. */
  speaker?: boolean;
  /** When it volunteered — the STREAMER's rejoins must reclaim the voice
   *  from any web tab (field bug: a network blip re-joined the phone at the
   *  back of the map and the mouth silently migrated). */
  speakerAt?: number;
}

// Keep spoken chat sane: drop URLs, collapse spam, cap length (mirror of the
// web sanitizer — the hub is authoritative for what enters the queue).
function sanitizeForTts(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/(.)\1{4,}/g, "$1$1$1")
    .slice(0, 200)
    .trim();
}

const MAX_MEDIA_ITEMS = 20;
// Replayed on every (re)join: a guest's own connection blip must never leave
// a hole in their chat or notifications (they merge by event id).
const MAX_CHAT_HISTORY = 100;
const MAX_FEED_HISTORY = 50;

export class Session {
  private conns = new Map<WebSocket, Connection>();
  private tts = new TtsQueue();
  private chat: TwitchChatReader | null = null;
  private chatConnected = false;
  private channel = "";
  private seq = 0;
  private media: MediaShareItem[] = [];
  private relay: { live: boolean; readers: number } = { live: false, readers: 0 };
  private chatHistory: ChatEvent[] = [];
  private feedHistory: (
    | { kind: "donation"; event: DonationEvent }
    | { kind: "alert"; event: AlertEvent }
  )[] = [];

  constructor(initialChannel: string) {
    if (initialChannel) this.setChannel(initialChannel);
    // Silent-death watchdog: clients have their own safety timeouts, but a
    // connection that dies WITH the item (field bug: phone rejoined, item
    // lost) leaves current stuck forever — nothing else unsticks it.
    setInterval(() => {
      const stale = this.tts.staleCurrentId(30_000);
      if (stale) {
        this.tts.done(stale);
        this.pump();
        this.broadcastTts();
      }
    }, 10_000).unref?.();
  }

  join(ws: WebSocket, role: DeviceRole, name: string, auth: JoinAuth): void {
    const member: SessionMember = {
      id: `m${Date.now().toString(36)}-${this.seq++}`,
      name: name.slice(0, 60) || role,
      role: this.allowedRole(role, auth),
      joinedAt: new Date().toISOString(),
    };
    this.conns.set(ws, { member, auth });
    this.send(ws, {
      type: "welcome",
      self: member,
      members: [...this.conns.values()].map((c) => c.member),
      tts: this.tts.state(),
      channel: this.channel,
      perms: auth.perms,
      owner: auth.owner,
    });
    this.send(ws, {
      type: "chat.status",
      connected: this.chatConnected,
      channel: this.channel,
    });
    this.send(ws, { type: "relay.status", ...this.relay });
    if (auth.perms.chat && this.chatHistory.length) {
      this.send(ws, { type: "chat.history", events: this.chatHistory });
    }
    if (auth.perms.alerts) {
      this.send(ws, { type: "media.queue", items: this.media });
      if (this.feedHistory.length) {
        this.send(ws, { type: "feed.history", items: this.feedHistory });
      }
    }
    this.broadcastMembers();
    if (member.role === "tts") this.pump();
  }

  leave(ws: WebSocket): void {
    const conn = this.conns.get(ws);
    if (!this.conns.delete(ws)) return;
    // A dying speaker must not take the queue with it: the in-flight item
    // goes back to the front and the next voice picks it up.
    if (conn && (conn.speaker || conn.member.role === "tts")) {
      const stolen = this.tts.stealCurrent();
      if (stolen) {
        this.tts.requeueFront(stolen);
        this.pump();
        this.broadcastTts();
      }
    }
    this.broadcastMembers();
  }

  /** The streamer role is the owner's alone; the tts role needs the perm. */
  private allowedRole(requested: DeviceRole, auth: JoinAuth): DeviceRole {
    if (requested === "streamer" && !auth.owner) return "studio";
    if (requested === "tts" && !auth.owner && !auth.perms.tts) return "studio";
    return requested;
  }

  handle(ws: WebSocket, msg: HubClientMessage): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    const { member, auth } = conn;
    const canDriveTts = auth.owner || auth.perms.tts;
    const canModerate = auth.owner || auth.perms.alerts;

    switch (msg.type) {
      case "role": {
        member.role = this.allowedRole(msg.role, auth);
        this.broadcastMembers();
        if (member.role === "tts") this.pump();
        break;
      }
      case "chat.channel": {
        if (auth.owner) this.setChannel(msg.channel);
        break;
      }
      case "tts.mute": {
        if (!canDriveTts) break;
        const cancelled = this.tts.setMuted(msg.muted);
        if (cancelled) this.toSpeakers({ type: "tts.cancel", id: cancelled });
        this.broadcastTts();
        if (!msg.muted) this.pump();
        break;
      }
      case "tts.skip": {
        if (!canDriveTts) break;
        const cancelled = this.tts.skip();
        if (cancelled) this.toSpeakers({ type: "tts.cancel", id: cancelled });
        this.pump();
        this.broadcastTts(); // even when the queue emptied — state must not go stale
        break;
      }
      case "tts.clear": {
        if (!canDriveTts) break;
        const cancelled = this.tts.clear();
        if (cancelled) this.toSpeakers({ type: "tts.cancel", id: cancelled });
        this.broadcastTts();
        break;
      }
      case "tts.source": {
        if (!canDriveTts) break;
        this.tts.setSource(msg.source, msg.enabled);
        this.broadcastTts();
        break;
      }
      case "tts.kinds": {
        if (!auth.owner) break; // the widget toggles are the owner's layout
        this.tts.setKinds(msg.kinds);
        this.broadcastTts();
        break;
      }
      case "tts.done": {
        this.tts.done(msg.id);
        this.pump();
        this.broadcastTts();
        break;
      }
      case "tts.here": {
        if (!canDriveTts) break;
        conn.speaker = msg.enabled;
        conn.speakerAt = msg.enabled ? Date.now() : undefined;
        if (msg.enabled) this.pump();
        break;
      }
      case "media.approve":
      case "media.deny":
      case "media.played": {
        if (!canModerate) break;
        const item = this.media.find((m) => m.id === msg.id);
        if (!item) break;
        item.status =
          msg.type === "media.approve"
            ? "approved"
            : msg.type === "media.deny"
              ? "denied"
              : "played";
        this.broadcastMedia();
        break;
      }
      case "join":
        break; // already joined; ignore
    }
  }

  // --- External inputs ---------------------------------------------------------

  /** Donations/alerts enter here (Stripe webhook, EventSub). */
  publishDonation(event: DonationEvent): void {
    this.feedHistory = [{ kind: "donation" as const, event }, ...this.feedHistory]
      .slice(0, MAX_FEED_HISTORY);
    this.broadcast({ type: "donation", event }, (c) => c.auth.perms.alerts);
    if (event.mediaUrl) {
      const item: MediaShareItem = {
        id: `ms-${event.id}`,
        donor: event.donor,
        amountCents: event.amountCents,
        currency: event.currency,
        url: event.mediaUrl,
        status: "pending",
        at: event.at,
      };
      this.media = [item, ...this.media].slice(0, MAX_MEDIA_ITEMS);
      this.broadcastMedia();
    }
    this.enqueueTts(
      {
        id: `t-${event.id}`,
        text: sanitizeForTts(event.message) || "made a donation",
        sayUser: this.ttsSayNames() ? event.donor : undefined,
        source: "donation",
      },
      "donation",
    );
  }

  /** Owner-set floor: cheers below this many bits still SHOW, just aren't
      read aloud. Injected by main.ts (backed by the kv store). */
  ttsMinBits: () => number = () => 1;

  /** Owner setting applied from persistence (kv) and the settings UI. */
  setTtsSource(source: TtsSource, enabled: boolean): void {
    this.tts.setSource(source, enabled);
    this.broadcastTts();
  }

  /** Speak the sender's name before the message? Off by default — the voice
   *  is on the broadcast; the message is the content, the name is noise. */
  ttsSayNames: () => boolean = () => false;

  /** When the Twitch EventSub link is live it sees EVERY redemption (with
   *  reward ids and titles) — the IRC reward parse would double-fire the
   *  text-bearing ones, so it stands down. Injected by main.ts. */
  suppressIrcRewards: () => boolean = () => false;

  /** speech = what the voice reads (the user's message alone, by default);
   *  event.detail stays the richer ON-SCREEN line. soundUrl = a mapped
   *  sound-effect file; when present the voice device PLAYS it (into the
   *  broadcast) instead of speaking. */
  publishAlert(event: AlertEvent, speech?: string, soundUrl?: string): void {
    this.feedHistory = [{ kind: "alert" as const, event }, ...this.feedHistory]
      .slice(0, MAX_FEED_HISTORY);
    this.broadcast({ type: "alert", event }, (c) => c.auth.perms.alerts);
    if (event.kind === "bits" && (event.amount ?? 0) < this.ttsMinBits()) {
      return;
    }
    if (soundUrl) {
      // The sound IS the payload — text is only the on-screen/fallback label
      // (an old speaker that predates soundUrl reads it instead of playing).
      this.enqueueTts(
        {
          id: `t-${event.id}`,
          text: sanitizeForTts(speech || event.detail || event.kind),
          source: "alert",
          soundUrl,
        },
        event.kind,
      );
      return;
    }
    // Bits/rewards exist to be READ — but a bare cheer has no message; the
    // alert shows on screen and the voice stays quiet.
    const text =
      speech ??
      (event.kind === "bits" || event.kind === "reward"
        ? ""
        : event.detail ?? event.kind);
    if (!text) return;
    this.enqueueTts(
      {
        id: `t-${event.id}`,
        text: sanitizeForTts(text),
        sayUser: this.ttsSayNames() ? event.user : undefined,
        source: "alert",
      },
      event.kind,
    );
  }

  /** Adopt `channel` only when none was ever configured — the Twitch link
   *  derives it from the login so a fresh box needs zero chat setup. */
  ensureChannel(channel: string): void {
    if (!this.channel) this.setChannel(channel);
  }

  setRelayStatus(live: boolean, readers: number): void {
    if (this.relay.live === live && this.relay.readers === readers) return;
    this.relay = { live, readers };
    this.broadcast({ type: "relay.status", live, readers });
  }

  // --- Internals -----------------------------------------------------------------

  private setChannel(channel: string): void {
    const clean = channel.replace(/^#/, "").trim().toLowerCase();
    if (clean === this.channel) return;
    this.chat?.close();
    this.chatConnected = false;
    this.channel = clean;
    if (!clean) {
      this.broadcast({ type: "chat.status", connected: false, channel: "" });
      return;
    }
    this.chat = new TwitchChatReader(
      clean,
      (event) => this.onChat(event),
      (connected) => {
        this.chatConnected = connected;
        this.broadcast({ type: "chat.status", connected, channel: this.channel });
      },
      // Bits, subs/gifts, raids, channel-point rewards — parsed off the same
      // anonymous IRC stream. (Follows can't ride IRC — they need the
      // EventSub link; rewards defer to EventSub when it's connected.)
      (alert) => {
        if (alert.kind === "reward" && this.suppressIrcRewards()) return;
        this.publishAlert(
          {
            id: `a${Date.now().toString(36)}-${this.seq++}`,
            kind: alert.kind,
            user: alert.user,
            detail: alert.detail,
            amount: alert.amount,
            at: new Date().toISOString(),
          },
          alert.message,
        );
      },
    );
    this.chat.connect();
  }

  private onChat(event: ChatEvent): void {
    this.chatHistory =
      this.chatHistory.length >= MAX_CHAT_HISTORY
        ? [...this.chatHistory.slice(1), event]
        : [...this.chatHistory, event];
    this.broadcast({ type: "chat", event }, (c) => c.auth.perms.chat);
    this.enqueueTts({
      id: `t-${event.id}`,
      text: sanitizeForTts(event.text),
      sayUser: this.ttsSayNames() ? event.user : undefined,
      source: "chat",
    });
  }

  private enqueueTts(item: TtsItem, kind?: string): void {
    if (!item.text) return;
    if (this.tts.enqueue(item, kind)) {
      this.broadcastTts();
      this.pump();
    }
  }

  /** Advance the queue if idle and hand the next item to the speaker(s). */
  private pump(): void {
    const item = this.tts.next();
    if (!item) return;
    if (!this.toSpeakers({ type: "tts.speak", item })) {
      // Nobody to speak it — put it back at the front and wait for a speaker.
      this.tts.requeueFront(item);
      return;
    }
    this.broadcastTts();
  }

  private broadcastMembers(): void {
    this.broadcast({
      type: "members",
      members: [...this.conns.values()].map((c) => c.member),
    });
  }

  private broadcastTts(): void {
    this.broadcast({ type: "tts.state", state: this.tts.state() });
  }

  private broadcastMedia(): void {
    this.broadcast({ type: "media.queue", items: this.media }, (c) => c.auth.perms.alerts);
  }

  private broadcast(
    msg: HubServerMessage,
    filter?: (c: Connection) => boolean,
  ): void {
    const raw = JSON.stringify(msg);
    for (const [ws, conn] of this.conns) {
      if (filter && !filter(conn)) continue;
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  }

  /** Hand the item to exactly ONE voice device — with speakers on by
      default everywhere, sending to all would echo. Priority: the STREAMER's
      device (the broadcast voice is king), then the most recent volunteer,
      then legacy tts-role devices. */
  private toSpeakers(msg: HubServerMessage): boolean {
    const raw = JSON.stringify(msg);
    let best: WebSocket | null = null;
    let bestScore = -1;
    for (const [ws, conn] of this.conns) {
      if (ws.readyState !== ws.OPEN) continue;
      let score = -1;
      if (conn.speaker) {
        score =
          conn.member.role === "streamer"
            ? Number.MAX_SAFE_INTEGER
            : conn.speakerAt ?? 1;
      } else if (conn.member.role === "tts") {
        score = 0;
      }
      if (score > bestScore) {
        bestScore = score;
        best = ws;
      }
    }
    if (!best) return false;
    best.send(raw);
    return true;
  }

  private send(ws: WebSocket, msg: HubServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
