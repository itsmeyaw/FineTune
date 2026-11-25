import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, helloMessage, pingMessage, parseMessage, detectBrowser } from '../protocol.js';

test('hello carries version, extension version and browser', () => {
  assert.deepEqual(helloMessage('0.1.0', 'edge'), {
    v: 1, type: 'hello', extensionVersion: '0.1.0', browser: 'edge',
  });
  assert.equal(PROTOCOL_VERSION, 1);
});

test('ping is versioned', () => {
  assert.deepEqual(pingMessage(), { v: 1, type: 'ping' });
});

test('parseMessage accepts pong', () => {
  assert.deepEqual(parseMessage({ v: 1, type: 'pong' }), { type: 'pong' });
});

test('parseMessage reports unknown types instead of throwing', () => {
  assert.deepEqual(parseMessage({ v: 1, type: 'tabSnapshot' }), { type: 'unknown', unknownType: 'tabSnapshot' });
});

test('parseMessage rejects a bad version', () => {
  assert.throws(() => parseMessage({ v: 2, type: 'pong' }), /unsupported protocol version 2/);
});

test('parseMessage rejects malformed input', () => {
  for (const bad of [null, 'x', [], {}, { v: 1 }, { v: 1, type: 5 }, { type: 'pong' }]) {
    assert.throws(() => parseMessage(bad), /malformed/);
  }
});

test('detectBrowser tells Edge, Brave and Vivaldi from Chrome', () => {
  const chrome = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  assert.equal(detectBrowser(chrome, false), 'chrome');
  assert.equal(detectBrowser(`${chrome} Edg/130.0.0.0`, false), 'edge');
  assert.equal(detectBrowser(chrome, true), 'brave');
  assert.equal(detectBrowser(`${chrome} Vivaldi/7.0`, false), 'vivaldi');
});
