import test from "node:test";
import assert from "node:assert/strict";
import { VOLUME_EVENT } from "../src/content/channel.ts";
import { attachGain, installGain } from "../src/content/gain.ts";
import { makePage } from "./fake-page.ts";

test("scales an element the page already had, and the page still reads its own volume", () => {
  const { env, document, Media } = makePage();
  const video = new Media();
  video.volume = 0.8;
  document.append(video);
  const gain = installGain(env);
  gain.setVolume(0.5);
  assert.equal(video.output, 0.4);
  assert.equal(video.volume, 0.8);
  gain.setVolume(1);
  assert.equal(video.output, 0.8);
});

test("the page changing its volume composes with the tab volume instead of replacing it", () => {
  const { env, document, Media } = makePage();
  const video = new Media();
  document.append(video);
  const gain = installGain(env);
  gain.setVolume(0.5);
  video.volume = 0.6;
  assert.equal(video.volume, 0.6);
  assert.equal(video.output, 0.3);
  assert.throws(() => (video.volume = 2), RangeError);
  assert.equal(video.volume, 0.6);
  assert.equal(video.output, 0.3);
});

test("an element that was never in the page is scaled once it plays (new Audio())", () => {
  const { env, Media } = makePage();
  const gain = installGain(env);
  gain.setVolume(0.25);
  const audio = new Media();
  audio.volume = 0.5;
  void audio.play();
  assert.equal(audio.output, 0.125);
  gain.setVolume(1);
  assert.equal(audio.output, 0.5);
});

test("elements added to the page later are scaled", () => {
  const { env, document, Media } = makePage();
  const gain = installGain(env);
  gain.setVolume(0.5);
  const video = new Media();
  document.append(video);
  assert.equal(video.output, 0.5);
  gain.setVolume(0.2);
  assert.equal(video.output, 0.2);
});

test("elements inside shadow roots are scaled, including roots made later", () => {
  const { env, document, Media, Element } = makePage();
  const host = new Element();
  const early = host.attachShadow();
  const inEarly = new Media();
  early.children.push(inEarly);
  document.append(host);
  const gain = installGain(env);
  gain.setVolume(0.5);
  assert.equal(inEarly.output, 0.5);

  const later = new Element();
  const root = later.attachShadow();
  const inLater = new Media();
  root.append(inLater);
  assert.equal(inLater.output, 0.5);
});

test("at 100% nothing changes and the page's own volume writes pass straight through", () => {
  const { env, document, Media } = makePage();
  const video = new Media();
  document.append(video);
  installGain(env);
  video.volume = 0.3;
  assert.equal(video.output, 0.3);
});

test("out-of-range tab volumes are clamped", () => {
  const { env, document, Media } = makePage();
  const video = new Media();
  document.append(video);
  const gain = installGain(env);
  gain.setVolume(7);
  assert.equal(video.output, 1);
  gain.setVolume(-1);
  assert.equal(video.output, 0);
  gain.setVolume(Number.NaN);
  assert.equal(video.output, 1);
});

test("Web Audio output goes through a master gain that follows the tab volume", () => {
  const { env, AudioNode, GainNode, AudioContext } = makePage();
  const gain = installGain(env);
  gain.setVolume(0.5);
  const context = new AudioContext();
  const source = new AudioNode(context);
  const returned = source.connect(context.destination);
  assert.equal(returned, context.destination);
  const master = source.connections[0];
  assert.ok(master instanceof GainNode);
  assert.equal(master.gain.value, 0.5);
  assert.deepEqual(master.connections, [context.destination]);
  gain.setVolume(0.1);
  assert.equal(master.gain.value, 0.1);
});

test("every node of a context shares one master, other targets are untouched, disconnect follows", () => {
  const { env, AudioNode, AudioContext } = makePage();
  installGain(env);
  const context = new AudioContext();
  const a = new AudioNode(context);
  const b = new AudioNode(context);
  const filter = new AudioNode(context);
  a.connect(context.destination);
  b.connect(context.destination);
  a.connect(filter);
  assert.equal(a.connections[0], b.connections[0]);
  assert.equal(a.connections[1], filter);
  a.disconnect(context.destination);
  assert.deepEqual(a.connections, [filter]);
});

test("offline contexts are left alone", () => {
  const { env, AudioNode, OfflineAudioContext } = makePage();
  installGain(env);
  const offline = new OfflineAudioContext();
  const source = new AudioNode();
  source.connect(offline.destination);
  assert.deepEqual(source.connections, [offline.destination]);
});

test("attachGain follows volume events from the relay, ignores junk, and installs only once per frame", () => {
  const { env, document, Media } = makePage();
  const video = new Media();
  document.append(video);
  const bus = new EventTarget();
  const frame = Object.assign(env, { addEventListener: bus.addEventListener.bind(bus) });
  attachGain(frame);
  attachGain(frame);
  bus.dispatchEvent(new CustomEvent(VOLUME_EVENT, { detail: 0.5 }));
  assert.equal(video.output, 0.5);
  bus.dispatchEvent(new CustomEvent(VOLUME_EVENT, { detail: "loud" }));
  bus.dispatchEvent(new Event(VOLUME_EVENT));
  assert.equal(video.output, 0.5);
  video.volume = 0.5;
  assert.equal(video.output, 0.25);
});
