// @connected/protocol — canonical shapes that cross a boundary (client <-> server,
// streamer <-> companion). Change here, and every client + the server update
// together. Web uses these directly; native generates Dart/Rust bindings.

// ---------------------------------------------------------------------------
// Accounts & streaming identity
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  handle: string;
  createdAt: string; // ISO 8601
}

export interface StreamKey {
  /** Stable per-streamer ingest path, e.g. the "live" in /live/whip. */
  path: string;
  /** Secret publish token. Never log or expose in client bundles. */
  secret: string;
  ownerId: string;
}

// ---------------------------------------------------------------------------
// Telemetry (relay/client -> dashboard)
// ---------------------------------------------------------------------------

export type LinkState = "connecting" | "live" | "degraded" | "down";

export interface LinkSample {
  id: string; // "webrtc" in Phase 1; per-path id once bonding exists
  label: string;
  bitrateKbps: number;
  packetLoss: number; // 0..1
  rttMs: number;
  state: LinkState;
}

export interface TelemetrySample {
  at: string; // ISO 8601
  uptimeSec: number;
  resolution: string; // e.g. "1280x720"
  fps: number;
  outboundKbps: number; // aggregate to Twitch
  links: LinkSample[]; // one in Phase 1, several when bonded
  brbActive: boolean;
}

// ---------------------------------------------------------------------------
// Control (dashboard/client -> relay)
// ---------------------------------------------------------------------------

export type ControlMessage =
  | { type: "start"; config: { width: number; height: number; fps: number; codec: "h264" | "hevc" } }
  | { type: "stop" }
  | { type: "setBitrateCeiling"; kbps: number }
  | { type: "setSimulcastTargets"; targets: SimulcastTarget[] }
  | { type: "forceBrb"; on: boolean };

export interface SimulcastTarget {
  platform: "twitch" | "youtube" | "kick";
  rtmpUrl: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Studio session hub (see docs/STUDIO.md) — the event bus every studio
// feature rides: chat, alerts, donations, mediashare, TTS. One websocket,
// JSON messages, these exact shapes on the wire.
// ---------------------------------------------------------------------------

/** What a device in the session is FOR. One account/session, many devices. */
export type DeviceRole =
  | "streamer" // the camera phone — clean, minimal chrome
  | "studio" // companion screen: chat + alerts + mediashare queue
  | "tts"; // the phone that speaks (never the camera phone)

/** What an invited team member may do. The OWNER (session-code holder) has
    everything and is the only one who can hold the streamer role — invited
    members can never go live. `program`: watch the live feed; `tts`: be the
    speaker + drive the shared queue. */
export interface MemberPerms {
  chat: boolean;
  program: boolean;
  alerts: boolean;
  tts: boolean;
}

export interface SessionMember {
  id: string;
  name: string; // human label, e.g. "iPhone 16 Pro Max"
  role: DeviceRole;
  joinedAt: string; // ISO 8601
}

export interface ChatEvent {
  id: string;
  user: string;
  /** Twitch name color (hex) if set, else null. */
  color: string | null;
  text: string;
  at: string; // ISO 8601
}

export interface DonationEvent {
  id: string;
  donor: string;
  amountCents: number;
  currency: string; // ISO 4217, e.g. "usd"
  message: string;
  /** Mediashare attachment (YouTube URL), if the donor added one. */
  mediaUrl?: string;
  at: string;
}

export type AlertKind = "follow" | "sub" | "raid" | "bits" | "reward";

export interface AlertEvent {
  id: string;
  kind: AlertKind;
  user: string;
  /** Kind-specific detail: months resubbed, raid size, bits amount… */
  detail?: string;
  /** Numeric size when the kind has one (bits cheered). Drives the owner's
      minimum-bits-for-voice threshold. */
  amount?: number;
  /** Channel-point reward id (EventSub path) — keys the owner's per-reward
      sound-effect mapping. */
  rewardId?: string;
  at: string;
}

/** What TTS speaks, and why. Donations outrank chat in the queue. */
export type TtsSource = "chat" | "donation" | "alert";

export interface TtsItem {
  id: string;
  text: string;
  /** Spoken as "<sayUser> says …" when present. */
  sayUser?: string;
  source: TtsSource;
  /** Hub-relative audio URL. When present the voice device PLAYS this file
      (into the broadcast on the streaming phone) instead of speaking `text` —
      the sound-effect reward path. */
  soundUrl?: string;
}

/** The shared queue state every device sees — controls act on THIS, so
    "skip" works from any phone in the session. */
export interface TtsQueueState {
  muted: boolean;
  current: TtsItem | null;
  pending: number;
  /** Per-source enablement (e.g. chat TTS off, donations always on). */
  sources: Record<TtsSource, boolean>;
  /** Finer grain for alerts/donations: which KINDS get read (donation,
      bits, follow, sub, raid) — set from the alert widget's toggles. */
  kinds: Record<string, boolean>;
}

/** Client → hub. Join with the session code (the owner's rig) OR an invited
    member's token — exactly one of the two. */
export type HubClientMessage =
  | { type: "join"; code?: string; token?: string; role: DeviceRole; name: string }
  | { type: "role"; role: DeviceRole }
  | { type: "chat.channel"; channel: string }
  | { type: "tts.mute"; muted: boolean }
  | { type: "tts.skip" }
  | { type: "tts.clear" }
  | { type: "tts.source"; source: TtsSource; enabled: boolean }
  /** Per-kind read-aloud map from the alert widget's toggles. */
  | { type: "tts.kinds"; kinds: Record<string, boolean> }
  /** From the tts device: finished (or failed) speaking item `id`. */
  | { type: "tts.done"; id: string }
  /** A device volunteering (or resigning) as the session's voice, without
      changing its role. The hub hands each item to exactly ONE speaker. */
  | { type: "tts.here"; enabled: boolean }
  /** Mediashare moderation (owner or tts-perm members). */
  | { type: "media.approve"; id: string }
  | { type: "media.deny"; id: string }
  | { type: "media.played"; id: string };

/** A queued mediashare request (donation-attached video). It waits for
    approval on the studio before anyone plays it. */
export interface MediaShareItem {
  id: string;
  donor: string;
  amountCents: number;
  currency: string;
  url: string;
  status: "pending" | "approved" | "played" | "denied";
  at: string;
}

/** Hub → client. */
export type HubServerMessage =
  | {
      type: "welcome";
      self: SessionMember;
      members: SessionMember[];
      tts: TtsQueueState;
      channel: string;
      /** What THIS connection may see/do. Owner devices get all-true. */
      perms: MemberPerms;
      owner: boolean;
    }
  | { type: "relay.status"; live: boolean; readers: number }
  | { type: "media.queue"; items: MediaShareItem[] }
  | { type: "members"; members: SessionMember[] }
  | { type: "chat"; event: ChatEvent }
  | { type: "chat.status"; connected: boolean; channel: string }
  /** Rolling backlog, replayed on every (re)join so a device's own network
      blip never leaves a hole in chat. Clients merge by event id. */
  | { type: "chat.history"; events: ChatEvent[] }
  | { type: "donation"; event: DonationEvent }
  | { type: "alert"; event: AlertEvent }
  /** Same replay for the notifications feed (donations + alerts). */
  | {
      type: "feed.history";
      items: (
        | { kind: "donation"; event: DonationEvent }
        | { kind: "alert"; event: AlertEvent }
      )[];
    }
  | { type: "tts.state"; state: TtsQueueState }
  /** To tts-role devices only: speak this now. Report back with tts.done. */
  | { type: "tts.speak"; item: TtsItem }
  /** Stop speaking `id` immediately (skip pressed somewhere). */
  | { type: "tts.cancel"; id: string }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Guest bonding (Phase 3): a nearby phone lends its connection
// ---------------------------------------------------------------------------

export interface GuestToken {
  token: string; // short-lived
  streamerPath: string;
  /** Local rendezvous hint (streamer's LAN address/QR payload). */
  rendezvous: string;
  expiresAt: string; // ISO 8601
}
