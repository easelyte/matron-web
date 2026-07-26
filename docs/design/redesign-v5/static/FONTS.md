# Fonts in the static states

**Self-hosted.** `static/fonts/` carries:

- `InterVariable.woff2` — from `rsms/inter` `docs/font-files/` (SIL OFL 1.1)
- `FiraCode[wght].ttf` — from `google/fonts` `ofl/firacode/` (SIL OFL 1.1, licence in `FiraCode-OFL.txt`)

Both are variable fonts covering the weights this design uses (400/500/600). The `@font-face` rules sit at the top of each state file's `<style>` and load with `font-display: block`, so an offline render is screenshot-faithful — no CDN, no fallback substitution.

Metrics were never at risk either way: every size, weight, and line-height in this design is authored as an absolute value rather than derived from font metrics, so computed values were correct even when the CDN face was missing.

If matron-web later self-hosts its own copies, point the `src` at the repo path and delete this folder.
