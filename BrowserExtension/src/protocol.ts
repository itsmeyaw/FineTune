// Message format shared with the FineTune app. See PROTOCOL.md.
export const PROTOCOL_VERSION = 1;

export type BrowserName = "chrome" | "edge" | "brave" | "arc" | "vivaldi" | "chromium";

export interface HelloMessage {
  v: number;
  type: "hello";
  extensionVersion: string;
  browser: BrowserName;
}

export interface PingMessage {
  v: number;
  type: "ping";
}

export const helloMessage = (extensionVersion: string, browser: BrowserName): HelloMessage => ({
  v: PROTOCOL_VERSION,
  type: "hello",
  extensionVersion,
  browser,
});

export const pingMessage = (): PingMessage => ({ v: PROTOCOL_VERSION, type: "ping" });

export type InboundMessage = { type: "pong" } | { type: "unknown"; unknownType: string };

// Returns { type: 'pong' } or { type: 'unknown', unknownType }; throws on a bad version or shape.
export function parseMessage(message: unknown): InboundMessage {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("malformed message");
  }
  const { v, type } = message as { v?: unknown; type?: unknown };
  if (typeof v !== "number" || !Number.isInteger(v) || typeof type !== "string") {
    throw new Error("malformed message");
  }
  if (v !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${v}`);
  }
  return type === "pong" ? { type: "pong" } : { type: "unknown", unknownType: type };
}

// Best effort from inside a service worker: Arc and Chromium look exactly like Chrome and report 'chrome'.
export function detectBrowser(userAgent: string, isBrave: boolean): BrowserName {
  if (isBrave) return "brave";
  if (/\bEdg\//.test(userAgent)) return "edge";
  if (/\bVivaldi\//.test(userAgent)) return "vivaldi";
  return "chrome";
}
