// Message format shared with the FineTune app. See PROTOCOL.md.
export const PROTOCOL_VERSION = 1;

export const helloMessage = (extensionVersion, browser) => ({
  v: PROTOCOL_VERSION, type: 'hello', extensionVersion, browser,
});

export const pingMessage = () => ({ v: PROTOCOL_VERSION, type: 'ping' });

// Returns { type: 'pong' } or { type: 'unknown', unknownType }; throws on a bad version or shape.
export function parseMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)
      || !Number.isInteger(message.v) || typeof message.type !== 'string') {
    throw new Error('malformed message');
  }
  if (message.v !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${message.v}`);
  }
  return message.type === 'pong' ? { type: 'pong' } : { type: 'unknown', unknownType: message.type };
}

// Best effort from inside a service worker: Arc and Chromium look exactly like Chrome and report 'chrome'.
export function detectBrowser(userAgent, isBrave) {
  if (isBrave) return 'brave';
  if (/\bEdg\//.test(userAgent)) return 'edge';
  if (/\bVivaldi\//.test(userAgent)) return 'vivaldi';
  return 'chrome';
}
