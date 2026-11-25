import test from "node:test";
import assert from "node:assert/strict";
import { Context, Effect, Layer, Predicate } from "effect";
import { TestClock } from "effect/testing";
import { Bridge } from "../src/bridge.ts";
import { helloMessage, pingMessage } from "../src/protocol.ts";
import { makeFakeChrome, runTest, settle, testExtensionInfo } from "./support.ts";

const start = Effect.gen(function* () {
  const fake = makeFakeChrome();
  const context = yield* Layer.build(
    Bridge.layer.pipe(Layer.provide(Layer.merge(fake.layer, testExtensionInfo))),
  );
  yield* settle;
  return { ports: fake.ports, bridge: Context.get(context, Bridge) };
});

const types = (sent: unknown[]) =>
  sent.map((m) => (Predicate.hasProperty(m, "type") ? m.type : undefined));

test("connects to the host and says hello then ping", () =>
  runTest(
    Effect.gen(function* () {
      const { ports } = yield* start;
      assert.equal(ports.length, 1);
      assert.equal(ports[0]?.name, "com.finetuneapp.finetune");
      assert.deepEqual(ports[0]?.sent, [helloMessage("0.1.0", "chrome"), pingMessage()]);
    }),
  ));

test("reconnects after a drop with growing delay, capped", () =>
  runTest(
    Effect.gen(function* () {
      const { ports } = yield* start;
      for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
        const before = ports.length;
        ports.at(-1)?.drop();
        yield* settle;
        yield* TestClock.adjust(delay - 1);
        yield* settle;
        assert.equal(ports.length, before, `no reconnect before ${delay}ms`);
        yield* TestClock.adjust(1);
        yield* settle;
        assert.equal(ports.length, before + 1, `reconnect at ${delay}ms`);
      }
    }),
  ));

test("a connection the app answered resets the backoff", () =>
  runTest(
    Effect.gen(function* () {
      const { ports } = yield* start;
      ports[0]?.drop();
      yield* settle;
      yield* TestClock.adjust(1000);
      yield* settle;
      ports[1]?.drop();
      yield* settle;
      yield* TestClock.adjust(2000);
      yield* settle;
      assert.equal(ports.length, 3);
      ports[2]?.emit({ v: 1, type: "pong" });
      yield* settle;
      ports[2]?.drop();
      yield* settle;
      yield* TestClock.adjust(1000);
      yield* settle;
      assert.equal(ports.length, 4);
    }),
  ));

test("heartbeat pings while alive and drops a host that stops answering", () =>
  runTest(
    Effect.gen(function* () {
      const { ports } = yield* start;
      ports[0]?.emit({ v: 1, type: "pong" });
      yield* settle;
      yield* TestClock.adjust(20000);
      yield* settle;
      assert.deepEqual(types(ports[0]?.sent ?? []), ["hello", "ping", "ping"]);
      assert.equal(ports[0]?.disconnected, false);
      yield* TestClock.adjust(20000);
      yield* settle;
      assert.equal(ports[0]?.disconnected, true);
    }),
  ));

test("ignores malformed and unknown inbound messages", () =>
  runTest(
    Effect.gen(function* () {
      const { ports } = yield* start;
      ports[0]?.emit("garbage");
      ports[0]?.emit({ v: 9, type: "pong" });
      ports[0]?.emit({ v: 1, type: "future" });
      yield* settle;
      assert.equal(ports[0]?.disconnected, false);
    }),
  ));

test("stops the heartbeat when the port drops", () =>
  runTest(
    Effect.gen(function* () {
      const { ports } = yield* start;
      ports[0]?.drop();
      yield* settle;
      yield* TestClock.adjust(19000);
      yield* settle;
      assert.deepEqual(types(ports[0]?.sent ?? []), ["hello", "ping"]);
      assert.equal(ports[0]?.disconnected, true);
    }),
  ));

test("send posts on the live port and is a no-op while disconnected", () =>
  runTest(
    Effect.gen(function* () {
      const { ports, bridge } = yield* start;
      yield* bridge.send(pingMessage());
      assert.equal(types(ports[0]?.sent ?? []).length, 3);
      ports[0]?.drop();
      yield* settle;
      yield* bridge.send(pingMessage());
      assert.equal(types(ports[0]?.sent ?? []).length, 3);
    }),
  ));
