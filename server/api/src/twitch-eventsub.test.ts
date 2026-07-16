// EventSub notification parsing + the sound-reward queue behavior.
//   node --test server/api/src/twitch-eventsub.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { TwitchLink, type Redemption } from "./twitch-eventsub.ts";
import { Store } from "./store.ts";
import { Session } from "./session.ts";

function makeLink(): TwitchLink {
  const store = new Store(mkdtempSync(`${tmpdir()}/esub-`));
  return new TwitchLink(store, "");
}

test("redemption notification parses reward id, title, user, input", () => {
  const link = makeLink();
  let got: Redemption | null = null;
  link.onRedemption = (r) => (got = r);
  link.onNotification("channel.channel_points_custom_reward_redemption.add", {
    user_name: "CashDevi",
    user_input: "hello chat",
    reward: { id: "abc-123", title: "TTS", cost: 500 },
  });
  assert.ok(got);
  assert.equal(got!.rewardId, "abc-123");
  assert.equal(got!.rewardTitle, "TTS");
  assert.equal(got!.user, "CashDevi");
  assert.equal(got!.input, "hello chat");
  assert.equal(got!.cost, 500);
  link.stop();
});

test("no-input redemption (sound-effect reward) still parses", () => {
  const link = makeLink();
  let got: Redemption | null = null;
  link.onRedemption = (r) => (got = r);
  link.onNotification("channel.channel_points_custom_reward_redemption.add", {
    user_login: "viewer1",
    reward: { id: "ping-1", title: "Discord Ping", cost: 100 },
  });
  assert.equal(got!.input, "");
  assert.equal(got!.rewardTitle, "Discord Ping");
  assert.equal(got!.user, "viewer1");
  link.stop();
});

test("follow notification parses; unknown types are ignored", () => {
  const link = makeLink();
  let follower = "";
  let redemptions = 0;
  link.onFollow = (u) => (follower = u);
  link.onRedemption = () => redemptions++;
  link.onNotification("channel.follow", { user_name: "NewFan" });
  link.onNotification("channel.ban", { user_name: "Troll" });
  assert.equal(follower, "NewFan");
  assert.equal(redemptions, 0);
  link.stop();
});

test("sound reward enqueues a playable item even with no text input", () => {
  const session = new Session("");
  session.publishAlert(
    {
      id: "r1",
      kind: "reward",
      user: "viewer1",
      detail: "Discord Ping",
      rewardId: "ping-1",
      at: new Date().toISOString(),
    },
    "",
    "/rewards/sound/ping-1?v=1",
  );
  const state = (session as unknown as { tts: { state(): { pending: number } } }).tts.state();
  assert.equal(state.pending, 1);
});

test("no-sound, no-text reward stays silent (screen only)", () => {
  const session = new Session("");
  session.publishAlert(
    {
      id: "r2",
      kind: "reward",
      user: "viewer1",
      detail: "Hydrate!",
      at: new Date().toISOString(),
    },
    "",
  );
  const state = (session as unknown as { tts: { state(): { pending: number } } }).tts.state();
  assert.equal(state.pending, 0);
});

test("follow alert shows but is not read (kinds.follow default off)", () => {
  const session = new Session("");
  session.publishAlert({
    id: "f1",
    kind: "follow",
    user: "NewFan",
    detail: "followed",
    at: new Date().toISOString(),
  });
  const state = (session as unknown as { tts: { state(): { pending: number } } }).tts.state();
  assert.equal(state.pending, 0);
});
