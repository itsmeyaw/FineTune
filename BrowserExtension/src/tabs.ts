// Mirrors the browser's audible and muted tabs to the app, and runs the app's mute/focus commands.
import { Effect, Layer, Ref, Stream } from "effect";
import { Bridge } from "./bridge.ts";
import { Chrome } from "./chrome.ts";
import type { ChromeTab, TabEvent } from "./chrome.ts";
import { tabRemovedMessage, tabsMessage, tabUpdatedMessage } from "./protocol.ts";
import type { Command, Tab } from "./protocol.ts";

/** A Tab is one that makes sound or that the user muted; everything else stays out of the app's list. */
export const isReportable = (tab: ChromeTab): boolean =>
  tab.audible === true || tab.mutedInfo?.muted === true;

const siteOf = (url: string | undefined): string =>
  url !== undefined && URL.canParse(url) ? new URL(url).hostname : "";

export function tabInfo(tab: ChromeTab, focusedWindowId: number | undefined): Tab {
  return {
    id: tab.id,
    title: tab.title ?? "",
    site: siteOf(tab.url),
    ...(tab.favIconUrl ? { favicon: tab.favIconUrl } : {}),
    muted: tab.mutedInfo?.muted === true,
    windowFocused: tab.windowId === focusedWindowId,
  };
}

// Changes that can alter what the app shows for a tab.
const RELEVANT_CHANGES = ["audible", "mutedInfo", "title", "favIconUrl", "url"];

type Input =
  | { readonly kind: "connected" }
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

      const sendSnapshot = Effect.fn("TabReporter.sendSnapshot")(function* (
        knownFocusedWindowId?: number,
      ) {
        const focused = knownFocusedWindowId ?? (yield* chrome.lastFocusedWindowId);
        yield* Ref.set(focusedWindow, focused);
        const tabs = (yield* chrome.queryTabs)
          .filter(isReportable)
          .map((tab) => tabInfo(tab, focused));
        reported.clear();
        for (const tab of tabs) reported.set(tab.id, JSON.stringify(tab));
        yield* bridge.send(tabsMessage(tabs));
      });

      const onTabEvent = Effect.fn("TabReporter.onTabEvent")(function* (event: TabEvent) {
        if (event.kind === "windowFocusChanged") {
          return yield* sendSnapshot(event.windowId);
        }
        if (event.kind === "removed") {
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
        const info = tabInfo(event.tab, yield* Ref.get(focusedWindow));
        const serialized = JSON.stringify(info);
        if (reported.get(event.tabId) === serialized) return undefined;
        reported.set(event.tabId, serialized);
        return yield* bridge.send(tabUpdatedMessage(info));
      });

      const runCommand = Effect.fn("TabReporter.runCommand")(function* (command: Command) {
        if (command.type === "setMuted") {
          return yield* chrome.setTabMuted(command.tabId, command.muted);
        }
        const tab = yield* chrome.getTab(command.tabId);
        yield* chrome.activateTab(command.tabId);
        return yield* chrome.focusWindow(tab.windowId);
      });

      const handle = (input: Input) =>
        input.kind === "connected"
          ? sendSnapshot()
          : input.kind === "command"
            ? runCommand(input.command)
            : onTabEvent(input.event);

      // One reader keeps snapshots, events and commands from interleaving.
      yield* Stream.mergeAll(
        [
          bridge.connected.pipe(Stream.map((): Input => ({ kind: "connected" }))),
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
