import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import type { ChromeTab } from "../src/chrome.ts";
import { isReportable, tabInfo } from "../src/tabs.ts";
import { runTest, settle, startReporter as start } from "./support.ts";

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

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const full = { level: 1, supported: true };
const unsupported = { level: 1, supported: false };

const muted = (over: Partial<ChromeTab> = {}) =>
  tab({ audible: false, mutedInfo: { muted: true }, ...over });
const silent = (over: Partial<ChromeTab> = {}) => tab({ audible: false, ...over });

test("reports audible tabs and muted tabs, nothing else", () => {
  assert.equal(isReportable(tab()), true);
  assert.equal(isReportable(muted()), true);
  assert.equal(isReportable(silent()), false);
  assert.equal(isReportable({ id: 2, windowId: 1 }), false);
});

test("tabInfo carries id, title, site, favicon, muted, window focus and volume", () => {
  assert.deepEqual(tabInfo(tab(), 10, PNG, full), {
    id: 1,
    title: "Song",
    site: "www.youtube.com",
    favicon: PNG,
    muted: false,
    windowFocused: true,
    volume: 1,
    volumeSupported: true,
  });
  assert.deepEqual(tabInfo(muted({ url: "chrome://x" }), 99, undefined, unsupported), {
    id: 1,
    title: "Song",
    site: "x",
    muted: true,
    windowFocused: false,
    volume: 1,
    volumeSupported: false,
  });
  assert.equal(tabInfo(tab({ url: undefined, title: undefined }), 10, undefined, full).site, "");
  assert.equal(tabInfo(tab({ url: "not a url" }), 10, undefined, full).site, "");
});

test("the favicon is a local data URL; the page's remote favicon URL is never sent", () =>
  runTest(
    Effect.gen(function* () {
      const { sent, calls } = yield* start({
        tabs: [tab()],
        favicons: { "https://www.youtube.com/watch?v=1": PNG },
      });
      const snapshot = sent()[0] as { tabs: Array<{ favicon?: string }> };
      assert.equal(snapshot.tabs[0]?.favicon, PNG);
      assert.deepEqual(calls.faviconRequests, ["https://www.youtube.com/watch?v=1"]);
    }),
  ));

test("a tab without an obtainable favicon is sent without one", () =>
  runTest(
    Effect.gen(function* () {
      const { sent } = yield* start({ tabs: [tab()] });
      const snapshot = sent()[0] as { tabs: Array<Record<string, unknown>> };
      assert.equal("favicon" in (snapshot.tabs[0] ?? {}), false);
    }),
  ));

test("favicons that are too big or not PNG data URLs are dropped", () =>
  runTest(
    Effect.gen(function* () {
      const big = `data:image/png;base64,${"A".repeat(16 * 1024)}`;
      const { sent } = yield* start({
        tabs: [tab({ id: 1, url: "https://a.com/" }), tab({ id: 2, url: "https://b.com/" })],
        favicons: { "https://a.com/": big, "https://b.com/": "https://b.com/favicon.ico" },
      });
      const snapshot = sent()[0] as { tabs: Array<Record<string, unknown>> };
      assert.deepEqual(
        snapshot.tabs.map((t) => "favicon" in t),
        [false, false],
      );
    }),
  ));

test("favicons are cached per origin and only asked for http(s) pages", () =>
  runTest(
    Effect.gen(function* () {
      const { sent, calls, emitTab } = yield* start({
        tabs: [
          tab({ id: 1, url: "https://a.com/one" }),
          tab({ id: 2, url: "https://a.com/two" }),
          tab({ id: 3, url: "chrome://settings" }),
        ],
        favicons: { "https://a.com/one": PNG },
      });
      assert.deepEqual(calls.faviconRequests, ["https://a.com/one"]);
      const snapshot = sent()[0] as { tabs: Array<{ favicon?: string }> };
      assert.deepEqual(
        snapshot.tabs.map((t) => t.favicon),
        [PNG, PNG, undefined],
      );
      emitTab({
        kind: "updated",
        tabId: 2,
        changed: ["title"],
        tab: tab({ id: 2, url: "https://a.com/two", title: "Next" }),
      });
      yield* settle;
      assert.equal(calls.faviconRequests.length, 1);
      assert.equal((sent().at(-1) as { tab: { favicon?: string } }).tab.favicon, PNG);
    }),
  ));

test("a favicon that was missing is asked for again on the next change", () =>
  runTest(
    Effect.gen(function* () {
      const { sent, state, calls, emitTab } = yield* start({ tabs: [tab()] });
      state.favicons = { "https://www.youtube.com/watch?v=1": PNG };
      emitTab({ kind: "updated", tabId: 1, changed: ["favIconUrl"], tab: tab() });
      yield* settle;
      assert.equal(calls.faviconRequests.length, 2);
      assert.equal((sent().at(-1) as { tab: { favicon?: string } }).tab.favicon, PNG);
    }),
  ));

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
