#!/usr/bin/env bash

# Copyright 2026 Matron Contributors.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
# Please see LICENSE files in the repository root for full details.

# Unit test for check-nginx-conf.sh: the templated conf passes, and dropping the
# response-compression block (JSON + JS bodies left uncompressed) fails the guard.

set -euo pipefail

TEST_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CHECK=$(cd -- "$TEST_DIR/.." && pwd)/check-nginx-conf.sh
CONF=$(cd -- "$TEST_DIR/../.." && pwd)/ops/nginx/matron-web-journal.conf

fails=0
expect() {
    local label=$1 want=$2 conf=$3
    local got=0
    bash "$CHECK" "$conf" >/dev/null 2>&1 || got=$?
    if [[ ($want == pass && $got == 0) || ($want == fail && $got != 0) ]]; then
        printf 'ok   - %s\n' "$label"
    else
        printf 'FAIL - %s (exit %s, wanted %s)\n' "$label" "$got" "$want"
        fails=$((fails + 1))
    fi
}

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

expect "repo conf passes" pass "$CONF"

grep -v 'gzip_types' "$CONF" >"$work/no-types.conf"
expect "conf without gzip_types fails" fail "$work/no-types.conf"

sed 's#application/json##' "$CONF" >"$work/no-json.conf"
expect "conf whose gzip_types omits application/json fails" fail "$work/no-json.conf"

sed '/gzip_types/s#application/javascript##g' "$CONF" >"$work/no-js.conf"
expect "conf whose gzip_types omits application/javascript fails" fail "$work/no-js.conf"

sed 's/^\([[:space:]]*\)gzip_types/\1# gzip_types/' "$CONF" >"$work/commented.conf"
expect "a commented-out gzip_types does not satisfy the guard" fail "$work/commented.conf"

sed 's/^\([[:space:]]*\)gzip on;/\1gzip off;/' "$CONF" >"$work/gzip-off.conf"
expect "conf with gzip off fails" fail "$work/gzip-off.conf"

if ((fails > 0)); then
    echo "$fails check(s) failed" >&2
    exit 1
fi
