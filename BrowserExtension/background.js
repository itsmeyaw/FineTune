import { createBridge } from './bridge.js';
import { detectBrowser } from './protocol.js';

createBridge({
  connectNative: (name) => chrome.runtime.connectNative(name),
  hostName: 'com.finetuneapp.finetune',
  extensionVersion: chrome.runtime.getManifest().version,
  browser: detectBrowser(navigator.userAgent, Boolean(navigator.brave)),
  timers: { setTimeout, clearTimeout, setInterval, clearInterval },
}).start();
