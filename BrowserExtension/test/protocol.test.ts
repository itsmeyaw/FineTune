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
