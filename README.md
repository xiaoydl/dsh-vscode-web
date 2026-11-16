# dsh-vscode-web

Open a session's workspace in **VS Code's own web server** from DeepSeek
Harness — no code-server install, no second VS Code copy, no extra runtime.
The plugin drives the `code serve-web` command that ships with the desktop
VS Code you already have.

## What it does

- **Two entry points**, both one click:
  - the small icon button in a sidebar session row's hover strip;
  - the same button in the conversation's top-right session toolbar.
- The Host resolves that session's workspace directory, starts
  `code serve-web` on first use (one shared process for every workspace), and
  answers with `…/?folder=<workspace>`.
- On **DSH Desktop** the workbench opens in a right-sidebar Browser tab
  (Electron `<webview>`, which the server's `X-Frame-Options` does not block).
  In a browser it opens in a new tab — that is the only way round VS Code's
  refusal to be framed. The new tab is opened inside the click and then
  navigated, so a slow first start does not trip the pop-up blocker.
- The server is stopped when the plugin is disabled or its Host fiber is
  disposed (including a normal DSH exit).

## Two-way bridge (VS Code → DSH)

The plugin installs a tiny VS Code extension into the server's own extension
folder (`<dataDir>/extensions/dsh-bridge`) before it starts the server. The
extension runs in the server-side extension host on this machine and adds two
editor context-menu commands:

| Command | Result in DSH |
|---|---|
| **Send selection to DSH session** | the selection becomes a native **quote** in the session's composer (same thing as quoting a chat message) |
| **Add this file to DSH session** | `@<path>:<line>` is inserted at the caret, so the model can read it |

Delivery: the extension POSTs to `/dsh-vscode-web/api/bridge` with a
per-process token written next to it in `bridge.json`; the Host resolves which
workspace owns the file, picks the session that last opened VS Code there, and
pushes the event to the page over server-sent events
(`/dsh-vscode-web/api/events`). A small status row under the composer reports
what was inserted and disappears after a few seconds.

Everything lands in the **draft** first — visible, editable, deletable — so
nothing reaches the model unnoticed.

## Requirements

- VS Code with its CLI: on Windows the shipped
  `<VS Code install>\bin\code-tunnel.exe`; on macOS/Linux the `code` launcher
  on `PATH`. Set the plugin row's `command` to override discovery.
- A VS Code recent enough for `serve-web` (1.82+).
- The very first `serve-web` run prepares VS Code's web-server runtime under
  `~/.vscode/cli/serve-web` (a few hundred MB); later starts are immediate.

## Install

Add this directory as a local bundle from the profile's plugin manager (it
links the checkout, so edits apply after a page refresh), or:

```sh
dsh plugin --profile <profile> add /path/to/dsh-vscode-web
```

Then restart the Host and refresh the page.

## Row configuration

There is no Config schema: the options below are read from the row's `config`
and documented rather than validated, so keep them well-formed YAML.

| Option | Meaning |
|---|---|
| `command` | Absolute path to `code-tunnel.exe` / `code`. Empty = auto-discover. |
| `port` | First port to try (default `8765`; walks up to 50 ports). |
| `dataDir` | Server data directory (default `~/.dsh-vscode-web/server`). |
| `extraArgs` | Extra `serve-web` arguments, as a string array. |
| `settings` | Object merged into the server's machine settings (`<dataDir>/data/Machine/settings.json`) on every start. Use it for workbench settings that must survive a restart, another browser, or a port change — the web workbench keeps its "User" settings in browser-local storage, which does not. |

```yaml
- id: dsh-vscode-web
  name: 'dsh-vscode-web'
  config:
    port: 8765
```

## Security

`serve-web` listens on `127.0.0.1` and, by default, runs with
`--without-connection-token`, so any local process that can reach that port
also reaches the workbench and its integrated terminal. Add
`extraArgs: ["--connection-token-file", "<path>"]` if that matters on your
machine.

## Routes

`/dsh-vscode-web/api/open` (POST `{sessionId}`),
`/dsh-vscode-web/api/status` (GET), `/dsh-vscode-web/api/stop` (POST).
All are fenced by the Host's connection policy.

## Copy

`locale/en.json` and `locale/zh.json` carry the plugin-manager metadata that
Settings and the Plugins page render. The in-app strings (button labels, the
waiting page, error text) live in `client.js` and are registered with the
Client locale service at activation.
