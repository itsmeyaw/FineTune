import assert from "node:assert/strict";
import { Deferred, Effect, Exit, Layer, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { Bridge } from "../src/bridge.ts";
import { TabReporter } from "../src/tabs.ts";
import { Chrome, ChromeError, ExtensionInfo } from "../src/chrome.ts";
import type { ChromeTab, TabEvent, VolumeRequest } from "../src/chrome.ts";

export interface FakePort {
  readonly name: string;
  readonly sent: unknown[];
  disconnected: boolean;
  /** The app sends a message. */
  readonly emit: (message: unknown) => void;
  /** The app side goes away. */
  readonly drop: () => void;
}

/**
 * Fakes chrome.* for tests: `ports` lists every native connection opened so far, `tabs` is the
 * browser's tab list, and `calls` records what the extension asked the browser to do.
 */
export function makeFakeChrome(
  options: {
    tabs?: ChromeTab[];
    focusedWindowId?: number;
    /** Favicon data URL by page URL; a missing page has no favicon. */
    favicons?: Record<string, string>;
  } = {},
) {
  const ports: FakePort[] = [];
  const state = {
    tabs: options.tabs ?? [],
    focusedWindowId: options.focusedWindowId,
    favicons: options.favicons ?? {},
  };
  const calls = {
    tabUpdates: [] as Array<readonly [number, { muted?: boolean; active?: boolean }]>,
    windowUpdates: [] as Array<readonly [number, { focused: boolean }]>,
    faviconRequests: [] as string[],
    injected: [] as number[],
    volumes: [] as Array<readonly [number, number]>,
  };
  /** Tabs scripts can't run in (chrome://, the Web Store, the PDF viewer). */
  const unscriptable = (tab: ChromeTab | undefined) =>
    tab?.url === undefined || tab.url.startsWith("chrome://");
  const volumeRequests = Effect.runSync(Queue.unbounded<VolumeRequest>());
  const events = Effect.runSync(Queue.unbounded<TabEvent>());
  const findTab = (tabId: number) => {
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    return tab ? Effect.succeed(tab) : Effect.fail(new ChromeError({ cause: "No tab" }));
  };
  const layer = Layer.succeed(
    Chrome,
    Chrome.of({
      connectNative: (name) =>
        Effect.gen(function* () {
          const inbox = yield* Queue.unbounded<unknown>();
          const closed = yield* Deferred.make<void>();
          const port: FakePort = {
            name,
            sent: [],
            disconnected: false,
            emit: (message) => Queue.offerUnsafe(inbox, message),
            drop: () => Deferred.doneUnsafe(closed, Exit.void),
          };
          ports.push(port);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              port.disconnected = true;
            }),
          );
          return {
            send: (message) =>
              Effect.sync(() => {
                port.sent.push(message);
              }),
            messages: Stream.fromQueue(inbox),
            closed: Deferred.await(closed),
          };
        }),
      queryTabs: Effect.sync(() => state.tabs),
      getTab: findTab,
      setTabMuted: (tabId, muted) =>
        findTab(tabId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              calls.tabUpdates.push([tabId, { muted }]);
            }),
          ),
        ),
      activateTab: (tabId) =>
        findTab(tabId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              calls.tabUpdates.push([tabId, { active: true }]);
            }),
          ),
        ),
      focusWindow: (windowId) =>
        Effect.sync(() => {
          calls.windowUpdates.push([windowId, { focused: true }]);
        }),
      favicon: (pageUrl) =>
        Effect.sync(() => {
          calls.faviconRequests.push(pageUrl);
          return state.favicons[pageUrl];
        }),
      injectContentScripts: (tabId) =>
        unscriptable(state.tabs.find((tab) => tab.id === tabId))
          ? Effect.fail(new ChromeError({ cause: "Cannot access this page" }))
          : Effect.sync(() => {
              calls.injected.push(tabId);
            }),
      sendTabVolume: (tabId, volume) =>
        unscriptable(state.tabs.find((tab) => tab.id === tabId))
          ? Effect.fail(new ChromeError({ cause: "No receiver" }))
          : Effect.sync(() => {
              calls.volumes.push([tabId, volume]);
            }),
      volumeRequests: Stream.fromQueue(volumeRequests),
      lastFocusedWindowId: Effect.sync(() => state.focusedWindowId),
      tabEvents: Stream.fromQueue(events),
    }),
  );
  /** Browser side: a tab event happens. */
  const emitTab = (event: TabEvent) => Queue.offerUnsafe(events, event);
  /** A content script of the tab asks for its volume; returns what it was told. */
  const requestVolume = (tabId: number) => {
    const answers: number[] = [];
    Queue.offerUnsafe(volumeRequests, { tabId, respond: (volume) => answers.push(volume) });
    return answers;
  };
  return { ports, layer, state, calls, emitTab, requestVolume };
}

export const testExtensionInfo = Layer.succeed(
  ExtensionInfo,
  ExtensionInfo.of({
    hostName: "com.finetuneapp.finetune",
    extensionVersion: "0.1.0",
    browser: "chrome",
  }),
);

/** Lets forked fibers run until they wait on something. */
export const settle = Effect.repeat(Effect.yieldNow, { times: 20 });

/** Runs a test program on virtual time. */
export const runTest = <A, E>(program: Effect.Effect<A, E, TestClock.TestClock | Scope.Scope>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestClock.layer())));

/** Connects the extension to the fake app; messages sent after hello and ping are what the app sees. */
export const startReporter = (options: Parameters<typeof makeFakeChrome>[0] = {}) =>
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
