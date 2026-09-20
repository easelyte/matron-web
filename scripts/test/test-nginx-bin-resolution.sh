#!/usr/bin/env bash

# Copyright 2026 Matron Contributors.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
# Please see LICENSE files in the repository root for full details.

# Unit test for resolve_nginx_bin (deploy.sh, loop #740). deploy.sh runs the
# resolved binary as root, so it accepts ONLY an explicit absolute override or a
# binary under the known standard sbin locations, never PATH; and every candidate
# (binary + parent dir) must be root-owned and not group/other-writable. A non-root
# test cannot create a root-owned fixture, so the ACCEPT path is exercised against
# the real /usr/sbin/nginx when present and root-owned, and skipped otherwise; the
# security-critical REJECTION paths are all deterministic.

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

# Make a path non-root-owned regardless of who runs the test: as root, chown to an
# unprivileged uid; under non-root CI the file is already non-root-owned and the
# chown simply fails (ignored). Without this, a root-run test would own its own
# fixtures and the ownership-rejection cases could not be constructed.
make_untrusted() {
    [[ $EUID -eq 0 ]] && chown 65534 "$1" 2>/dev/null || true
}

# Non-root-owned fixtures — every one of these must be REFUSED, because a non-root
# account could swap the binary that then runs as root.
user_dir=$work/userdir
mkdir -p "$user_dir"; chmod 755 "$user_dir"
printf '#!/bin/sh\necho x\n' >"$user_dir/nginx"; chmod +x "$user_dir/nginx"
make_untrusted "$user_dir/nginx"

# --- Rejection cases (deterministic, run as non-root) ---

# 1. A relative override is refused (must be absolute).
set +e; got=$(cd "$work" && DEPLOY_NGINX_BIN=userdir/nginx resolve_nginx_bin 2>/dev/null); rc=$?; set -e
check "relative override refused" "1" "$rc"

# 2. An absolute but non-root-owned override is refused (ownership guard).
set +e; got=$(DEPLOY_NGINX_BIN=$user_dir/nginx resolve_nginx_bin 2>/dev/null); rc=$?; set -e
check "non-root-owned override refused" "1" "$rc"
check "non-root-owned override => empty stdout" "" "$got"

# 3. A group/other-writable location is refused even if it existed root-owned:
writable_dir=$work/writable
mkdir -p "$writable_dir"; chmod 757 "$writable_dir"
printf '#!/bin/sh\necho w\n' >"$writable_dir/nginx"; chmod +x "$writable_dir/nginx"
set +e; got=$(DEPLOY_NGINX_BIN=$writable_dir/nginx resolve_nginx_bin 2>/dev/null); rc=$?; set -e
check "writable-dir override refused" "1" "$rc"

# 4. A world-writable binary is refused.
ww_dir=$work/wwbin
mkdir -p "$ww_dir"; chmod 755 "$ww_dir"
printf '#!/bin/sh\necho ww\n' >"$ww_dir/nginx"; chmod 777 "$ww_dir/nginx"
set +e; got=$(DEPLOY_NGINX_BIN=$ww_dir/nginx resolve_nginx_bin 2>/dev/null); rc=$?; set -e
check "world-writable binary override refused" "1" "$rc"

# 5. Non-root-owned standard dir => no candidate resolves => nonzero.
set +e; got=$(DEPLOY_NGINX_STD_DIRS=$user_dir resolve_nginx_bin 2>/dev/null); rc=$?; set -e
check "non-root-owned std dir => nonzero" "1" "$rc"

# 6. PATH is never consulted: an nginx on PATH with no override/std candidate fails.
path_dir=$work/evilpath
mkdir -p "$path_dir"; printf '#!/bin/sh\necho evil\n' >"$path_dir/nginx"; chmod +x "$path_dir/nginx"
set +e; got=$(DEPLOY_NGINX_STD_DIRS=$work/none PATH=$path_dir:$PATH resolve_nginx_bin 2>/dev/null); rc=$?; set -e
check "PATH nginx never consulted => nonzero" "1" "$rc"

# 7. Nothing anywhere => nonzero and empty stdout.
set +e; got=$(DEPLOY_NGINX_STD_DIRS=$work/none resolve_nginx_bin 2>/dev/null); rc=$?; set -e
check "no binary => nonzero" "1" "$rc"
check "no binary => empty stdout" "" "$got"

# --- Accept case: only meaningful against a genuinely root-owned binary ---
# CI runners without nginx skip this; on the deploy host /usr/sbin/nginx is
# root:root 0755 and must resolve.
real=/usr/sbin/nginx
if [[ -x $real ]] && [[ $(stat -c '%u' "$real" 2>/dev/null) == 0 ]] \
    && [[ $(stat -c '%u' /usr/sbin 2>/dev/null) == 0 ]]; then
    got=$(DEPLOY_NGINX_STD_DIRS="/usr/sbin" resolve_nginx_bin)
    check "root-owned /usr/sbin/nginx resolves" "$real" "$got"
    got=$(DEPLOY_NGINX_BIN=$real resolve_nginx_bin)
    check "root-owned absolute override resolves" "$real" "$got"
else
    printf 'skip - no root-owned /usr/sbin/nginx present (accept-path coverage)\n'
fi

if [[ $fails -gt 0 ]]; then
    printf '\n%d test(s) failed\n' "$fails" >&2
    exit 1
fi
printf '\nall resolve_nginx_bin tests passed\n'
