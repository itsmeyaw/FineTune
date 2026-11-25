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

export const OutboundMessage = Schema.Union([Hello, Ping]);
export type OutboundMessage = typeof OutboundMessage.Type;

export const helloMessage = (extensionVersion: string, browser: BrowserName): OutboundMessage => ({
  v: PROTOCOL_VERSION,
  type: "hello",
  extensionVersion,
  browser,
});

export const pingMessage = (): OutboundMessage => ({ v: PROTOCOL_VERSION, type: "ping" });

export const encodeOutbound = Schema.encodeEffect(OutboundMessage);

export const Pong = Schema.Struct({ v: Version, type: Schema.Literal("pong") });

const KnownInbound = Schema.Union([Pong]);
const KNOWN_TYPES: ReadonlySet<string> = new Set(["pong"]);

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
