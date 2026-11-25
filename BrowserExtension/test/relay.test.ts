import test from "node:test";
import assert from "node:assert/strict";
import { GET_VOLUME, SET_VOLUME, VOLUME_EVENT } from "../src/content/channel.ts";
import { startRelay } from "../src/content/relay.ts";
import type { RelayRuntime } from "../src/content/relay.ts";

const setup = (reply: () => Promise<unknown>) => {
  const listeners: Array<(message: unknown) => void> = [];
  const requests: unknown[] = [];
  const runtime: RelayRuntime = {
    sendMessage: (message) => {
      requests.push(message);
      return reply();
    },
    onMessage: { addListener: (listener) => listeners.push(listener) },
  };
  const page = new EventTarget();
  const heard: unknown[] = [];
  page.addEventListener(VOLUME_EVENT, (event) => heard.push((event as CustomEvent).detail));
  startRelay(runtime, page);
  const push = (message: unknown) => listeners.forEach((listener) => listener(message));
  return { requests, heard, push };
};

const later = () => new Promise((resolve) => setImmediate(resolve));

test("asks the extension for the tab's volume and hands it to the page", async () => {
  const { requests, heard } = setup(() => Promise.resolve(0.4));
  await later();
  assert.deepEqual(requests, [{ type: GET_VOLUME }]);
  assert.deepEqual(heard, [0.4]);
});

test("passes volume pushes on to the page and ignores other messages", () => {
  const { heard, push } = setup(() => new Promise(() => {}));
  push({ type: SET_VOLUME, volume: 0.2 });
  push({ type: SET_VOLUME, volume: "x" });
  push({ type: "other" });
  push(null);
  assert.deepEqual(heard, [0.2]);
});

test("a push that arrives before the reply wins over the older reply", async () => {
  let answer: (value: unknown) => void = () => {};
  const { heard, push } = setup(() => new Promise((resolve) => (answer = resolve)));
  push({ type: SET_VOLUME, volume: 0.2 });
  answer(1);
  await later();
  assert.deepEqual(heard, [0.2]);
});

test("a failed or garbage reply leaves the page alone", async () => {
  const failed = setup(() => Promise.reject(new Error("no receiver")));
  const garbage = setup(() => Promise.resolve("loud"));
  await later();
  assert.deepEqual(failed.heard, []);
  assert.deepEqual(garbage.heard, []);
});
