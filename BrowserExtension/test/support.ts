import { Deferred, Effect, Exit, Layer, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { Chrome, ChromeError, ExtensionInfo } from "../src/chrome.ts";
import type { ChromeTab, TabEvent } from "../src/chrome.ts";

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
export function makeFakeChrome(options: { tabs?: ChromeTab[]; focusedWindowId?: number } = {}) {
  const ports: FakePort[] = [];
  const state = { tabs: options.tabs ?? [], focusedWindowId: options.focusedWindowId };
  const calls = {
    tabUpdates: [] as Array<readonly [number, { muted?: boolean; active?: boolean }]>,
    windowUpdates: [] as Array<readonly [number, { focused: boolean }]>,
  };
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
      lastFocusedWindowId: Effect.sync(() => state.focusedWindowId),
      tabEvents: Stream.fromQueue(events),
    }),
  );
  /** Browser side: a tab event happens. */
  const emitTab = (event: TabEvent) => Queue.offerUnsafe(events, event);
  return { ports, layer, state, calls, emitTab };
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
