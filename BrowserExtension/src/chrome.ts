// Thin edge over chrome.*; everything else talks to this service so tests can fake it.
import { Context, Deferred, Effect, Exit, Layer, Queue, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { MAX_FAVICON_DATA_URL_LENGTH } from "./protocol.ts";
import { GET_VOLUME, SET_VOLUME } from "./content/channel.ts";
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

/** A content script asking what volume its tab should play at; `respond` answers it. */
export interface VolumeRequest {
  readonly tabId: number;
  readonly respond: (volume: number) => void;
}

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
    /**
     * The page's favicon as a PNG data URL, read from the browser's own cache (`_favicon`), or
     * undefined when there is none or it is too big. Never touches the network.
     */
    readonly favicon: (pageUrl: string) => Effect.Effect<string | undefined, ChromeError>;
    /**
     * Puts the content scripts into every frame of the tab (they're already there for pages opened since the
     * extension loaded). Fails on pages scripts can't run in: chrome://, the Web Store, the PDF viewer.
     */
    readonly injectContentScripts: (tabId: number) => Effect.Effect<void, ChromeError>;
    /** Tells every frame of the tab its volume. Fails when no frame has a content script. */
    readonly sendTabVolume: (tabId: number, volume: number) => Effect.Effect<void, ChromeError>;
    /** Content scripts asking for their tab's volume; consume with one reader. */
    readonly volumeRequests: Stream.Stream<VolumeRequest>;
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

      const volumeRequests = yield* Queue.unbounded<VolumeRequest>();
      chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
        const tabId = sender.tab?.id;
        if (tabId === undefined || !isRequest(message)) return false;
        Queue.offerUnsafe(volumeRequests, { tabId, respond: sendResponse });
        // The answer comes later, from the reader of `volumeRequests`.
        return true;
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
        favicon: (pageUrl) =>
          attempt(async () => {
            const url = new URL(chrome.runtime.getURL("/_favicon/"));
            url.searchParams.set("pageUrl", pageUrl);
            url.searchParams.set("size", "32");
            const response = await fetch(url);
            if (!response.ok) return undefined;
            const blob = await response.blob();
            if (blob.type !== "image/png" || blob.size > MAX_FAVICON_DATA_URL_LENGTH) {
              return undefined;
            }
            const bytes = new Uint8Array(await blob.arrayBuffer());
            return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
          }),
        injectContentScripts: (tabId) =>
          attempt(async () => {
            const target = { tabId, allFrames: true };
            await chrome.scripting.executeScript({
              target,
              files: ["main-world.js"],
              world: "MAIN",
            });
            await chrome.scripting.executeScript({ target, files: ["isolated-world.js"] });
          }),
        sendTabVolume: (tabId, volume) =>
          attempt(() => chrome.tabs.sendMessage(tabId, { type: SET_VOLUME, volume })).pipe(
            Effect.asVoid,
          ),
        volumeRequests: Stream.fromQueue(volumeRequests),
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

const isRequest = (message: unknown) =>
  typeof message === "object" && message !== null && Reflect.get(message, "type") === GET_VOLUME;

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
