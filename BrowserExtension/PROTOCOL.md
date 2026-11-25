# Browser Extension ↔ FineTune protocol

The Browser Extension talks to the FineTune app over Chrome native messaging.

```
extension ──connectNative──▶ FineTune (host mode) ──Unix socket──▶ running FineTune app
```

- Chrome launches the FineTune executable as the native messaging host `com.finetuneapp.finetune`
  and passes the extension origin (`chrome-extension://<id>/`) as the first argument.
- In host mode the process never starts the UI. It copies bytes between stdin/stdout and the app's
  socket, `~/Library/Application Support/FineTune/browser-bridge.sock` (mode `0600`), and exits when
  either side closes. If FineTune isn't running the connect fails and the host exits.
- Each host process is one connection. The app treats a Browser as connected while at least one
  connection that said `hello` for it is open.

## Framing

Same on stdin/stdout and on the socket: a 4-byte little-endian length, then that many bytes of UTF-8 JSON.
The reader rejects frames over 1 MiB.

## Messages

Every message is a JSON object with an integer `v` (protocol version, currently `1`) and a string `type`.
Other fields depend on `type`.

| type    | direction       | fields                                        | meaning                                                                                                         |
| ------- | --------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `hello` | extension → app | `extensionVersion: string`, `browser: string` | First message on every connection. `browser` is one of `chrome`, `edge`, `brave`, `arc`, `vivaldi`, `chromium`. |
| `ping`  | extension → app | none                                          | Liveness check. Sent right after `hello`, then every 20 s.                                                      |
| `pong`  | app → extension | none                                          | Answer to `ping`. The extension reconnects if a whole heartbeat interval passes with no message from the app.   |

```json
{"v":1,"type":"hello","extensionVersion":"0.1.0","browser":"chrome"}
{"v":1,"type":"ping"}
{"v":1,"type":"pong"}
```

## Evolving the protocol

- **Unknown `type`**: receivers ignore it (and keep the connection). New message types can ship
  on either side without breaking the other.
- **Unknown extra fields**: ignored.
- **Different `v`**: the message is dropped, and the connection stays open. Bump `v` only for a change that
  existing receivers can't safely ignore; new optional fields and new types don't need a bump.
- **Malformed message** (not an object, missing/ill-typed `v` or `type`, or missing required fields of a known type): dropped.
- Planned slices add, in this same envelope: tab snapshots/updates (extension → app) and
  `setMuted` / `focus` / `setVolume` commands (app → extension).

## Known limits

- `browser` is the extension's best guess from inside the service worker (user agent, `navigator.brave`).
  Arc and Chromium are indistinguishable from Chrome and report `chrome`.

## Extension ID

The unpacked extension's ID is pinned by the `key` in `manifest.json`:
`jhnijagbnendhkhdgakpcjkcikphpdfo`. It is also hard-coded in `BrowserExtensionIdentity.extensionID`
(`FineTune/BrowserBridge/`) for the host manifest's `allowed_origins`; a unit test recomputes the ID
from the manifest key so they can't drift. The matching private key is not in this repo.

To regenerate the ID from a key: take the first 16 bytes of SHA-256 over the DER-encoded public key,
write them as hex, and map the digits `0-9a-f` to `a-p`.

## Build and test

TypeScript, built with Vite, linted with oxlint, formatted with oxfmt. Uses pnpm (see `packageManager` in `package.json`).

```
cd BrowserExtension
pnpm install --frozen-lockfile
pnpm run lint && pnpm run format:check && pnpm run typecheck && pnpm test && pnpm run build
```

`pnpm run build` writes the loadable extension to `BrowserExtension/dist/` (service worker bundle plus
`manifest.json` with the pinned `key`). Load unpacked means loading `dist`, not `BrowserExtension`.
