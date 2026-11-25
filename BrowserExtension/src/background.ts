import { createBridge } from "./bridge.ts";
import { detectBrowser } from "./protocol.ts";

createBridge({
  connectNative: (name) => chrome.runtime.connectNative(name),
  hostName: "com.finetuneapp.finetune",
  extensionVersion: chrome.runtime.getManifest().version,
  browser: detectBrowser(navigator.userAgent, Boolean((navigator as { brave?: unknown }).brave)),
  timers: { setTimeout, clearTimeout, setInterval, clearInterval },
}).start();
