// Message format shared with the FineTune app. See PROTOCOL.md.
import { Effect, Schema } from "effect";

export const PROTOCOL_VERSION = 1;

const Version = Schema.Literal(PROTOCOL_VERSION);

export const BrowserName = Schema.Literals([
  "chrome",
  "edge",
  "brave",
  "arc",
  "vivaldi",
  "chromium",
]);
export type BrowserName = typeof BrowserName.Type;

export const Hello = Schema.Struct({
  v: Version,
  type: Schema.Literal("hello"),
  extensionVersion: Schema.String,
  browser: BrowserName,
});
export const Ping = Schema.Struct({ v: Version, type: Schema.Literal("ping") });

/** A browser tab that makes sound or that the user muted. Optional fields can be added without a protocol bump. */
export const Tab = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  site: Schema.String,
  favicon: Schema.optionalKey(Schema.String),
  muted: Schema.Boolean,
  windowFocused: Schema.Boolean,
});
export type Tab = typeof Tab.Type;

export const TabsSnapshot = Schema.Struct({
  v: Version,
  type: Schema.Literal("tabs"),
  tabs: Schema.Array(Tab),
});
export const TabUpdated = Schema.Struct({
  v: Version,
  type: Schema.Literal("tabUpdated"),
  tab: Tab,
});
export const TabRemoved = Schema.Struct({
  v: Version,
  type: Schema.Literal("tabRemoved"),
  tabId: Schema.Int,
  closed: Schema.Boolean,
});

export const OutboundMessage = Schema.Union([Hello, Ping, TabsSnapshot, TabUpdated, TabRemoved]);
export type OutboundMessage = typeof OutboundMessage.Type;

export const helloMessage = (extensionVersion: string, browser: BrowserName): OutboundMessage => ({
  v: PROTOCOL_VERSION,
  type: "hello",
  extensionVersion,
  browser,
});

export const pingMessage = (): OutboundMessage => ({ v: PROTOCOL_VERSION, type: "ping" });

export const tabsMessage = (tabs: ReadonlyArray<Tab>): OutboundMessage => ({
  v: PROTOCOL_VERSION,
  type: "tabs",
  tabs,
});

export const tabUpdatedMessage = (tab: Tab): OutboundMessage => ({
  v: PROTOCOL_VERSION,
  type: "tabUpdated",
  tab,
});

export const tabRemovedMessage = (tabId: number, closed: boolean): OutboundMessage => ({
  v: PROTOCOL_VERSION,
  type: "tabRemoved",
  tabId,
  closed,
});

export const encodeOutbound = Schema.encodeEffect(OutboundMessage);

export const Pong = Schema.Struct({ v: Version, type: Schema.Literal("pong") });

export const SetMuted = Schema.Struct({
  v: Version,
  type: Schema.Literal("setMuted"),
  tabId: Schema.Int,
  muted: Schema.Boolean,
});
export const Focus = Schema.Struct({
  v: Version,
  type: Schema.Literal("focus"),
  tabId: Schema.Int,
});

/** What the app asks the extension to do with a tab. */
export type Command = typeof SetMuted.Type | typeof Focus.Type;
export const isCommand = (message: InboundMessage): message is Command =>
  message.type === "setMuted" || message.type === "focus";

const KnownInbound = Schema.Union([Pong, SetMuted, Focus]);
const KNOWN_TYPES: ReadonlySet<string> = new Set(["pong", "setMuted", "focus"]);

export type InboundMessage =
  | typeof KnownInbound.Type
  | { readonly type: "unknown"; readonly unknownType: string };

export class MalformedMessage extends Schema.TaggedError<
  MalformedMessage,
  { readonly brand: unique symbol }
>()("MalformedMessage", {}) {}

export class UnsupportedVersion extends Schema.TaggedError<
  UnsupportedVersion,
  { readonly brand: unique symbol }
>()("UnsupportedVersion", { version: Schema.Int }) {}

const Envelope = Schema.Struct({ v: Schema.Int, type: Schema.String });
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope);
const decodeKnown = Schema.decodeUnknownEffect(KnownInbound);

// A bad shape or a known type with bad fields is malformed, another version is unsupported,
// and a well-formed message of a type this build doesn't know is reported as `unknown`.
export const parseMessage = Effect.fn("parseMessage")(function* (
  raw: unknown,
): Effect.fn.Return<InboundMessage, MalformedMessage | UnsupportedVersion> {
  const { v, type } = yield* decodeEnvelope(raw).pipe(
    Effect.mapError(() => new MalformedMessage()),
  );
  if (v !== PROTOCOL_VERSION) return yield* new UnsupportedVersion({ version: v });
  if (!KNOWN_TYPES.has(type)) return { type: "unknown", unknownType: type } as const;
  return yield* decodeKnown(raw).pipe(Effect.mapError(() => new MalformedMessage()));
});

// Best effort from inside a service worker: Arc and Chromium look exactly like Chrome and report 'chrome'.
export function detectBrowser(userAgent: string, isBrave: boolean): BrowserName {
  if (isBrave) return "brave";
  if (/\bEdg\//.test(userAgent)) return "edge";
  if (/\bVivaldi\//.test(userAgent)) return "vivaldi";
  return "chrome";
}
