import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { ChromeTab } from "../src/chrome.ts";
import { runTest, settle, startReporter as start } from "./support.ts";

const tab = (over: Partial<ChromeTab> = {}): ChromeTab => ({
  id: 1,
  windowId: 10,
  title: "Song",
  url: "https://www.youtube.com/watch?v=1",
  audible: true,
  mutedInfo: { muted: false },
  ...over,
});
const settings = (over: Partial<ChromeTab> = {}) =>
  tab({ id: 9, url: "chrome://settings", audible: false, mutedInfo: { muted: true }, ...over });

type Reported = { id: number; volume: number; volumeSupported: boolean };
const snapshotTabs = (message: unknown) => (message as { tabs: Reported[] }).tabs;
const lastUpdate = (message: unknown) => (message as { tab: Reported }).tab;

test("tabs report full volume, and whether the page lets the extension change it", () =>
  runTest(
    Effect.gen(function* () {
      const { sent } = yield* start({ tabs: [tab(), settings()] });
      const tabs = snapshotTabs(sent()[0]);
      assert.deepEqual(
        tabs.map((t) => [t.id, t.volume, t.volumeSupported]),
        [
          [1, 1, true],
          [9, 1, false],
        ],
      );
    }),
  ));

test("tabs already open when the extension connects get the content scripts", () =>
  runTest(
    Effect.gen(function* () {
      const { calls } = yield* start({
        tabs: [tab(), tab({ id: 2, audible: false }), settings()],
      });
      assert.deepEqual(calls.injected, [1, 2]);
      assert.deepEqual(calls.volumes, [
        [1, 1],
        [2, 1],
      ]);
    }),
  ));

test("setVolume lowers the tab and the app hears the new volume", () =>
  runTest(
    Effect.gen(function* () {
      const { port, calls, sent } = yield* start({ tabs: [tab()] });
      calls.volumes.length = 0;
      port.emit({ v: 1, type: "setVolume", tabId: 1, volume: 0.3 });
      yield* settle;
      assert.deepEqual(calls.volumes, [[1, 0.3]]);
      assert.equal(lastUpdate(sent().at(-1)).volume, 0.3);
    }),
  ));

test("setVolume on a page the extension can't script does nothing", () =>
  runTest(
    Effect.gen(function* () {
      const { port, calls, sent } = yield* start({ tabs: [settings()] });
      const count = sent().length;
      port.emit({ v: 1, type: "setVolume", tabId: 9, volume: 0.3 });
      yield* settle;
      assert.deepEqual(calls.volumes, []);
      assert.equal(sent().length, count);
    }),
  ));

test("a frame that loads later is told the tab's volume", () =>
  runTest(
    Effect.gen(function* () {
      const { port, requestVolume } = yield* start({ tabs: [tab()] });
      const before = requestVolume(1);
      port.emit({ v: 1, type: "setVolume", tabId: 1, volume: 0.3 });
      yield* settle;
      const after = requestVolume(1);
      yield* settle;
      assert.deepEqual([before, after], [[1], [0.3]]);
    }),
  ));

test("a tab that navigates to a page scripts can't run in becomes unsupported", () =>
  runTest(
    Effect.gen(function* () {
      const { state, emitTab, sent } = yield* start({ tabs: [tab()] });
      state.tabs = [tab({ url: "chrome://settings" })];
      emitTab({ kind: "updated", tabId: 1, changed: ["url"], tab: state.tabs[0] as ChromeTab });
      yield* settle;
      assert.equal(lastUpdate(sent().at(-1)).volumeSupported, false);
    }),
  ));

test("when the app goes away every lowered tab goes back to full volume, and mute is left alone", () =>
  runTest(
    Effect.gen(function* () {
      const { port, ports, calls, state } = yield* start({
        tabs: [tab(), tab({ id: 2, audible: false, mutedInfo: { muted: true } }), tab({ id: 3 })],
      });
      port.emit({ v: 1, type: "setVolume", tabId: 1, volume: 0.3 });
      port.emit({ v: 1, type: "setVolume", tabId: 2, volume: 0.6 });
      yield* settle;
      calls.volumes.length = 0;
      port.drop();
      yield* settle;
      assert.deepEqual(calls.volumes, [
        [1, 1],
        [2, 1],
      ]);
      assert.deepEqual(calls.tabUpdates, []);

      yield* TestClock.adjust(1000);
      yield* settle;
      assert.deepEqual(
        snapshotTabs(ports[1]?.sent[2]).map((t) => t.volume),
        [1, 1, 1],
      );
      assert.equal(state.tabs.length, 3);
    }),
  ));

test("a closed tab forgets its volume", () =>
  runTest(
    Effect.gen(function* () {
      const { port, emitTab, requestVolume } = yield* start({ tabs: [tab()] });
      port.emit({ v: 1, type: "setVolume", tabId: 1, volume: 0.3 });
      yield* settle;
      emitTab({ kind: "removed", tabId: 1 });
      yield* settle;
      const answers = requestVolume(1);
      yield* settle;
      assert.deepEqual(answers, [1]);
    }),
  ));
