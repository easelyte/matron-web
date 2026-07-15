# Matron Web

Matron Web is the browser client for Matron, a chat system for talking to agents. It speaks the lightweight [matron-journal](https://github.com/Matronhq/matron-journal) protocol directly; the application has no Matrix client or homeserver dependency.

The current source tree is the focused Matron client. Some implementation and visual-shell code originated in Element Web; see [ORIGIN.md](ORIGIN.md) for provenance and retained notices.

## Architecture

- HTTP login, snapshots, conversation pagination, and authenticated media.
- One resumable WebSocket connection for ordered journal frames and ephemeral streams.
- IndexedDB storage for cursors, conversation summaries, lazy-loaded events, and the idempotent send outbox.
- A single responsive React interface shared with [Matron Desktop](https://github.com/Matronhq/matron-desktop).

The renderer supports text, prompts and permission requests, prompt replies, tool output, diffs, files, images, activity, and session status. Unknown event types receive a JSON fallback.

## Development

Requires Node 22.18+ and the pnpm version pinned in `package.json`.

```bash
corepack enable
pnpm install
pnpm start
```

The development server runs at `http://127.0.0.1:8080` and proxies `/journal` to `http://127.0.0.1:9810`. Set `MATRON_JOURNAL_URL` or `MATRON_WEB_PORT` to override either value.

Run all checks with:

```bash
pnpm lint
pnpm test
pnpm build
```

## Deployment

`pnpm build` writes a static application to `webapp/`. A browser deployment should normally proxy `/journal/` to matron-journal on the same origin and configure:

```json
{
    "brand": "Matron",
    "journal_server_url": "/journal"
}
```

See [docs/config.md](docs/config.md) for the complete runtime configuration surface.

## License

Licensed under AGPL-3.0-only or GPL-3.0-only, at your option. See [LICENSE-AGPL-3.0](LICENSE-AGPL-3.0) and [LICENSE-GPL-3.0](LICENSE-GPL-3.0).
