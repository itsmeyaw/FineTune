import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import {
  PROTOCOL_VERSION,
  detectBrowser,
  encodeOutbound,
  helloMessage,
  parseMessage,
  pingMessage,
  tabRemovedMessage,
  tabUpdatedMessage,
  tabsMessage,
} from "../src/protocol.ts";

const parse = (raw: unknown) => Effect.runPromise(parseMessage(raw));
const parseError = (raw: unknown) => Effect.runPromise(Effect.flip(parseMessage(raw)));

test("hello carries version, extension version and browser", async () => {
  assert.deepEqual(await Effect.runPromise(encodeOutbound(helloMessage("0.1.0", "edge"))), {
    v: 1,
    type: "hello",
    extensionVersion: "0.1.0",
    browser: "edge",
  });
  assert.equal(PROTOCOL_VERSION, 1);
});

test("ping is versioned", async () => {
  assert.deepEqual(await Effect.runPromise(encodeOutbound(pingMessage())), { v: 1, type: "ping" });
});

test("parseMessage accepts pong", async () => {
  assert.equal((await parse({ v: 1, type: "pong" })).type, "pong");
});

test("parseMessage reports unknown types instead of throwing", async () => {
  assert.deepEqual(await parse({ v: 1, type: "tabSnapshot" }), {
    type: "unknown",
    unknownType: "tabSnapshot",
  });
});

test("parseMessage rejects a bad version", async () => {
  const error = await parseError({ v: 2, type: "pong" });
  assert.equal(error._tag, "UnsupportedVersion");
  assert.equal(error._tag === "UnsupportedVersion" && error.version, 2);
});

test("parseMessage rejects malformed input", async () => {
  for (const bad of [null, "x", [], {}, { v: 1 }, { v: 1, type: 5 }, { type: "pong" }]) {
    assert.equal((await parseError(bad))._tag, "MalformedMessage");
  }
});

test("detectBrowser tells Edge, Brave and Vivaldi from Chrome", () => {
  const chrome =
    "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  assert.equal(detectBrowser(chrome, false), "chrome");
  assert.equal(detectBrowser(`${chrome} Edg/130.0.0.0`, false), "edge");
  assert.equal(detectBrowser(chrome, true), "brave");
  assert.equal(detectBrowser(`${chrome} Vivaldi/7.0`, false), "vivaldi");
});

test("tab messages are versioned and omit an unknown favicon", async () => {
  const tab = { id: 7, title: "T", site: "a.com", muted: false, windowFocused: true };
  const encode = (message: Parameters<typeof encodeOutbound>[0]) =>
    Effect.runPromise(encodeOutbound(message));
  assert.deepEqual(await encode(tabsMessage([tab])), { v: 1, type: "tabs", tabs: [tab] });
  assert.deepEqual(await encode(tabUpdatedMessage({ ...tab, favicon: "data:x" })), {
    v: 1,
    type: "tabUpdated",
    tab: { ...tab, favicon: "data:x" },
  });
  assert.deepEqual(await encode(tabRemovedMessage(7, true)), {
    v: 1,
    type: "tabRemoved",
    tabId: 7,
    closed: true,
  });
});

test("parseMessage accepts setMuted and focus commands", async () => {
  assert.deepEqual(await parse({ v: 1, type: "setMuted", tabId: 3, muted: true }), {
    v: 1,
    type: "setMuted",
    tabId: 3,
    muted: true,
  });
  assert.deepEqual(await parse({ v: 1, type: "focus", tabId: 3 }), {
    v: 1,
    type: "focus",
    tabId: 3,
  });
});

test("parseMessage rejects commands with missing or ill-typed fields", async () => {
  for (const bad of [
    { v: 1, type: "setMuted", tabId: 3 },
    { v: 1, type: "setMuted", tabId: "3", muted: true },
    { v: 1, type: "setMuted", tabId: 3, muted: "yes" },
    { v: 1, type: "focus" },
    { v: 1, type: "focus", tabId: 1.5 },
  ]) {
    assert.equal((await parseError(bad))._tag, "MalformedMessage");
  }
});

test("parseMessage accepts setVolume between 0 and 1 and rejects anything else", async () => {
  for (const volume of [0, 0.25, 1]) {
    assert.deepEqual(await parse({ v: 1, type: "setVolume", tabId: 3, volume }), {
      v: 1,
      type: "setVolume",
      tabId: 3,
      volume,
    });
  }
  for (const bad of [
    { v: 1, type: "setVolume", tabId: 3 },
    { v: 1, type: "setVolume", tabId: 3, volume: 1.5 },
    { v: 1, type: "setVolume", tabId: 3, volume: -0.1 },
    { v: 1, type: "setVolume", tabId: 3, volume: "0.5" },
    { v: 1, type: "setVolume", tabId: 3, volume: null },
    { v: 1, type: "setVolume", tabId: 1.5, volume: 0.5 },
  ]) {
    assert.equal((await parseError(bad))._tag, "MalformedMessage");
  }
});

test("tabs carry their volume and whether it can be changed", async () => {
  const tab = {
    id: 7,
    title: "T",
    site: "a.com",
    muted: false,
    windowFocused: true,
    volume: 0.5,
    volumeSupported: true,
  };
  assert.deepEqual(await Effect.runPromise(encodeOutbound(tabUpdatedMessage(tab))), {
    v: 1,
    type: "tabUpdated",
    tab,
  });
});
