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

### Tabs

A **Tab** is a browser tab that is `audible` or muted (`mutedInfo.muted`). The extension reports only those.
It sends a full `tabs` snapshot right after `hello`/`ping` on every connection, then incremental updates.

| type         | direction       | fields                       | meaning                                                                                                                                                                                 |
| ------------ | --------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs`       | extension → app | `tabs: [Tab]`                | Full snapshot. Replaces every Tab previously reported on this connection.                                                                                                               |
| `tabUpdated` | extension → app | `tab: Tab`                   | A Tab appeared or one of its fields changed.                                                                                                                                            |
| `tabRemoved` | extension → app | `tabId: int`, `closed: bool` | The tab is no longer reportable. `closed` is `true` when the tab was closed and `false` when it stopped being audible (and isn't muted). The app keeps a not-closed Tab listed for 5 s. |
| `setMuted`   | app → extension | `tabId: int`, `muted: bool`  | Mute or unmute the tab (`chrome.tabs.update`). The extension answers through the normal `tabUpdated`.                                                                                   |
| `focus`      | app → extension | `tabId: int`                 | Activate the tab and focus its window.                                                                                                                                                  |

`Tab`:

| field           | type    | notes                                                                               |
| --------------- | ------- | ----------------------------------------------------------------------------------- |
| `id`            | int     | Browser tab id. Unique within one browser session; the app also keys by connection. |
| `title`         | string  | May be empty.                                                                       |
| `site`          | string  | Hostname of the tab URL (`www.youtube.com`); empty when the URL has none.           |
| `favicon`       | string? | The tab's `favIconUrl` (http(s) or `data:` URL). Omitted when unknown.              |
| `muted`         | bool    | `mutedInfo.muted`.                                                                  |
| `windowFocused` | bool    | The tab's window is the browser's last focused window.                              |

Optional fields can be added to `Tab` without a protocol bump. Tab Volume will add `volume` and `volumeSupported`.

```json
{"v":1,"type":"tabs","tabs":[{"id":12,"title":"Song","site":"www.youtube.com","favicon":"https://www.youtube.com/favicon.ico","muted":false,"windowFocused":true}]}
{"v":1,"type":"tabRemoved","tabId":12,"closed":false}
{"v":1,"type":"setMuted","tabId":12,"muted":true}
{"v":1,"type":"focus","tabId":12}
```

One extension instance runs per browser profile, so a Browser with several profiles opens several connections.
The app merges their Tabs into one flat list. A connection's Tabs are cleared when it closes.

## Evolving the protocol

- **Unknown `type`**: receivers ignore it (and keep the connection). New message types can ship
  on either side without breaking the other.
- **Unknown extra fields**: ignored.
- **Different `v`**: the message is dropped, and the connection stays open. Bump `v` only for a change that
  existing receivers can't safely ignore; new optional fields and new types don't need a bump.
- **Malformed message** (not an object, missing/ill-typed `v` or `type`, or missing required fields of a known type): dropped.
- A planned slice adds a `setVolume` command (app → extension) in this same envelope.

## Known limits

- `browser` is the extension's best guess from inside the service worker (user agent, `navigator.brave`).
  Arc and Chromium are indistinguishable from Chrome and report `chrome`. The app therefore prefers the
  bundle ID of the process that launched the host (the browser) over `hello.browser` when it can read it,
  and falls back to `hello.browser` otherwise.

## Extension ID

The unpacked extension's ID is pinned by the `key` in `manifest.json`:
`jhnijagbnendhkhdgakpcjkcikphpdfo`. It is also hard-coded in `BrowserExtensionIdentity.extensionID`
(`FineTune/BrowserBridge/`) for the host manifest's `allowed_origins`; a unit test recomputes the ID
from the manifest key so they can't drift. The matching private key is not in this repo.

To regenerate the ID from a key: take the first 16 bytes of SHA-256 over the DER-encoded public key,
write them as hex, and map the digits `0-9a-f` to `a-p`.

## Build and test

TypeScript on Effect, built with Vite, linted with oxlint (type-aware, with the Effect rules from `@effect/tsgo`),
formatted with oxfmt. Uses pnpm (see `packageManager` in `package.json`).

`pnpm install` runs `effect-tsgo patch --oxlint` (the `prepare` script), which patches the installed TypeScript 7
and oxlint binaries in `node_modules`. `@effect/tsgo`, `oxlint`, `oxlint-tsgolint` and `typescript` are pinned to exact
versions from the supported matrix of that `@effect/tsgo` release; bump them together.

```
cd BrowserExtension
pnpm install --frozen-lockfile
pnpm run lint && pnpm run format:check && pnpm run typecheck && pnpm test && pnpm run build
```

`pnpm run build` writes the loadable extension to `BrowserExtension/dist/` (service worker bundle plus
`manifest.json` with the pinned `key`). Load unpacked means loading `dist`, not `BrowserExtension`.
