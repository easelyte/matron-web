#!/usr/bin/env bash

# Copyright 2026 Matron Contributors.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
# Please see LICENSE files in the repository root for full details.

# Guard for the templated matron-web nginx config (loop #740).
#
# The three loop-#568 hardening blocks have regressed twice by hand-editing the
# live conf to a bare config, breaking in-viewer PDF preview and re-introducing
# stale-bundle caching. This guard confirms all three blocks are present AND that
# each hardening directive lives inside its intended `location` block — not merely
# somewhere in the file (a comment mention or another block's header must NOT
# satisfy a check). It fails (exit 1) if any block is missing or unscoped.
# scripts/deploy.sh runs it against the repo conf BEFORE installing it, so a future
# edit that drops a block aborts the deploy.
#
# Usage: check-nginx-conf.sh [path-to-conf]
#   Defaults to ops/nginx/matron-web-journal.conf next to this script's repo root.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CONF=${1:-"$SCRIPT_DIR/../ops/nginx/matron-web-journal.conf"}

if [[ ! -f $CONF ]]; then
    echo "check-nginx-conf: conf not found: $CONF" >&2
    exit 2
fi

# Strip comments (full-line and inline) up front, so a directive that appears only
# in a comment can never satisfy a check. `#` does not appear in any directive
# value in this conf, so removing from `#` to end-of-line is safe here.
stripped=$(sed 's/#.*$//' "$CONF")

# Print the body of the first `location` block whose header matches the given awk
# ERE, tracking brace depth over the comment-stripped input. Empty output => no
# such block.
extract_block() {
    awk -v pat="$1" '
        !inblk && $0 ~ pat { inblk = 1; depth = 0; started = 0 }
        inblk {
            print
            line = $0
            o = gsub(/[{]/, "{", line)
            c = gsub(/[}]/, "}", line)
            depth += o - c
            if (!started && o > 0) started = 1
            if (started && depth <= 0) inblk = 0
        }
    ' <<<"$stripped"
}

missing=()

# Block 1: .mjs served as JS (pdf.js ES-module worker). The header is anchored to
# exactly `\.mjs$` (a near-match like `\.mjsfoo$` is a valid regex nginx would
# accept but that never matches a real .mjs request, so it must NOT satisfy the
# guard), and the MIME must appear in a real `types {}`/`default_type` directive —
# not just as a loose substring. Without this the browser refuses to import() the
# worker ("Failed to fetch dynamically imported module").
mjs_block=$(extract_block 'location[[:space:]]*~[[:space:]]*.*mjs[$][[:space:]]*[{]')
if [[ -z $mjs_block ]] ||
    ! grep -Eq '(default_type[[:space:]]+application/javascript|types[[:space:]]*[{][^}]*application/javascript)' <<<"$mjs_block"; then
    missing+=(".mjs MIME block (location ~ \\.mjs\$ serving application/javascript)")
fi

# Block 2: hashed, content-addressed /assets/ cached forever (immutable). Require
# `immutable` inside an actual Cache-Control add_header directive, so an unrelated
# header value cannot satisfy it.
assets_block=$(extract_block 'location[[:space:]]+/assets/[[:space:]]*[{]')
if [[ -z $assets_block ]] ||
    ! grep -Eq 'add_header[[:space:]]+Cache-Control[[:space:]]+"[^"]*immutable[^"]*"' <<<"$assets_block"; then
    missing+=("/assets/ immutable long-cache block (location /assets/ with Cache-Control immutable)")
fi

# Block 3: the SPA `location /` block (serving index.html directly + via fallback)
# must revalidate every load, or the browser heuristically caches index.html and
# keeps requesting a stale (possibly pruned) hashed bundle after each deploy. The
# header matches `location / {` only (not /assets/ or /journal/), and the value
# must be a real Cache-Control add_header directive.
spa_block=$(extract_block 'location[[:space:]]+/[[:space:]]*[{]')
if [[ -z $spa_block ]] ||
    ! grep -Eq 'add_header[[:space:]]+Cache-Control[[:space:]]+"no-cache"' <<<"$spa_block"; then
    missing+=("index.html/SPA no-cache block (location / with Cache-Control \"no-cache\")")
fi

if ((${#missing[@]} > 0)); then
    echo "check-nginx-conf: $CONF is missing required hardening blocks:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    exit 1
fi

echo "check-nginx-conf: OK — all three hardening blocks present and correctly scoped in $CONF"
