# WebSocket frame conformance fixtures (#753)

`producer-frames.json` is the conformance corpus for `src/journal/frame-decode.ts`,
the runtime decoder at the WebSocket frame boundary. Every `valid` fixture is a
real `ServerFrame` shape emitted by a producer; the decoder must accept it with
**no narrowing**. If a producer changes a shape and the fixture is regenerated to
match, a now-invalid field makes `frame-decode-test.ts` fail — schema drift fails
loud in CI instead of silently painting stale or blank UI at runtime.

**Do not hand-tune fixtures to make the decoder pass.** The direction of trust is
fixture → decoder, not the reverse. If a real producer frame fails the decoder,
the decoder is wrong (or the producer drifted); fix whichever is actually wrong.

## Provenance

The producers are two repos:

| Frame                                              | Producer                              | Anchor                                                                              |
| -------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `kind:"journal"`                                   | matron-journal                        | `src/ws.js:13` (`journalFrame`), `src/journal.js:321`                               |
| `kind:"control"`                                   | matron-journal                        | `src/ws.js:390/473/480/652` (error / hello_ok / snapshot_required)                  |
| `kind:"rpc"`                                       | matron-journal                        | `src/rpc-broker.js:41`                                                              |
| `kind:"ephemeral"` `host_vitals`                   | matron-journal relay of matron-bridge | `src/ws.js:567`; bridge `index.js:12389-12391` builds `{cpu?, ram?, sampled_at_ms}` |
| `kind:"ephemeral"` `status`                        | matron-bridge                         | `buildSessionStatus` (`lib/session-status.js`)                                      |
| `kind:"ephemeral"` `activity`/`tool_stream`/`text` | matron-bridge / journal relay         | `src/ws.js:643/789`                                                                 |

Note the deliberate two-shape vitals split, documented in `src/journal/types.ts`:
`status.vitals` uses `cpu_pct`/`ram_pct` (nullable), the host-global `host_vitals`
frame uses `cpu`/`ram` (omitted until the sampler warms). The `status.*` fixtures
were captured live from the bridge on 2026-09-22:

```
$ node --input-type=module -e '
  import { hostVitals, buildSessionStatus } from "./lib/session-status.js";
  console.log(JSON.stringify(buildSessionStatus({ model: "claude-opus-4-8",
    vitals: { cpu_pct: 12, ram_pct: 47, sampled_at_ms: Date.now() } })));'
# → {"model":"claude-opus-4-8","vitals":{"cpu_pct":12,"ram_pct":47,"sampled_at_ms":...}}
```

## Regeneration

When a producer shape changes, refresh the affected fixture from the producer
(capture as above, or copy the literal object the producer serializes) — never
edit it to fit the decoder. Then run `pnpm test frame-decode` and, if a real
shape now fails, update `frame-decode.ts` to accept it (or narrow the genuinely
invalid field). The `narrowing` and `invalid` arrays are decoder contract cases,
not producer output — extend them when the decoder gains a rule.

Note: journal (`kind:"journal"`) frames are **sequenced**, so the decoder never
rejects or narrows them — dropping one at the boundary would advance the durable
cursor past it and lose the row permanently (`applyJournal` has no gap detection).
That is why `invalid` has no `journal:*` entries; a malformed journal frame passes
through, and its correctness is owned by the cursor/dedup path plus the defensive
payload consumption downstream. See `decodeJournalEvent`.
