// Thin edge over chrome.*; everything else talks to this service so tests can fake it.
import { Context, Deferred, Effect, Exit, Layer, Queue, Schema, Stream } from "effect";
import type { Scope } from "effect";
import type { BrowserName } from "./protocol.ts";

export interface NativePort {
  readonly send: (message: unknown) => Effect.Effect<void>;
  readonly messages: Stream.Stream<unknown>;
  /** Completes when the other side disconnects. */
  readonly closed: Effect.Effect<void>;
}

/** The parts of a browser tab the extension looks at. */
export interface ChromeTab {
  readonly id: number;
  readonly windowId: number;
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly favIconUrl?: string | undefined;
  readonly audible?: boolean | undefined;
  readonly mutedInfo?: { readonly muted?: boolean | undefined } | undefined;
}

export type TabEvent =
  | {
      readonly kind: "updated";
      readonly tabId: number;
      /** Keys of chrome's `changeInfo`. */
      readonly changed: ReadonlyArray<string>;
      readonly tab: ChromeTab;
    }
  | { readonly kind: "removed"; readonly tabId: number }
  | { readonly kind: "windowFocusChanged"; readonly windowId: number };

export class ChromeError extends Schema.TaggedError<
  ChromeError,
  { readonly brand: unique symbol }
>()("ChromeError", { cause: Schema.Defect() }) {}

export class Chrome extends Context.Service<
  Chrome,
  {
    /** Connects to the native messaging host; the port is disconnected when the scope closes. */
    readonly connectNative: (hostName: string) => Effect.Effect<NativePort, never, Scope.Scope>;
    readonly queryTabs: Effect.Effect<ReadonlyArray<ChromeTab>, ChromeError>;
    readonly getTab: (tabId: number) => Effect.Effect<ChromeTab, ChromeError>;
    readonly setTabMuted: (tabId: number, muted: boolean) => Effect.Effect<void, ChromeError>;
    readonly activateTab: (tabId: number) => Effect.Effect<void, ChromeError>;
    readonly focusWindow: (windowId: number) => Effect.Effect<void, ChromeError>;
    /** The browser's last focused window, or undefined when it has none. */
    readonly lastFocusedWindowId: Effect.Effect<number | undefined>;
    /** Tab events from the moment the layer was built; consume with one reader. */
    readonly tabEvents: Stream.Stream<TabEvent>;
  }
>()("finetune/Chrome") {
  static readonly layer = Layer.effect(
    Chrome,
    Effect.gen(function* () {
      // Listeners go on while the service worker starts, so no event is missed before the reader runs.
      const events = yield* Queue.unbounded<TabEvent>();
      chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        const mapped = toChromeTab(tab);
        if (mapped) {
          Queue.offerUnsafe(events, {
            kind: "updated",
            tabId,
            changed: Object.keys(changeInfo),
            tab: mapped,
          });
        }
      });
      chrome.tabs.onRemoved.addListener((tabId) => {
        Queue.offerUnsafe(events, { kind: "removed", tabId });
      });
      chrome.windows.onFocusChanged.addListener((windowId) => {
        Queue.offerUnsafe(events, { kind: "windowFocusChanged", windowId });
      });

      const attempt = <A>(run: () => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: (cause) => new ChromeError({ cause }) });

      return Chrome.of({
        connectNative: Effect.fn("Chrome.connectNative")(function* (hostName: string) {
          const port = yield* Effect.acquireRelease(
            Effect.sync(() => chrome.runtime.connectNative(hostName)),
            (opened) => Effect.sync(() => opened.disconnect()),
          );
          const inbox = yield* Queue.unbounded<unknown>();
          const closed = yield* Deferred.make<void>();
          port.onMessage.addListener((message: unknown) => Queue.offerUnsafe(inbox, message));
          port.onDisconnect.addListener(() => Deferred.doneUnsafe(closed, Exit.void));
          return {
            send: (message) => Effect.sync(() => port.postMessage(message)),
            messages: Stream.fromQueue(inbox),
            closed: Deferred.await(closed),
          } satisfies NativePort;
        }),
        queryTabs: attempt(() => chrome.tabs.query({})).pipe(
          Effect.map((tabs) => tabs.flatMap((tab) => toChromeTab(tab) ?? [])),
        ),
        getTab: (tabId) =>
          attempt(() => chrome.tabs.get(tabId)).pipe(
            Effect.flatMap((tab) => {
              const mapped = toChromeTab(tab);
              return mapped
                ? Effect.succeed(mapped)
                : Effect.fail(new ChromeError({ cause: "tab without an id" }));
            }),
          ),
        setTabMuted: (tabId, muted) =>
          attempt(() => chrome.tabs.update(tabId, { muted })).pipe(Effect.asVoid),
        activateTab: (tabId) =>
          attempt(() => chrome.tabs.update(tabId, { active: true })).pipe(Effect.asVoid),
        focusWindow: (windowId) =>
          attempt(() => chrome.windows.update(windowId, { focused: true })).pipe(Effect.asVoid),
        lastFocusedWindowId: attempt(() => chrome.windows.getLastFocused()).pipe(
          Effect.map((window) => window.id),
          // macOS Chrome can run with no window.
          Effect.orElseSucceed(() => undefined),
        ),
        tabEvents: Stream.fromQueue(events),
      });
    }),
  );
}

function toChromeTab(tab: chrome.tabs.Tab): ChromeTab | undefined {
  if (tab.id === undefined) return undefined;
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    favIconUrl: tab.favIconUrl,
    audible: tab.audible,
    mutedInfo: tab.mutedInfo,
  };
}

/** Facts about this extension install that the bridge needs. */
export class ExtensionInfo extends Context.Service<
  ExtensionInfo,
  {
    readonly hostName: string;
    readonly extensionVersion: string;
    readonly browser: BrowserName;
  }
>()("finetune/ExtensionInfo") {}
