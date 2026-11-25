// Thin edge over chrome.*; everything else talks to this service so tests can fake it.
import { Context, Deferred, Effect, Exit, Layer, Queue, Stream } from "effect";
import type { Scope } from "effect";
import type { BrowserName } from "./protocol.ts";

export interface NativePort {
  readonly send: (message: unknown) => Effect.Effect<void>;
  readonly messages: Stream.Stream<unknown>;
  /** Completes when the other side disconnects. */
  readonly closed: Effect.Effect<void>;
}

export class Chrome extends Context.Service<
  Chrome,
  {
    /** Connects to the native messaging host; the port is disconnected when the scope closes. */
    readonly connectNative: (hostName: string) => Effect.Effect<NativePort, never, Scope.Scope>;
  }
>()("finetune/Chrome") {
  static readonly layer = Layer.succeed(
    Chrome,
    Chrome.of({
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
    }),
  );
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
