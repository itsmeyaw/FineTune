// Mirrors the browser's audible and muted tabs to the app, and runs the app's mute/focus/volume commands.
import { Effect, Layer, Ref, Stream } from "effect";
import { Bridge } from "./bridge.ts";
import { Chrome } from "./chrome.ts";
import type { ChromeTab, TabEvent, VolumeRequest } from "./chrome.ts";
import {
  MAX_FAVICON_DATA_URL_LENGTH,
  tabRemovedMessage,
  tabsMessage,
  tabUpdatedMessage,
} from "./protocol.ts";
import type { Command, Tab } from "./protocol.ts";

/** A Tab is one that makes sound or that the user muted; everything else stays out of the app's list. */
export const isReportable = (tab: ChromeTab): boolean =>
  tab.audible === true || tab.mutedInfo?.muted === true;

const siteOf = (url: string | undefined): string =>
  url !== undefined && URL.canParse(url) ? new URL(url).hostname : "";

const httpOrigin = (url: string | undefined): string | undefined =>
  url !== undefined && URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)
    ? new URL(url).origin
    : undefined;

const isSendableFavicon = (value: string | undefined): value is string =>
  value !== undefined &&
  value.length <= MAX_FAVICON_DATA_URL_LENGTH &&
  value.startsWith("data:image/png;base64,");

// shortcut: a cached favicon never refreshes when a site changes its icon, until the worker restarts.
const MAX_CACHED_FAVICONS = 100;

export function tabInfo(
  tab: ChromeTab,
  focusedWindowId: number | undefined,
  favicon: string | undefined,
  volume: { readonly level: number; readonly supported: boolean },
): Tab {
  return {
    id: tab.id,
    title: tab.title ?? "",
    site: siteOf(tab.url),
    ...(favicon === undefined ? {} : { favicon }),
    muted: tab.mutedInfo?.muted === true,
    windowFocused: tab.windowId === focusedWindowId,
    volume: volume.level,
    volumeSupported: volume.supported,
  };
}

// Changes that can alter what the app shows for a tab.
const RELEVANT_CHANGES = ["audible", "mutedInfo", "title", "favIconUrl", "url"];

type Input =
  | { readonly kind: "connected" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "volumeRequest"; readonly request: VolumeRequest }
  | { readonly kind: "command"; readonly command: Command }
  | { readonly kind: "tab"; readonly event: TabEvent };

export const TabReporter = {
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const chrome = yield* Chrome;
      const bridge = yield* Bridge;
      /** Last info sent per tab id, to skip updates that change nothing. */
      const reported = new Map<number, string>();
      const focusedWindow = yield* Ref.make<number | undefined>(undefined);
      /** Favicon data URL by page origin. */
      const favicons = new Map<string, string>();

      // The favicon comes from the browser's local cache, so no request leaves the Mac.
      const faviconOf = Effect.fn("TabReporter.faviconOf")(function* (tab: ChromeTab) {
        const origin = httpOrigin(tab.url);
        if (origin === undefined || tab.url === undefined) return undefined;
        const cached = favicons.get(origin);
        if (cached !== undefined) return cached;
        const found = yield* chrome
          .favicon(tab.url)
          .pipe(Effect.catchTag("ChromeError", () => Effect.undefined));
        if (!isSendableFavicon(found)) return undefined;
        if (favicons.size >= MAX_CACHED_FAVICONS) {
          for (const oldest of favicons.keys()) {
            favicons.delete(oldest);
            break;
          }
        }
        favicons.set(origin, found);
        return found;
      });

      /** Tab Volume of tabs below 100%. Lives as long as the tab and the connection to the app. */
      const volumes = new Map<number, number>();
      /** Whether content scripts could be put into the tab's page, per URL: chrome:// pages, the Web Store and the PDF viewer refuse. */
      const scriptable = new Map<
        number,
        { readonly url: string | undefined; readonly ok: boolean }
      >();

      const supports = Effect.fn("TabReporter.supports")(function* (tab: ChromeTab) {
        const known = scriptable.get(tab.id);
        if (known && known.url === tab.url) return known.ok;
        const ok = yield* chrome.injectContentScripts(tab.id).pipe(
          Effect.as(true),
          Effect.catchTag("ChromeError", () => Effect.succeed(false)),
        );
        scriptable.set(tab.id, { url: tab.url, ok });
        return ok;
      });

      const infoOf = Effect.fn("TabReporter.infoOf")(function* (
        tab: ChromeTab,
        focused: number | undefined,
      ) {
        return tabInfo(tab, focused, yield* faviconOf(tab), {
          level: volumes.get(tab.id) ?? 1,
          supported: yield* supports(tab),
        });
      });

      const tellTab = (tabId: number, volume: number) =>
        chrome.sendTabVolume(tabId, volume).pipe(Effect.ignore);

      /** Gets the content scripts into the tab and brings its page to the volume it should have. */
      const prepare = (tab: ChromeTab) =>
        supports(tab).pipe(
          Effect.flatMap((ok) => (ok ? tellTab(tab.id, volumes.get(tab.id) ?? 1) : Effect.void)),
        );

      const sendSnapshot = Effect.fn("TabReporter.sendSnapshot")(function* (
        knownFocusedWindowId?: number,
      ) {
        const focused = knownFocusedWindowId ?? (yield* chrome.lastFocusedWindowId);
        yield* Ref.set(focusedWindow, focused);
        const all = yield* chrome.queryTabs;
        yield* Effect.forEach(all, prepare, { concurrency: 8, discard: true });
        const tabs = yield* Effect.forEach(
          all.filter(isReportable),
          (tab) => infoOf(tab, focused),
          { concurrency: 8 },
        );
        reported.clear();
        for (const tab of tabs) reported.set(tab.id, JSON.stringify(tab));
        yield* bridge.send(tabsMessage(tabs));
      });

      const onTabEvent = Effect.fn("TabReporter.onTabEvent")(function* (event: TabEvent) {
        if (event.kind === "windowFocusChanged") {
          return yield* sendSnapshot(event.windowId);
        }
        if (event.kind === "removed") {
          volumes.delete(event.tabId);
          scriptable.delete(event.tabId);
          return reported.delete(event.tabId)
            ? yield* bridge.send(tabRemovedMessage(event.tabId, true))
            : undefined;
        }
        if (!RELEVANT_CHANGES.some((key) => event.changed.includes(key))) return undefined;
        if (!isReportable(event.tab)) {
          return reported.delete(event.tabId)
            ? yield* bridge.send(tabRemovedMessage(event.tabId, false))
            : undefined;
        }
        return yield* report(event.tab);
      });

      /** Sends the tab to the app unless the app already has exactly this. */
      const report = Effect.fn("TabReporter.report")(function* (tab: ChromeTab) {
        const info = yield* infoOf(tab, yield* Ref.get(focusedWindow));
        const serialized = JSON.stringify(info);
        if (reported.get(tab.id) === serialized) return undefined;
        reported.set(tab.id, serialized);
        return yield* bridge.send(tabUpdatedMessage(info));
      });

      const setVolume = Effect.fn("TabReporter.setVolume")(function* (
        tabId: number,
        level: number,
      ) {
        const tab = yield* chrome.getTab(tabId);
        if (!(yield* supports(tab))) return;
        if (level === 1) volumes.delete(tabId);
        else volumes.set(tabId, level);
        yield* chrome.sendTabVolume(tabId, level);
        if (reported.has(tabId)) yield* report(tab);
      });

      // Pages are put back to 100% when the app goes away; their mute is not touched.
      const resetVolumes = Effect.fn("TabReporter.resetVolumes")(function* () {
        const lowered = [...volumes.keys()];
        volumes.clear();
        yield* Effect.forEach(lowered, (tabId) => tellTab(tabId, 1), { discard: true });
      });

      const runCommand = Effect.fn("TabReporter.runCommand")(function* (command: Command) {
        if (command.type === "setMuted") {
          return yield* chrome.setTabMuted(command.tabId, command.muted);
        }
        if (command.type === "setVolume") return yield* setVolume(command.tabId, command.volume);
        const tab = yield* chrome.getTab(command.tabId);
        yield* chrome.activateTab(command.tabId);
        return yield* chrome.focusWindow(tab.windowId);
      });

      const handle = (input: Input) =>
        input.kind === "connected"
          ? sendSnapshot()
          : input.kind === "disconnected"
            ? resetVolumes()
            : input.kind === "command"
              ? runCommand(input.command)
              : input.kind === "volumeRequest"
                ? Effect.sync(() => input.request.respond(volumes.get(input.request.tabId) ?? 1))
                : onTabEvent(input.event);

      // One reader keeps snapshots, events and commands from interleaving.
      yield* Stream.mergeAll(
        [
          bridge.connected.pipe(Stream.map((): Input => ({ kind: "connected" }))),
          bridge.disconnected.pipe(Stream.map((): Input => ({ kind: "disconnected" }))),
          chrome.volumeRequests.pipe(
            Stream.map((request): Input => ({ kind: "volumeRequest", request })),
          ),
          bridge.commands.pipe(Stream.map((command): Input => ({ kind: "command", command }))),
          chrome.tabEvents.pipe(Stream.map((event): Input => ({ kind: "tab", event }))),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Stream.runForEach((input) =>
          // A tab that vanished before we got to it is not an error.
          handle(input).pipe(Effect.catchTag("ChromeError", (error) => Effect.logDebug(error))),
        ),
        Effect.forkScoped,
      );
    }),
  ),
};
