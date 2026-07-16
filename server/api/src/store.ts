// Persistence — Node's built-in SQLite, zero dependencies. One file under
// DATA_DIR holds the team (members + invites) and small kv state (the overlay
// layout). The hub was deliberately stateless until accounts needed a disk.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { MemberPerms } from "./protocol.ts";

export interface TeamMember {
  id: string;
  name: string;
  token: string;
  perms: MemberPerms;
  shareBandwidth: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface TeamInvite {
  code: string;
  name: string | null;
  perms: MemberPerms;
  createdAt: string;
}

const DEFAULT_PERMS: MemberPerms = {
  chat: true,
  program: true,
  alerts: true,
  tts: false,
};

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(`${dataDir}/hub.db`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        perms TEXT NOT NULL,
        share_bandwidth INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY,
        name TEXT,
        perms TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // --- Invites ---------------------------------------------------------------

  createInvite(perms: Partial<MemberPerms>, name?: string): TeamInvite {
    const invite: TeamInvite = {
      code: randomBytes(5).toString("hex"), // 10 chars, enough for a hand-out link
      name: name?.slice(0, 60) || null,
      perms: { ...DEFAULT_PERMS, ...perms },
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO invites (code, name, perms, created_at) VALUES (?, ?, ?, ?)")
      .run(invite.code, invite.name, JSON.stringify(invite.perms), invite.createdAt);
    return invite;
  }

  /** One-time claim: the invite becomes a member with a fresh token. */
  claimInvite(code: string, name: string): TeamMember | null {
    const row = this.db
      .prepare("SELECT code, name, perms FROM invites WHERE code = ?")
      .get(code) as { code: string; name: string | null; perms: string } | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM invites WHERE code = ?").run(code);
    const member: TeamMember = {
      id: `mem-${randomBytes(4).toString("hex")}`,
      name: (name || row.name || "Team member").slice(0, 60),
      token: randomBytes(16).toString("hex"),
      perms: JSON.parse(row.perms) as MemberPerms,
      shareBandwidth: false,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO members (id, name, token, perms, share_bandwidth, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, NULL)",
      )
      .run(member.id, member.name, member.token, JSON.stringify(member.perms), member.createdAt);
    return member;
  }

  /** Direct member creation — the guest-code path (no invite row). */
  createDirectMember(name: string, perms: MemberPerms): TeamMember {
    const member: TeamMember = {
      id: `mem-${randomBytes(4).toString("hex")}`,
      name: (name || "Guest").slice(0, 60),
      token: randomBytes(16).toString("hex"),
      perms,
      shareBandwidth: false,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO members (id, name, token, perms, share_bandwidth, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, NULL)",
      )
      .run(member.id, member.name, member.token, JSON.stringify(member.perms), member.createdAt);
    return member;
  }

  deleteInvite(code: string): void {
    this.db.prepare("DELETE FROM invites WHERE code = ?").run(code);
  }

  listInvites(): TeamInvite[] {
    const rows = this.db
      .prepare("SELECT code, name, perms, created_at FROM invites ORDER BY created_at")
      .all() as { code: string; name: string | null; perms: string; created_at: string }[];
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      perms: JSON.parse(r.perms) as MemberPerms,
      createdAt: r.created_at,
    }));
  }

  // --- Members ---------------------------------------------------------------

  memberByToken(token: string): TeamMember | null {
    if (!token) return null;
    const r = this.db
      .prepare("SELECT * FROM members WHERE token = ?")
      .get(token) as MemberRow | undefined;
    return r ? rowToMember(r) : null;
  }

  listMembers(): TeamMember[] {
    const rows = this.db
      .prepare("SELECT * FROM members ORDER BY created_at")
      .all() as unknown as MemberRow[];
    return rows.map(rowToMember);
  }

  touchMember(id: string): void {
    this.db
      .prepare("UPDATE members SET last_seen_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  setMemberPerms(id: string, perms: MemberPerms): boolean {
    const res = this.db
      .prepare("UPDATE members SET perms = ? WHERE id = ?")
      .run(JSON.stringify(perms), id);
    return res.changes > 0;
  }

  setMemberShare(token: string, share: boolean): boolean {
    const res = this.db
      .prepare("UPDATE members SET share_bandwidth = ? WHERE token = ?")
      .run(share ? 1 : 0, token);
    return res.changes > 0;
  }

  removeMember(id: string): void {
    this.db.prepare("DELETE FROM members WHERE id = ?").run(id);
  }

  // --- KV (overlay layout, small state) ---------------------------------------

  getKv(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
}

interface MemberRow {
  id: string;
  name: string;
  token: string;
  perms: string;
  share_bandwidth: number;
  created_at: string;
  last_seen_at: string | null;
}

function rowToMember(r: MemberRow): TeamMember {
  return {
    id: r.id,
    name: r.name,
    token: r.token,
    perms: JSON.parse(r.perms) as MemberPerms,
    shareBandwidth: r.share_bandwidth === 1,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}
