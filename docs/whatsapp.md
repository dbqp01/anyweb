# AnyWeb MCP — WhatsApp connector

Read-only MCP bridge to the user's own paired WhatsApp account. This dedicated connector handles the multi-device WebSocket protocol; the generic `propose` command only supports replayable HTTP operations.

## Risks

- Unofficial protocol. WhatsApp Terms may prohibit it and the account can be restricted.
- The connector never sends messages, presence updates or read receipts, and never downloads media.
- The snapshot is recent history plus live events, capped at 1000 chats and 200 messages per chat. It is not an archive.
- The paired-device keys in the auth directory are secrets. Do not copy or commit them.

## Pair

```bash
node src/cli.mjs whatsapp login
```

Scan the QR with **WhatsApp → Dispositivos vinculados → Vincular un dispositivo**. The command waits for the initial sync and prints a JSON status. The auth directory defaults to `~/.web2api/connectors/whatsapp/auth`; override it with `--auth-dir` or `WEB2API_WHATSAPP_AUTH`.

Check or unlink:

```bash
node src/cli.mjs whatsapp status
node src/cli.mjs whatsapp logout --yes
```

`logout` unlinks the device when it can reach WhatsApp and always deletes the local auth and snapshot. If it cannot reach WhatsApp, remove the device from the phone as well.

## Package and register

```bash
node src/cli.mjs whatsapp package
```

This writes a standalone bundle and registration snippet under `~/.web2api/connectors/whatsapp/dist/`:

- `anyweb-whatsapp.mjs` — bundle (Baileys included)
- `.mcp.json` — snippet with the absolute bundle and auth paths
- `evidence.json` — hashes, tool list and limits, no chat data
- `README.md`

The bundle loads Baileys' CJS `libsignal`, so it injects `createRequire` into the ESM output. It contains no Playwright.

## Tools

All tools are read-only (`readOnlyHint: true`).

| Tool | Input | Output |
|---|---|---|
| `whatsapp_status` | — | pairing state, counts, oldest/newest message |
| `whatsapp_list_chats` | `limit` (1..200, default 50) | chats by recent activity |
| `whatsapp_get_messages` | `chat_id`, `limit` | newest messages in chronological order |
| `whatsapp_search_messages` | `query`, optional `chat_id`, `limit` | case-insensitive text matches with chat name |

Without a pairing, read tools return `SESSION_NOT_CONFIGURED`. A logged-out device returns `REAUTH_REQUIRED`; a connection that is still starting returns `SESSION_NOT_READY`.

## Storage

`store.json` lives next to the auth files and is rewritten with a one-second debounce. It stores normalized message metadata and text (4 KB cap per message), not media. Deleting the auth directory removes the snapshot too.
