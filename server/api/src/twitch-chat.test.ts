// Parser-level tests against real-shaped Twitch IRC lines.
//   node --test server/api/src/twitch-chat.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIrcLine } from "./twitch-chat.ts";

test("plain chat message", () => {
  const p = parseIrcLine(
    "@badge-info=;color=#FF0000;display-name=Viewer1 :viewer1!viewer1@viewer1.tmi.twitch.tv PRIVMSG #cashdevi :hello there",
  );
  assert.equal(p?.chat?.user, "Viewer1");
  assert.equal(p?.chat?.text, "hello there");
  assert.equal(p?.alert, undefined);
});

test("cheer = chat + bits alert with cheermotes stripped from detail", () => {
  const p = parseIrcLine(
    "@bits=500;display-name=BigFan;color= :bigfan!bigfan@bigfan.tmi.twitch.tv PRIVMSG #cashdevi :Cheer500 love the stream!",
  );
  assert.equal(p?.chat?.text, "Cheer500 love the stream!");
  assert.equal(p?.alert?.kind, "bits");
  assert.equal(p?.alert?.user, "BigFan");
  assert.equal(p?.alert?.detail, "500 bits: love the stream!");
  assert.equal(p?.alert?.amount, 500);
  assert.equal(p?.alert?.message, "love the stream!");
});

test("channel point redemption with message", () => {
  const p = parseIrcLine(
    "@custom-reward-id=abc-123;display-name=Redeemer :redeemer!redeemer@redeemer.tmi.twitch.tv PRIVMSG #cashdevi :say hi to my dog",
  );
  assert.equal(p?.alert?.kind, "reward");
  assert.equal(p?.alert?.detail, "say hi to my dog");
  assert.equal(p?.chat?.text, "say hi to my dog");
});

test("resub with months and message", () => {
  const p = parseIrcLine(
    "@msg-id=resub;msg-param-cumulative-months=7;display-name=Loyal;login=loyal :tmi.twitch.tv USERNOTICE #cashdevi :seven months strong",
  );
  assert.equal(p?.alert?.kind, "sub");
  assert.equal(p?.alert?.detail, "subscribed — 7 months: seven months strong");
});

test("fresh sub without message", () => {
  const p = parseIrcLine(
    "@msg-id=sub;msg-param-cumulative-months=1;display-name=Newbie :tmi.twitch.tv USERNOTICE #cashdevi",
  );
  assert.equal(p?.alert?.kind, "sub");
  assert.equal(p?.alert?.detail, "subscribed");
});

test("single gift sub", () => {
  const p = parseIrcLine(
    "@msg-id=subgift;display-name=Gifter;msg-param-recipient-display-name=Lucky :tmi.twitch.tv USERNOTICE #cashdevi",
  );
  assert.equal(p?.alert?.kind, "sub");
  assert.equal(p?.alert?.detail, "gifted a sub to Lucky");
  assert.equal(p?.alert?.gift, true);
});

test("community gift announces once", () => {
  const p = parseIrcLine(
    "@msg-id=submysterygift;display-name=Whale;msg-param-mass-gift-count=5 :tmi.twitch.tv USERNOTICE #cashdevi",
  );
  assert.equal(p?.alert?.detail, "is gifting 5 subs");
  assert.equal(p?.alert?.mystery, true);
});

test("raid with viewer count", () => {
  const p = parseIrcLine(
    "@msg-id=raid;display-name=OtherStreamer;msg-param-viewerCount=42 :tmi.twitch.tv USERNOTICE #cashdevi",
  );
  assert.equal(p?.alert?.kind, "raid");
  assert.equal(p?.alert?.detail, "is raiding with 42 viewers");
});

test("unknown usernotice kinds are ignored", () => {
  const p = parseIrcLine(
    "@msg-id=announcement;display-name=Mod :tmi.twitch.tv USERNOTICE #cashdevi :big news",
  );
  assert.equal(p, null);
});

test("escaped display-name unescapes", () => {
  const p = parseIrcLine(
    "@display-name=Cool\\sName;bits=100 :cool!cool@cool.tmi.twitch.tv PRIVMSG #cashdevi :Cheer100",
  );
  assert.equal(p?.alert?.user, "Cool Name");
  assert.equal(p?.alert?.detail, "100 bits");
});
