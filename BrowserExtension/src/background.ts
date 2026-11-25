import { Effect, Layer } from "effect";
import { Bridge } from "./bridge.ts";
import { Chrome, ExtensionInfo } from "./chrome.ts";
import { detectBrowser } from "./protocol.ts";

const extensionInfo = Layer.sync(ExtensionInfo, () =>
  ExtensionInfo.of({
    hostName: "com.finetuneapp.finetune",
    extensionVersion: chrome.runtime.getManifest().version,
    browser: detectBrowser(navigator.userAgent, "brave" in navigator),
  }),
);

const main = Bridge.layer.pipe(Layer.provide(Layer.mergeAll(Chrome.layer, extensionInfo)));

Effect.runFork(Layer.launch(main));
