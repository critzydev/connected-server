// /stream/key is the RTMP credential — prove the guard: loopback-only unless
// proxied (a reverse proxy always stamps x-forwarded-for), owner auth as the
// explicit override.
//   node --test server/api/src/stream-key.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Store } from "./store.ts";

const DIR = mkdtempSync(`${tmpdir()}/key-`);
const PORT = 18791;
const BASE = `http://127.0.0.1:${PORT}`;

before(async () => {
  process.env.DATA_DIR = DIR;
  process.env.PORT = String(PORT);
  process.env.SESSION_CODE = "keytest";
  process.env.TWITCH_CHANNEL = "";
  await import("./main.ts");
  await new Promise((r) => setTimeout(r, 300));
});

// main.ts keeps the event loop alive (listening server + poll intervals) —
// results are flushed by now; end the subprocess so the runner isn't held.
after(() => {
  setTimeout(() => process.exit(0), 200);
});

test("no key stored -> 404 (still not a leak)", async () => {
  const res = await fetch(`${BASE}/stream/key`);
  assert.equal(res.status, 404);
});

test("loopback without a proxy header reads the key", async () => {
  new Store(DIR).setKv("twitchStreamKey", "live_secret_abc");
  const res = await fetch(`${BASE}/stream/key`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "live_secret_abc");
});

test("proxied requests are denied even from loopback", async () => {
  const res = await fetch(`${BASE}/stream/key`, {
    headers: { "x-forwarded-for": "203.0.113.9" },
  });
  assert.equal(res.status, 401);
});

test("owner auth overrides the proxy denial", async () => {
  const res = await fetch(`${BASE}/stream/key`, {
    headers: { "x-forwarded-for": "203.0.113.9", "x-session-code": "keytest" },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "live_secret_abc");
});
