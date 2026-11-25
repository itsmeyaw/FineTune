import test from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { Bridge } from "../src/bridge.ts";
import type { ChromeTab } from "../src/chrome.ts";
import { isReportable, tabInfo, TabReporter } from "../src/tabs.ts";
import { makeFakeChrome, runTest, settle, testExtensionInfo } from "./support.ts";

const tab = (over: Partial<ChromeTab> = {}): ChromeTab => ({
  id: 1,
  windowId: 10,
  title: "Song",
  url: "https://www.youtube.com/watch?v=1",
  favIconUrl: "https://www.youtube.com/favicon.ico",
  audible: true,
  mutedInfo: { muted: false },
  ...over,
});

const muted = (over: Partial<ChromeTab> = {}) =>
  tab({ audible: false, mutedInfo: { muted: true }, ...over });
const silent = (over: Partial<ChromeTab> = {}) => tab({ audible: false, ...over });

/** Connects the extension to the fake app; messages sent after hello and ping are what the app sees. */
const start = (options: Parameters<typeof makeFakeChrome>[0] = {}) =>
  Effect.gen(function* () {
    const fake = makeFakeChrome(options);
    yield* Layer.build(
      TabReporter.layer.pipe(
        Layer.provide(Bridge.layer),
        Layer.provide(Layer.merge(fake.layer, testExtensionInfo)),
      ),
    );
    yield* settle;
    const port = fake.ports[0];
    assert.ok(port);
    const sent = () => port.sent.slice(2);
    return { ...fake, port, sent };
  });

test("reports audible tabs and muted tabs, nothing else", () => {
  assert.equal(isReportable(tab()), true);
  assert.equal(isReportable(muted()), true);
  assert.equal(isReportable(silent()), false);
  assert.equal(isReportable({ id: 2, windowId: 1 }), false);
});

test("tabInfo carries id, title, site, favicon, muted and window focus", () => {
  assert.deepEqual(tabInfo(tab(), 10), {
    id: 1,
    title: "Song",
    site: "www.youtube.com",
    favicon: "https://www.youtube.com/favicon.ico",
    muted: false,
    windowFocused: true,
  });
  assert.deepEqual(tabInfo(muted({ favIconUrl: undefined, url: "chrome://x" }), 99), {
    id: 1,
    title: "Song",
    site: "x",
    muted: true,
    windowFocused: false,
  });
  assert.equal(tabInfo(tab({ url: undefined, title: undefined }), 10).site, "");
  assert.equal(tabInfo(tab({ url: "not a url" }), 10).site, "");
});

test("a snapshot of only the reportable tabs goes out on connect", () =>
  runTest(
    Effect.gen(function* () {
      const { sent } = yield* start({
        tabs: [tab(), silent({ id: 2 }), muted({ id: 3 })],
        focusedWindowId: 10,
      });
      assert.equal(sent().length, 1);
      const snapshot = sent()[0] as { type: string; tabs: Array<{ id: number }> };
      assert.equal(snapshot.type, "tabs");
      assert.deepEqual(
        snapshot.tabs.map((t) => t.id),
        [1, 3],
      );
    }),
  ));

test("a tab that starts playing is sent as an update", () =>
  runTest(
    Effect.gen(function* () {
      const { sent, emitTab } = yield* start();
      emitTab({ kind: "updated", tabId: 5, changed: ["audible"], tab: tab({ id: 5 }) });
      yield* settle;
      const update = sent().at(-1) as { type: string; tab: { id: number } };
      assert.equal(update.type, "tabUpdated");
      assert.equal(update.tab.id, 5);
    }),
  ));

test("a tab that stops being audible is removed, not closed; a muted one stays", () =>
  runTest(
    Effect.gen(function* () {
      const { sent, emitTab } = yield* start();
      emitTab({ kind: "updated", tabId: 1, changed: ["audible"], tab: tab() });
      emitTab({ kind: "updated", tabId: 1, changed: ["audible"], tab: silent() });
      yield* settle;
      assert.deepEqual(sent().at(-1), { v: 1, type: "tabRemoved", tabId: 1, closed: false });

      emitTab({ kind: "updated", tabId: 1, changed: ["audible"], tab: tab() });
      emitTab({ kind: "updated", tabId: 1, changed: ["audible", "mutedInfo"], tab: muted() });
      yield* settle;
      const update = sent().at(-1) as { type: string; tab: { muted: boolean } };
      assert.equal(update.type, "tabUpdated");
      assert.equal(update.tab.muted, true);
    }),
  ));

test("irrelevant changes and unchanged tabs send nothing", () =>
  runTest(
    Effect.gen(function* () {
      const { sent, emitTab } = yield* start();
      emitTab({ kind: "updated", tabId: 1, changed: ["audible"], tab: tab() });
      yield* settle;
      const count = sent().length;
      emitTab({ kind: "updated", tabId: 1, changed: ["status"], tab: tab() });
      emitTab({ kind: "updated", tabId: 1, changed: ["title"], tab: tab() });
      emitTab({ kind: "updated", tabId: 2, changed: ["status"], tab: silent({ id: 2 }) });
      yield* settle;
      assert.equal(sent().length, count);
    }),
  ));

test("a title change of a reported tab is sent", () =>
  runTest(
    Effect.gen(function* () {
      const { sent, emitTab } = yield* start();
      emitTab({ kind: "updated", tabId: 1, changed: ["audible"], tab: tab() });
      emitTab({ kind: "updated", tabId: 1, changed: ["title"], tab: tab({ title: "Next" }) });
      yield* settle;
      assert.equal((sent().at(-1) as { tab: { title: string } }).tab.title, "Next");
    }),
  ));

test("closing a reported tab sends a closed removal; an unreported one sends nothing", () =>
  runTest(
    Effect.gen(function* () {
      const { sent, emitTab } = yield* start();
      emitTab({ kind: "updated", tabId: 1, changed: ["audible"], tab: tab() });
      emitTab({ kind: "removed", tabId: 1 });
      yield* settle;
      assert.deepEqual(sent().at(-1), { v: 1, type: "tabRemoved", tabId: 1, closed: true });
      const count = sent().length;
      emitTab({ kind: "removed", tabId: 42 });
      yield* settle;
      assert.equal(sent().length, count);
    }),
  ));

test("a window focus change resends a snapshot with the new focus", () =>
  runTest(
    Effect.gen(function* () {
      const { sent, emitTab } = yield* start({ tabs: [tab()], focusedWindowId: 10 });
      const focus = () => (sent().at(-1) as { tabs: Array<{ windowFocused: boolean }> }).tabs[0];
      assert.equal(focus()?.windowFocused, true);
      emitTab({ kind: "windowFocusChanged", windowId: 77 });
      yield* settle;
      assert.equal(focus()?.windowFocused, false);
    }),
  ));

test("setMuted and focus commands from the app act on the browser", () =>
  runTest(
    Effect.gen(function* () {
      const { port, calls } = yield* start({ tabs: [tab({ windowId: 33 })] });
      port.emit({ v: 1, type: "setMuted", tabId: 1, muted: true });
      port.emit({ v: 1, type: "focus", tabId: 1 });
      yield* settle;
      assert.deepEqual(calls.tabUpdates, [
        [1, { muted: true }],
        [1, { active: true }],
      ]);
      assert.deepEqual(calls.windowUpdates, [[33, { focused: true }]]);
    }),
  ));

test("commands for a tab that is gone are ignored and later commands still run", () =>
  runTest(
    Effect.gen(function* () {
      const { port, calls } = yield* start({ tabs: [tab()] });
      port.emit({ v: 1, type: "focus", tabId: 9 });
      port.emit({ v: 1, type: "setMuted", tabId: 9, muted: true });
      port.emit({ v: 1, type: "setMuted", tabId: 1, muted: true });
      yield* settle;
      assert.deepEqual(calls.windowUpdates, []);
      assert.deepEqual(calls.tabUpdates, [[1, { muted: true }]]);
    }),
  ));

test("every reconnect sends a fresh snapshot", () =>
  runTest(
    Effect.gen(function* () {
      const { ports, state } = yield* start({ tabs: [tab()] });
      state.tabs = [tab(), muted({ id: 2 })];
      ports[0]?.emit({ v: 1, type: "pong" });
      ports[0]?.drop();
      yield* settle;
      yield* TestClock.adjust(1000);
      yield* settle;
      const snapshot = ports[1]?.sent[2] as { tabs: unknown[] };
      assert.equal(snapshot.tabs.length, 2);
    }),
  ));
