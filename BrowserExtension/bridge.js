import { helloMessage, pingMessage, parseMessage } from './protocol.js';

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10000;
const HEARTBEAT_MS = 20000;

// Keeps one native messaging connection to the FineTune app alive. `timers` is injectable for tests.
export function createBridge({ connectNative, hostName, extensionVersion, browser, timers }) {
  let delay = BASE_DELAY_MS;
  let heardSinceBeat = false;
  let heartbeat = null;
  let reconnect = null;

  function connect() {
    reconnect = null;
    const port = connectNative(hostName);
    heardSinceBeat = false;
    let dropped = false;

    function drop() {
      if (dropped) return;
      dropped = true;
      timers.clearInterval(heartbeat);
      reconnect = timers.setTimeout(connect, delay);
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
