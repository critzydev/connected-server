// Owner account + guest code — the identity layer (docs/ONBOARDING.md).
//
// The relay is the account home: the FIRST connect claims it (create the main
// account), after which the owner logs in with username+password and guests
// need the owner-rotatable GUEST CODE — the VPS link alone gets you nothing.
// Passwords are scrypt-hashed; owner tokens are per-device bearer secrets.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { MemberPerms } from "./protocol.ts";
import type { Store } from "./store.ts";

const KV_ACCOUNT = "account"; // { username, salt, hash }
const KV_OWNER_TOKENS = "ownerTokens"; // string[]
const KV_GUEST_CODE = "guestCode"; // string
const KV_GUEST_DEFAULTS = "guestDefaults"; // MemberPerms

// What a fresh guest code grants: the full SPECTATOR experience — watch,
// read chat, see donations/follows (they're public on stream anyway). Only
// controls that act on the rig (tts) stay opt-in. Owner-tunable at /team.
export const DEFAULT_GUEST_PERMS: MemberPerms = {
  chat: true,
  program: true,
  alerts: true,
  tts: false,
};

interface AccountRecord {
  username: string;
  salt: string;
  hash: string;
}

export class Auth {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  // --- Claim & login -----------------------------------------------------------

  claimed(): boolean {
    return this.store.getKv(KV_ACCOUNT) !== null;
  }

  ownerUsername(): string | null {
    const raw = this.store.getKv(KV_ACCOUNT);
    return raw ? (JSON.parse(raw) as AccountRecord).username : null;
  }

  /** First connect claims the relay. Returns an owner token, or null if
      already claimed. */
  claim(username: string, password: string): string | null {
    if (this.claimed()) return null;
    const clean = username.trim().slice(0, 40);
    if (!clean || password.length < 6) return null;
    const salt = randomBytes(16).toString("hex");
    const record: AccountRecord = {
      username: clean,
      salt,
      hash: hashPassword(password, salt),
    };
    this.store.setKv(KV_ACCOUNT, JSON.stringify(record));
    // A fresh relay gets a guest code immediately so the owner can hand it out.
    this.rotateGuestCode();
    return this.issueOwnerToken();
  }

  /** Username+password → a fresh owner token (one per device). */
  login(username: string, password: string): string | null {
    const raw = this.store.getKv(KV_ACCOUNT);
    if (!raw) return null;
    const record = JSON.parse(raw) as AccountRecord;
    if (record.username.toLowerCase() !== username.trim().toLowerCase()) return null;
    const attempt = Buffer.from(hashPassword(password, record.salt), "hex");
    const good = Buffer.from(record.hash, "hex");
    if (attempt.length !== good.length || !timingSafeEqual(attempt, good)) {
      return null;
    }
    return this.issueOwnerToken();
  }

  isOwnerToken(token: string | undefined): boolean {
    if (!token) return false;
    return this.ownerTokens().includes(token);
  }

  private issueOwnerToken(): string {
    const token = `own-${randomBytes(20).toString("hex")}`;
    const tokens = this.ownerTokens();
    tokens.push(token);
    this.store.setKv(KV_OWNER_TOKENS, JSON.stringify(tokens.slice(-20)));
    return token;
  }

  private ownerTokens(): string[] {
    const raw = this.store.getKv(KV_OWNER_TOKENS);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  // --- Guest code + defaults ----------------------------------------------------

  guestCode(): string | null {
    return this.store.getKv(KV_GUEST_CODE);
  }

  /** Set a specific code, or rotate to a random one. Rotating instantly
      invalidates the old code for NEW joins (existing guests keep tokens —
      remove them from the crew page). */
  rotateGuestCode(code?: string): string {
    const next =
      code?.trim().slice(0, 40) ||
      randomBytes(4).toString("hex"); // 8 chars, easy to read out loud
    this.store.setKv(KV_GUEST_CODE, next);
    return next;
  }

  guestDefaults(): MemberPerms {
    const raw = this.store.getKv(KV_GUEST_DEFAULTS);
    return raw
      ? { ...DEFAULT_GUEST_PERMS, ...(JSON.parse(raw) as Partial<MemberPerms>) }
      : { ...DEFAULT_GUEST_PERMS };
  }

  setGuestDefaults(perms: Partial<MemberPerms>): MemberPerms {
    const next = { ...this.guestDefaults(), ...perms };
    this.store.setKv(KV_GUEST_DEFAULTS, JSON.stringify(next));
    return next;
  }
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}
