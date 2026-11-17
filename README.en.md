# dsh-relay-client

> Let DeepSeek Harness sessions talk to each other — on the same machine, or across a LAN.

[中文](./README.md) · [Architecture](./docs/ARCHITECTURE.md) · [Contract](./docs/CONTRACT.md) · [Install](./docs/INSTALL.md) · [Verification](./docs/VERIFICATION.md)

[![npm](https://img.shields.io/npm/v/dsh-relay-client?color=CB3837)](https://www.npmjs.com/package/dsh-relay-client)
[![License](https://img.shields.io/github/license/chenvinc/dsh-relay-client?color=4B6EF5)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](./package.json)

## What it does

When several DSH sessions work in parallel, passing messages between them usually means GitHub issues, shared files, or manual copy-paste. This plugin turns that into a single tool call:

- Each session binds a logical name via `relay_bind` (e.g. `po`, `fe`, `macbook/dsh-proj/backend`)
- `relay_send` messages to another session, with `to` and `cc` addressing
- A background poller picks up messages from the local panel inbox and **injects them into the target session** (`Agent.followup` → `steer` → `inbox` fallback chain)
- Three-part addresses `machine / workspace / alias` route across machines via the panel federation layer; the plugin only talks to the local panel

The plugin **does not patch the DSH core or any other plugin** — it installs itself via a bundle patch.

## Prerequisites

A **locally running pcpanel** providing `/api/relay/*` (default `http://127.0.0.1:8765`).
For cross-machine messaging, the peer machine must also run a panel, auto-discovered over UDP 8766 and linked in the address book (see [Install](./docs/INSTALL.md)).

Without a panel the plugin still loads, but `relay_send` fails — the panel is the "carrier" and the plugin is just a "phone".

## Install

```bash
npm install -g dsh-relay-client
```

Then add the bundle patch to your DSH profile and configure `base` / `machine_id` / `workspace` per [INSTALL.md](./docs/INSTALL.md).
`machine_id` **must exactly match the local panel's `config.relay.machine_id`**, or cross-machine addressing will fail.

## Tools

| Tool | Purpose |
|---|---|
| `relay_bind` | Bind the current session to a logical name (sessionId auto-detected when called in-session) |
| `relay_unbind` | Unregister one of this session's aliases |
| `relay_forget` | Remove a known node from the address book |
| `relay_send` | Send a message with `to` / `cc` three-part addressing, `type`, `thread` |

## HTTP endpoints

- `GET /relay-client/status` — current bindings and connection state
- `POST /relay-client/bind` / `/unbind` — explicit bind/unbind (pass `session_id`)

## Design notes

- **Control plane / data plane split**: the panel only handles registry, addressing and audit; message injection uses DSH's native `Agent.followup`
- **Explicit identity**: background timers have no "current session", so logical names must be declared via `relay_bind` or the HTTP endpoint
- **Recoverable state**: bindings live in `~/.dsh/state/relay-client/state.json` (override with `RELAY_CLIENT_STATE_DIR`) and survive restarts
- **No token auth on LAN** (same as the panel); put it behind an authenticated reverse proxy if exposing publicly

## Verification

```bash
npm test                   # 64 mock tests, no real DSH / panel needed
npm run test:integration   # real link, requires a running pcpanel relay service
```

## License

MIT © chenvinc
