#!/usr/bin/env bash

# Copyright 2026 Matron Contributors.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
# Please see LICENSE files in the repository root for full details.

# Unit test for resolve_nginx_bin (deploy.sh, loop #740). deploy.sh runs the
# resolved binary as root, so it accepts ONLY an explicit absolute override or a
# binary under the known standard sbin locations, never PATH (whose earlier entries
# a non-root user could control), and rejects any candidate in a group/other-
# writable location.

set -euo pipefail

TEST_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd -- "$TEST_DIR/.." && pwd)/deploy.sh

# Source the deploy script for its functions without running main (source-guarded).
# shellcheck source=/dev/null
source "$DEPLOY"

fails=0
check() {
    local label=$1 expected=$2 actual=$3
    if [[ $expected == "$actual" ]]; then
        printf 'ok   - %s\n' "$label"
    else
        printf 'FAIL - %s\n     expected: %q\n     actual:   %q\n' "$label" "$expected" "$actual"
        fails=$((fails + 1))
    fi
}

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

# A fake "standard sbin" dir (0755, not group/other-writable) with an executable
# nginx, and a separate PATH dir with a DIFFERENT (untrusted) nginx that must NEVER
# be selected — PATH is not consulted for this root-run step.
std_dir=$work/sbin
path_dir=$work/evilpath
mkdir -p "$std_dir" "$path_dir"
chmod 755 "$std_dir"
printf '#!/bin/sh\necho std\n' >"$std_dir/nginx"
printf '#!/bin/sh\necho evil\n' >"$path_dir/nginx"
chmod +x "$std_dir/nginx" "$path_dir/nginx"

# An override target in its own trusted (0755) dir.
override_dir=$work/override
mkdir -p "$override_dir"
chmod 755 "$override_dir"
printf '#!/bin/sh\necho override\n' >"$override_dir/nginx"
chmod +x "$override_dir/nginx"

# 1. Explicit (trusted, absolute) override wins over everything.
got=$(DEPLOY_NGINX_BIN=$override_dir/nginx DEPLOY_NGINX_STD_DIRS=$std_dir PATH=$path_dir:$PATH resolve_nginx_bin)
check "trusted override wins" "$override_dir/nginx" "$got"

# 2. A standard sbin dir resolves; an nginx on PATH is NEVER consulted (security case).
got=$(DEPLOY_NGINX_STD_DIRS=$std_dir PATH=$path_dir:$PATH resolve_nginx_bin)
check "standard sbin resolves, PATH ignored" "$std_dir/nginx" "$got"

# 3. No standard dir has nginx and no override => FAIL (PATH is NOT a fallback).
set +e
got=$(DEPLOY_NGINX_STD_DIRS=$work/none PATH=$path_dir:$PATH resolve_nginx_bin 2>/dev/null)
rc=$?
set -e
check "no std nginx + PATH has nginx => nonzero (no PATH fallback)" "1" "$rc"
check "no std nginx + PATH has nginx => empty stdout" "" "$got"

# 4. Nothing anywhere -> nonzero and no output.
set +e
got=$(DEPLOY_NGINX_STD_DIRS=$work/none resolve_nginx_bin 2>/dev/null)
rc=$?
set -e
check "no binary => nonzero" "1" "$rc"
check "no binary => empty stdout" "" "$got"

# 5. A non-executable file in a standard dir is skipped (must be -x).
noexec_dir=$work/noexec
mkdir -p "$noexec_dir"; chmod 755 "$noexec_dir"
printf 'not executable\n' >"$noexec_dir/nginx"
got=$(DEPLOY_NGINX_STD_DIRS="$noexec_dir $std_dir" resolve_nginx_bin)
check "non-executable std candidate skipped" "$std_dir/nginx" "$got"

# 6. A group/other-writable location is refused (root-code-execution guard).
writable_dir=$work/writable
mkdir -p "$writable_dir"; chmod 757 "$writable_dir"
printf '#!/bin/sh\necho writable\n' >"$writable_dir/nginx"
chmod +x "$writable_dir/nginx"
set +e
got=$(DEPLOY_NGINX_STD_DIRS=$writable_dir resolve_nginx_bin 2>/dev/null)
rc=$?
set -e
check "writable-dir candidate refused => nonzero" "1" "$rc"

# 7. A world-writable BINARY (in an otherwise-fine dir) is refused.
ww_dir=$work/wwbin
mkdir -p "$ww_dir"; chmod 755 "$ww_dir"
printf '#!/bin/sh\necho ww\n' >"$ww_dir/nginx"
chmod 777 "$ww_dir/nginx"
set +e
got=$(DEPLOY_NGINX_STD_DIRS=$ww_dir resolve_nginx_bin 2>/dev/null)
rc=$?
set -e
check "world-writable binary refused => nonzero" "1" "$rc"

# 8. A writable override is refused (override is validated too).
set +e
got=$(DEPLOY_NGINX_BIN=$writable_dir/nginx resolve_nginx_bin 2>/dev/null)
rc=$?
set -e
check "writable override refused => nonzero" "1" "$rc"

if [[ $fails -gt 0 ]]; then
    printf '\n%d test(s) failed\n' "$fails" >&2
    exit 1
fi
printf '\nall resolve_nginx_bin tests passed\n'
