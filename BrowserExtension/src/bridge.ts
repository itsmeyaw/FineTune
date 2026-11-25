// Keeps one native messaging connection to the FineTune app alive.
import { Context, Effect, Layer, Queue, Ref, Schedule, Schema, Stream } from "effect";
import { Chrome, ExtensionInfo } from "./chrome.ts";
import type { NativePort } from "./chrome.ts";
import { encodeOutbound, helloMessage, isCommand, parseMessage, pingMessage } from "./protocol.ts";
import type { Command, OutboundMessage } from "./protocol.ts";

const BASE_DELAY = "1 second";
const MAX_DELAY = "10 seconds";
const HEARTBEAT = "20 seconds";

/** A session ended without the app ever answering. */
export class NoResponse extends Schema.TaggedError<NoResponse, { readonly brand: unique symbol }>()(
  "NoResponse",
  {},
) {}

// 1s, 2s, 4s, 8s, then 10s between attempts.
const reconnectBackoff = Schedule.min([
  Schedule.exponential(BASE_DELAY),
  Schedule.spaced(MAX_DELAY),
]);

const sendOn = (port: NativePort, message: OutboundMessage) =>
  encodeOutbound(message).pipe(Effect.flatMap(port.send), Effect.orDie);

export class Bridge extends Context.Service<
  Bridge,
  {
    /** Sends to the app; a no-op while disconnected. */
    readonly send: (message: OutboundMessage) => Effect.Effect<void>;
    /** Emits each time a connection to the app is established; consume with one reader. */
    readonly connected: Stream.Stream<void>;
    /** Commands from the app; consume with one reader. */
    readonly commands: Stream.Stream<Command>;
  }
>()("finetune/Bridge") {
  static readonly layer = Layer.effect(
    Bridge,
    Effect.gen(function* () {
      const chrome = yield* Chrome;
      const info = yield* ExtensionInfo;
      const current = yield* Ref.make<NativePort | undefined>(undefined);
      const connected = yield* Queue.unbounded<void>();
      const commands = yield* Queue.unbounded<Command>();

      const session = Effect.gen(function* () {
        const port = yield* chrome.connectNative(info.hostName);
        const heardSinceBeat = yield* Ref.make(false);
        const everHeard = yield* Ref.make(false);
        yield* Ref.set(current, port);
        yield* Effect.addFinalizer(() => Ref.set(current, undefined));
        yield* sendOn(port, helloMessage(info.extensionVersion, info.browser));
        yield* sendOn(port, pingMessage());
        yield* Queue.offer(connected, undefined);

        const listen = port.messages.pipe(
          Stream.runForEach((raw) =>
            parseMessage(raw).pipe(
              Effect.tap(() => Ref.set(heardSinceBeat, true)),
              Effect.tap(() => Ref.set(everHeard, true)),
              Effect.flatMap((message) =>
                isCommand(message) ? Queue.offer(commands, message) : Effect.void,
              ),
              Effect.ignore,
            ),
          ),
        );

        const beat = Effect.gen(function* () {
          if (yield* Ref.getAndSet(heardSinceBeat, false))
            return yield* sendOn(port, pingMessage());
          return yield* new NoResponse();
        });
        const heartbeat = Effect.sleep(HEARTBEAT).pipe(
          Effect.andThen(beat.pipe(Effect.repeat(Schedule.spaced(HEARTBEAT)))),
        );

        yield* Effect.raceFirst(
          port.closed,
          Effect.all([listen, heartbeat], { concurrency: "unbounded", discard: true }),
        ).pipe(Effect.catchTag("NoResponse", () => Effect.void));
        // A connection the app answered counts as healthy, however it ended.
        if (yield* Ref.get(everHeard)) return yield* Effect.void;
        return yield* new NoResponse();
      }).pipe(Effect.scoped);

      yield* session.pipe(
        Effect.retry(reconnectBackoff),
        Effect.andThen(Effect.sleep(BASE_DELAY)),
        Effect.forever,
        Effect.forkScoped,
      );

      const send = (message: OutboundMessage) =>
        Ref.get(current).pipe(
          Effect.flatMap((port) => (port === undefined ? Effect.void : sendOn(port, message))),
        );
      return Bridge.of({
        send,
        connected: Stream.fromQueue(connected),
        commands: Stream.fromQueue(commands),
      });
    }),
  );
}
