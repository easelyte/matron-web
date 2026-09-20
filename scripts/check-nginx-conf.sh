#!/usr/bin/env bash

# Copyright 2026 Matron Contributors.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
# Please see LICENSE files in the repository root for full details.

# Guard for the templated matron-web nginx config (loop #740).
#
# The three loop-#568 hardening blocks have regressed twice by hand-editing the
# live conf to a bare config, breaking in-viewer PDF preview and re-introducing
# stale-bundle caching. This guard greps a candidate conf for all three blocks and
# fails (exit 1) if any is missing. scripts/deploy.sh runs it against the repo conf
# BEFORE installing it, so a future edit that drops a block aborts the deploy.
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

missing=()

# Block 1: .mjs served as JS (pdf.js ES-module worker). Needs both the regex
# location and the application/javascript MIME, or the browser refuses to
# import() the worker ("Failed to fetch dynamically imported module").
if ! grep -Eq 'location[[:space:]]*~[[:space:]]*\\\.mjs\$' "$CONF" ||
    ! grep -q 'application/javascript' "$CONF"; then
    missing+=(".mjs MIME block (location ~ \\.mjs\$ + application/javascript)")
fi

# Block 2: index.html must revalidate every load, or the browser heuristically
# caches it and keeps serving a stale hashed bundle after each deploy.
if ! grep -Eq 'Cache-Control[[:space:]]+"no-cache"' "$CONF"; then
    missing+=("index.html no-cache block (Cache-Control \"no-cache\")")
fi

# Block 3: hashed, content-addressed /assets/ cache forever (immutable).
if ! grep -Eq 'location[[:space:]]+/assets/' "$CONF" ||
    ! grep -q 'immutable' "$CONF"; then
    missing+=("/assets/ immutable long-cache block (location /assets/ + immutable)")
fi

if ((${#missing[@]} > 0)); then
    echo "check-nginx-conf: $CONF is missing required hardening blocks:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    exit 1
fi

echo "check-nginx-conf: OK — all three hardening blocks present in $CONF"
