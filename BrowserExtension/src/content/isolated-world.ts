import { startRelay } from "./relay.ts";

const key = Symbol.for("finetune.relay");
if (!Reflect.has(globalThis, key)) {
  Reflect.defineProperty(globalThis, key, { value: true });
  startRelay(chrome.runtime, globalThis);
}
