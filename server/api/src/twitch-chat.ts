// Server-side anonymous Twitch chat reader — IRC over WebSocket, one
// connection per session instead of one per phone. Port of the web client
// (apps/web/lib/twitch-chat.ts); reading a public channel needs no OAuth.
//
// Beyond chat, the same anonymous stream carries most alert-worthy events as
// IRCv3 tags — bits (PRIVMSG bits=), subs/gifts/raids (USERNOTICE), channel
// point redemptions (custom-reward-id). Those surface via onAlert. The one
// thing anonymous IRC can NOT see is follows — that needs EventSub + OAuth
// (studio phase 3).

import WebSocket from "ws";
import type { AlertKind, ChatEvent } from "./protocol.ts";

export type ChatListener = (event: ChatEvent) => void;
export type ChatStatusListener = (connected: boolean) => void;

export interface AlertInput {
  kind: AlertKind;
  user: string;
  detail?: string;
  /** Bits cheered (kind "bits") — feeds the min-bits-for-voice threshold. */
  amount?: number;
  /** The user-typed message alone (no "N bits:" prefix, no name) — what the
   *  voice reads by default. */
  message?: string;
}
export type AlertListener = (alert: AlertInput) => void;

const anonNick = () => `justinfan${10000 + Math.floor(Math.random() * 80000)}`;

export class TwitchChatReader {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff = 1000;
  private retryTimer: NodeJS.Timeout | null = null;
  private seq = 0;

  private channel: string;
  private onEvent: ChatListener;
  private onStatus: ChatStatusListener;
  private onAlert: AlertListener | null;

  // A community gift = one submysterygift + one subgift PER recipient. Alert
  // once ("is gifting 5 subs"), swallow the per-recipient echoes.
  private mysteryGifter = "";
  private mysteryUntil = 0;

  constructor(
    channel: string,
    onEvent: ChatListener,
    onStatus: ChatStatusListener,
    onAlert?: AlertListener,
  ) {
    this.channel = channel.replace(/^#/, "").trim().toLowerCase();
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onAlert = onAlert ?? null;
  }

  connect(): void {
    if (!this.channel) return;
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private open(): void {
    if (this.closed) return;
    const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    this.ws = ws;

    ws.on("open", () => {
      this.backoff = 1000;
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send(`NICK ${anonNick()}`);
      ws.send(`JOIN #${this.channel}`);
      this.onStatus(true);
    });

    ws.on("message", (data) => {
      for (const line of String(data).split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING")) {
          ws.send("PONG :tmi.twitch.tv");
          continue;
        }
        this.handleLine(line);
      }
    });

    ws.on("close", () => {
      this.onStatus(false);
      if (!this.closed) {
        this.retryTimer = setTimeout(() => this.open(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 15000);
      }
    });
    ws.on("error", () => ws.close());
  }

  private handleLine(line: string): void {
    const parsed = parseIrcLine(line);
    if (!parsed) return;
    if (parsed.chat) {
      this.onEvent({
        ...parsed.chat,
        id: `c${Date.now()}-${this.seq++}`,
        at: new Date().toISOString(),
      });
    }
    if (parsed.alert && this.onAlert) {
      const a = parsed.alert;
      const now = Date.now();
      if (a.mystery) {
        this.mysteryGifter = a.user.toLowerCase();
        this.mysteryUntil = now + 15_000;
      } else if (
        a.gift &&
        a.user.toLowerCase() === this.mysteryGifter &&
        now < this.mysteryUntil
      ) {
        return; // per-recipient echo of a community gift already announced
      }
      this.onAlert({ kind: a.kind, user: a.user, detail: a.detail });
    }
  }
}

interface ParsedAlert extends AlertInput {
  /** This alert announces a community gift (suppress its per-recipient echoes). */
  mystery?: boolean;
  /** This alert is a single sub gift (candidate echo of a community gift). */
  gift?: boolean;
}

export interface ParsedLine {
  chat?: Omit<ChatEvent, "id" | "at">;
  alert?: ParsedAlert;
}

/** Parse one IRC line into chat and/or alert content. Exported for tests. */
export function parseIrcLine(line: string): ParsedLine | null {
  let rest = line;
  let tags = "";
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    tags = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }

  const tagMap = new Map<string, string>();
  for (const pair of tags.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) tagMap.set(pair.slice(0, eq), pair.slice(eq + 1));
  }

  const msgStart = rest.indexOf(" :");
  const text = msgStart >= 0 ? rest.slice(msgStart + 2) : "";

  if (rest.includes("PRIVMSG")) {
    const bang = rest.indexOf("!");
    const nick = rest.startsWith(":") && bang > 0 ? rest.slice(1, bang) : "";
    const display = unescapeTag(tagMap.get("display-name") ?? "") || nick;
    if (!display || !text) return null;

    const out: ParsedLine = {
      chat: { user: display, color: tagMap.get("color") || null, text },
    };

    const bits = Number(tagMap.get("bits") ?? 0);
    if (bits > 0) {
      const message = stripCheermotes(text);
      out.alert = {
        kind: "bits",
        user: display,
        detail: `${bits} bits${message ? `: ${message}` : ""}`,
        amount: bits,
        message: message || undefined,
      };
    } else if (tagMap.get("custom-reward-id")) {
      out.alert = { kind: "reward", user: display, detail: text, message: text };
    }
    return out;
  }

  if (rest.includes("USERNOTICE")) {
    const display =
      unescapeTag(tagMap.get("display-name") ?? "") ||
      tagMap.get("login") ||
      "";
    if (!display) return null;
    const msgId = tagMap.get("msg-id") ?? "";

    switch (msgId) {
      case "sub":
      case "resub": {
        const months = Number(tagMap.get("msg-param-cumulative-months") ?? 0);
        const base = months > 1 ? `subscribed — ${months} months` : "subscribed";
        return {
          alert: {
            kind: "sub",
            user: display,
            detail: text ? `${base}: ${text}` : base,
            message: text || undefined,
          },
        };
      }
      case "subgift": {
        const to = unescapeTag(
          tagMap.get("msg-param-recipient-display-name") ?? "",
        );
        return {
          alert: {
            kind: "sub",
            user: display,
            detail: to ? `gifted a sub to ${to}` : "gifted a sub",
            gift: true,
          },
        };
      }
      case "submysterygift": {
        const count = Number(tagMap.get("msg-param-mass-gift-count") ?? 0);
        return {
          alert: {
            kind: "sub",
            user: display,
            detail: count > 1 ? `is gifting ${count} subs` : "is gifting a sub",
            mystery: true,
          },
        };
      }
      case "giftpaidupgrade":
      case "primepaidupgrade":
      case "anongiftpaidupgrade":
        return {
          alert: { kind: "sub", user: display, detail: "upgraded their sub" },
        };
      case "raid": {
        const viewers = Number(tagMap.get("msg-param-viewerCount") ?? 0);
        return {
          alert: {
            kind: "raid",
            user: display,
            detail:
              viewers > 0
                ? `is raiding with ${viewers} viewers`
                : "is raiding",
          },
        };
      }
      default:
        return null;
    }
  }

  return null;
}

/** Drop cheermote tokens (Cheer100, Pogchamp500…) so TTS reads the words. */
function stripCheermotes(text: string): string {
  return text
    .split(/\s+/)
    .filter((w) => !/^[A-Za-z]+\d+$/.test(w))
    .join(" ")
    .trim();
}

// IRCv3 tag values escape space/semicolon/backslash/CR/LF.
function unescapeTag(v: string): string {
  return v.replace(/\\(.)/g, (_, c: string) =>
    c === "s" ? " " : c === "n" ? "\n" : c === "r" ? "\r" : c === ":" ? ";" : c,
  );
}
