import { Deferred, Effect, Exit, Layer, Queue, Stream } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { Chrome, ExtensionInfo } from "../src/chrome.ts";

export interface FakePort {
  readonly name: string;
  readonly sent: unknown[];
  disconnected: boolean;
  /** The app sends a message. */
  readonly emit: (message: unknown) => void;
  /** The app side goes away. */
  readonly drop: () => void;
}

/** Fakes chrome.* for tests; `ports` lists every native connection opened so far. */
export function makeFakeChrome() {
  const ports: FakePort[] = [];
  const layer = Layer.succeed(
    Chrome,
    Chrome.of({
      connectNative: (name) =>
        Effect.gen(function* () {
          const inbox = yield* Queue.unbounded<unknown>();
          const closed = yield* Deferred.make<void>();
          const port: FakePort = {
            name,
            sent: [],
            disconnected: false,
            emit: (message) => Queue.offerUnsafe(inbox, message),
            drop: () => Deferred.doneUnsafe(closed, Exit.void),
          };
          ports.push(port);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              port.disconnected = true;
            }),
          );
          return {
            send: (message) =>
              Effect.sync(() => {
                port.sent.push(message);
              }),
            messages: Stream.fromQueue(inbox),
            closed: Deferred.await(closed),
          };
        }),
    }),
  );
  return { ports, layer };
}

export const testExtensionInfo = Layer.succeed(
  ExtensionInfo,
  ExtensionInfo.of({
    hostName: "com.finetuneapp.finetune",
    extensionVersion: "0.1.0",
    browser: "chrome",
  }),
);

/** Lets forked fibers run until they wait on something. */
export const settle = Effect.repeat(Effect.yieldNow, { times: 20 });

/** Runs a test program on virtual time. */
export const runTest = <A, E>(program: Effect.Effect<A, E, TestClock.TestClock | Scope.Scope>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestClock.layer())));
