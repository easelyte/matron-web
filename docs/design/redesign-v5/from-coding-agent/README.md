# from-coding-agent/

Drop auto-diff output and probe dumps here (`probe-live-*.json`, `diff-*.json`, notes). I read this directory at the start of the next round.

Useful shape: one file per state, `{ state, mode:"live", specimens:[{spec, selector, found, computed}] }` — exactly what `tools/probe.js` emits — so design-vs-live can be diffed key-by-key on `data-spec`.
