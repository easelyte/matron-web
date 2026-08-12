# Matron Web

Matron Web is the browser client for [Matron](https://matron.chat), an open-source system that turns the Claude Code and Codex sessions running on your machines into chats you can follow and reply to from anywhere. It talks directly to a [matron-journal](https://github.com/Matronhq/matron-journal) server — no Matrix, no homeserver, no accounts on anyone else's infrastructure.

## You'll need

- A [matron-journal](https://github.com/Matronhq/matron-journal) server (self-hosted, Node + SQLite)
- A [matron-bridge](https://github.com/Matronhq/matron-bridge) running beside each agent CLI you want to see

Sign in with your journal server URL, username, and password. (Web has no QR device linking — that's native-app only.)

## Architecture

React + TypeScript, built with webpack.

- HTTP login, snapshots, conversation pagination, and authenticated media.
- One resumable WebSocket connection for ordered journal frames and ephemeral streams.
- IndexedDB storage for cursors, conversation summaries, lazy-loaded events, and the idempotent send outbox.
- A single responsive React interface — [Matron Desktop](https://github.com/Matronhq/matron-desktop) packages this repo's build output.

The renderer supports text, prompts and permission requests, prompt replies, tool output, diffs, files, images, activity, and session status, plus subagent threads, token-usage and rate-limit headers, archive and read/unread controls, attachments, slash commands, voice capture, and light/dark themes. Unknown event types receive a JSON fallback.

## Development

Requires Node 22.18+ (`.node-version` pins 24) and the pnpm version pinned in `package.json`.

```bash
corepack enable
pnpm install
pnpm start
```

The development server runs at `http://127.0.0.1:8080` and proxies `/journal` to `http://127.0.0.1:9810`. Set `MATRON_JOURNAL_URL` or `MATRON_WEB_PORT` to override either value; both are also read from a `.env` file in the repo root.

Run all checks with:

```bash
pnpm lint
pnpm test
pnpm build
```

CI runs `pnpm lint` and `pnpm test` on every PR.

## Deployment

`pnpm build` writes a static application to `webapp/`. A browser deployment should normally proxy `/journal/` to matron-journal on the same origin and configure:

```json
{
    "brand": "Matron",
    "journal_server_url": "/journal"
}
```

`config.json` is copied into the build output, so edit it before `pnpm build` (or edit `webapp/config.json` after). `config.sample.json` shows the full key set; see [docs/config.md](docs/config.md) for the complete runtime configuration surface.

## License

Licensed under AGPL-3.0-only or GPL-3.0-only, at your option. See [LICENSE-AGPL-3.0](LICENSE-AGPL-3.0) and [LICENSE-GPL-3.0](LICENSE-GPL-3.0).

Some implementation and visual-shell code originated in Element Web — provenance and retained notices: [ORIGIN.md](ORIGIN.md).
