import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge.js';

function harness() {
  const ports = [];
  const timeouts = [];
  const intervals = [];
  const connectNative = (name) => {
    const port = {
      name,
      sent: [],
      disconnected: false,
      messageListeners: [],
      disconnectListeners: [],
      postMessage(m) { this.sent.push(m); },
      disconnect() { this.disconnected = true; },
      onMessage: { addListener(fn) { port.messageListeners.push(fn); } },
      onDisconnect: { addListener(fn) { port.disconnectListeners.push(fn); } },
      emit(m) { port.messageListeners.forEach((fn) => fn(m)); },
      drop() { port.disconnectListeners.forEach((fn) => fn()); },
    };
    ports.push(port);
    return port;
  };
  const timers = {
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length - 1; },
    clearTimeout: (id) => { if (timeouts[id]) timeouts[id].cleared = true; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length - 1; },
    clearInterval: (id) => { if (intervals[id]) intervals[id].cleared = true; },
  };
  const bridge = createBridge({ connectNative, hostName: 'com.finetuneapp.finetune', extensionVersion: '0.1.0', browser: 'chrome', timers });
  return { bridge, ports, timeouts, intervals };
}

test('connects to the host and says hello then ping', () => {
  const { bridge, ports } = harness();
  bridge.start();
  assert.equal(ports.length, 1);
  assert.equal(ports[0].name, 'com.finetuneapp.finetune');
  assert.deepEqual(ports[0].sent, [
    { v: 1, type: 'hello', extensionVersion: '0.1.0', browser: 'chrome' },
    { v: 1, type: 'ping' },
  ]);
});

test('reconnects after a drop with growing delay, capped', () => {
  const { bridge, ports, timeouts } = harness();
  bridge.start();
  const delays = [];
  for (let i = 0; i < 6; i++) {
    ports.at(-1).drop();
    delays.push(timeouts.at(-1).ms);
    timeouts.at(-1).fn();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 10000, 10000]);
  assert.equal(ports.length, 7);
});

test('an inbound message resets the backoff', () => {
  const { bridge, ports, timeouts } = harness();
  bridge.start();
  ports[0].drop();
  timeouts.at(-1).fn();
  ports[1].drop();
  timeouts.at(-1).fn();
  ports[2].emit({ v: 1, type: 'pong' });
  ports[2].drop();
  assert.equal(timeouts.at(-1).ms, 1000);
});

test('heartbeat pings while alive and drops a host that stops answering', () => {
  const { bridge, ports, intervals } = harness();
  bridge.start();
  const beat = intervals.at(-1);
  ports[0].emit({ v: 1, type: 'pong' });
  beat.fn();
  assert.equal(ports[0].sent.filter((m) => m.type === 'ping').length, 2);
  assert.equal(ports[0].disconnected, false);
  beat.fn();
  assert.equal(ports[0].disconnected, true);
});

test('ignores malformed and unknown inbound messages', () => {
  const { bridge, ports } = harness();
  bridge.start();
  ports[0].emit('garbage');
  ports[0].emit({ v: 9, type: 'pong' });
  ports[0].emit({ v: 1, type: 'future' });
  assert.equal(ports[0].disconnected, false);
});

test('stops the heartbeat when the port drops', () => {
  const { bridge, ports, intervals } = harness();
  bridge.start();
  ports[0].drop();
  assert.equal(intervals[0].cleared, true);
});
