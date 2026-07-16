// The shared TTS queue — the "brain" of studio TTS. Devices are just mouths:
// the hub decides what's spoken next, and controls (mute/skip/clear) act on
// THIS state, which is why they work from any phone in the session.

import type { TtsItem, TtsQueueState, TtsSource } from "./protocol.ts";

/** Chat backlog cap — speech must never run minutes behind the stream. New
    lines drop when the queue is deep; donations/alerts always fit. */
const MAX_CHAT_PENDING = 12;

export class TtsQueue {
  private items: TtsItem[] = [];
  private current: TtsItem | null = null;
  private muted = false;
  private sources: Record<TtsSource, boolean> = {
    // Chat is OPT-IN: the voice now plays INSIDE the broadcast (Android
    // streaming phone mixes it digitally), and reading every chat line on
    // air is chaos. Rewards/bits/donations are the point; chat is a choice.
    chat: false,
    donation: true,
    alert: true,
  };
  /** Finer grain under the sources: which alert/donation KINDS are read.
      Set from the streamer's alert-widget toggles. */
  private kinds: Record<string, boolean> = {
    donation: true,
    bits: true,
    follow: false,
    sub: true,
    raid: true,
    reward: true, // channel point redemptions carry a message meant to be read
  };

  /** Returns true if the item was accepted (source + kind enabled, room in
      queue). Pass the alert kind (donation/bits/follow/sub/raid) when there
      is one — chat has none. */
  enqueue(item: TtsItem, kind?: string): boolean {
    if (!this.sources[item.source]) return false;
    if (kind && this.kinds[kind] === false) return false;
    if (
      item.source === "chat" &&
      this.items.filter((i) => i.source === "chat").length >= MAX_CHAT_PENDING
    ) {
      return false;
    }
    if (item.source === "chat") {
      this.items.push(item);
    } else {
      // Donations/alerts jump ahead of queued chat, but never ahead of each other.
      const firstChat = this.items.findIndex((i) => i.source === "chat");
      if (firstChat === -1) this.items.push(item);
      else this.items.splice(firstChat, 0, item);
    }
    return true;
  }

  /** Advance if idle. Returns the item to start speaking, or null. */
  next(): TtsItem | null {
    if (this.muted || this.current) return null;
    this.current = this.items.shift() ?? null;
    this.currentSince = this.current ? Date.now() : 0;
    return this.current;
  }

  private currentSince = 0;

  /** Take the in-flight item back (speaker died) without cancel semantics. */
  stealCurrent(): TtsItem | null {
    const item = this.current;
    this.current = null;
    return item;
  }

  /** A current item nobody finished — the silent-death watchdog's trigger. */
  staleCurrentId(olderThanMs: number): string | null {
    if (!this.current || this.currentSince === 0) return null;
    return Date.now() - this.currentSince > olderThanMs ? this.current.id : null;
  }

  /** The speaker finished (or failed) item `id`. */
  done(id: string): void {
    if (this.current?.id === id) this.current = null;
  }

  /** Put an item back at the head — e.g. no speaker device was connected. */
  requeueFront(item: TtsItem): void {
    if (this.current?.id === item.id) this.current = null;
    this.items.unshift(item);
  }

  /** Skip whatever is speaking now. Returns its id so the speaker can cancel. */
  skip(): string | null {
    const id = this.current?.id ?? null;
    this.current = null;
    return id;
  }

  /** Mute: stop the current utterance AND hold the queue. Unmute resumes. */
  setMuted(muted: boolean): string | null {
    this.muted = muted;
    return muted ? this.skip() : null;
  }

  clear(): string | null {
    this.items = [];
    return this.skip();
  }

  setSource(source: TtsSource, enabled: boolean): void {
    this.sources[source] = enabled;
    if (!enabled) this.items = this.items.filter((i) => i.source !== source);
  }

  setKinds(kinds: Record<string, boolean>): void {
    this.kinds = { ...this.kinds, ...kinds };
  }

  state(): TtsQueueState {
    return {
      muted: this.muted,
      current: this.current,
      pending: this.items.length,
      sources: { ...this.sources },
      kinds: { ...this.kinds },
    };
  }
}
