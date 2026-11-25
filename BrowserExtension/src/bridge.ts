import { helloMessage, pingMessage, parseMessage } from "./protocol.ts";
import type { BrowserName } from "./protocol.ts";

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10000;
const HEARTBEAT_MS = 20000;

export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface Timers<Handle = unknown> {
  setTimeout(fn: () => void, ms: number): Handle;
  clearTimeout(handle: Handle): void;
  setInterval(fn: () => void, ms: number): Handle;
  clearInterval(handle: Handle): void;
}

export interface BridgeOptions {
  connectNative: (hostName: string) => NativePort;
  hostName: string;
  extensionVersion: string;
  browser: BrowserName;
  timers: Timers;
}

// Keeps one native messaging connection to the FineTune app alive. `timers` is injectable for tests.
export function createBridge({
  connectNative,
  hostName,
  extensionVersion,
  browser,
  timers,
}: BridgeOptions) {
  let delay = BASE_DELAY_MS;
  let heardSinceBeat = false;
  let heartbeat: unknown = null;

  function connect(): void {
    const port = connectNative(hostName);
    heardSinceBeat = false;
    let dropped = false;

    function drop(): void {
      if (dropped) return;
      dropped = true;
      timers.clearInterval(heartbeat);
      timers.setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }

    port.onMessage.addListener((raw) => {
      try {
        parseMessage(raw);
      } catch {
        return;
      }
      heardSinceBeat = true;
      delay = BASE_DELAY_MS;
    });
    port.onDisconnect.addListener(drop);

    port.postMessage(helloMessage(extensionVersion, browser));
    port.postMessage(pingMessage());
    // Chrome never fires onDisconnect for our own disconnect(), so drop() runs directly.
    heartbeat = timers.setInterval(() => {
      if (!heardSinceBeat) {
        port.disconnect();
        drop();
        return;
      }
      heardSinceBeat = false;
      port.postMessage(pingMessage());
    }, HEARTBEAT_MS);
  }

  return { start: connect };
}
