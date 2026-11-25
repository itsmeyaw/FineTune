// Isolated-world half of the content script: the main world can't reach chrome.*, so this carries the tab's volume to it.
import { GET_VOLUME, SET_VOLUME, VOLUME_EVENT } from "./channel.ts";

export interface RelayRuntime {
  readonly sendMessage: (message: unknown) => Promise<unknown>;
  readonly onMessage: { readonly addListener: (listener: (message: unknown) => void) => unknown };
}

export function startRelay(runtime: RelayRuntime, page: EventTarget): void {
  let pushed = false;
  const tell = (volume: number) =>
    page.dispatchEvent(new CustomEvent(VOLUME_EVENT, { detail: volume }));

  runtime.onMessage.addListener((message) => {
    if (typeof message !== "object" || message === null) return;
    const { type, volume } = message as { type?: unknown; volume?: unknown };
    if (type !== SET_VOLUME || typeof volume !== "number") return;
    pushed = true;
    tell(volume);
  });

  // Frames that load after the volume was set (embedded players, new navigations) learn it here.
  runtime.sendMessage({ type: GET_VOLUME }).then(
    (volume) => {
      if (!pushed && typeof volume === "number") tell(volume);
    },
    () => {},
  );
}
