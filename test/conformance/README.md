# Conformance runner (client role)

The web app as a platform runner for the shared journal conformance fixtures. A
replay coordinator (in the journal repository) boots a seeded journal per fixture,
plays the agent and admin roles, and drives this runner over stdio; the runner
performs the `client` steps through the app's own code.

## Run

```
MATRON_CONFORMANCE_COORDINATOR=<checkout with tools/conformance-server.js> \
MATRON_CONFORMANCE_TARBALL=<packed conformance .tgz> \
pnpm conformance [fixture-name-substring ...]
```

`pnpm test` also replays the decoder extracts (`conformance-extracts-test.ts`) when
`MATRON_CONFORMANCE_TARBALL` or `MATRON_CONFORMANCE_DIR` is set, and skips them otherwise.

The package is pinned in `package-pin.json` (version and a digest of the package's
index file). It is a local tarball for now and switches to a released version once the
journal publishes one.

## What is real

- HTTP goes through `JournalApi`'s request layer.
- Every WebSocket frame goes through `decodeServerFrame`, then into a real
  `MatronJournalClient` and `JournalDatabase` (fake-indexeddb) and a real
  `DesktopNotifier` with a fake `Notification` and document.
- `reconnect_from_cursor` resumes from the store's own cursor.

Not covered yet: `JournalConnection` (its own hello, retry and batching), because
fixtures send hello frames of their own choosing. `disconnect` closes the socket
cleanly. `advance_clock` moves the notifier's clock (staleness, mute expiry), not timers.
An error response shows only a `retry-after` header (from the 429 retry time).

## Test hook

`expect_model` matches this object:

```
{ cursor, app, muted,
  conversations: [{ id, title, session_state, last_seq, unread_count, snippet }],
  events: { <convo_id>: [{ seq, type, sender }] },
  tool_streams: { <convo_id>: { <message_ref>: { content, offset, ... } } },
  activities: { <convo_id>: { state, detail? } } }
```

`expect_notification` matches the decision for the latest journal row the client newly applied:

```
{ shown, convo_id, seq, title?, body?, silent? }
```

`set_app_state` sets `app` (`foreground` or `background`, what the notifier sees as
the document's visibility and focus) and `muted` (mutes or unmutes every known
conversation through the notifier's own settings write, which needs a journal with the
notification settings route).

A `viewing` frame the fixture sends also sets the client's open conversation (what the
app does when a conversation is on screen), which the notifier reads: in the foreground a
notification for the open conversation is not shown.

## Known limits of the harness

The coordinator waits 10 seconds for a runner to report ready. With a cold jest
transform cache the first fixture can miss that; run `pnpm conformance` once more
(or run any jest test first) and it passes.
