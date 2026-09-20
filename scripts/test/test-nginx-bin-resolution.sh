#!/usr/bin/env bash

# Copyright 2026 Matron Contributors.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
# Please see LICENSE files in the repository root for full details.

# Unit test for resolve_nginx_bin (deploy.sh, loop #740). deploy.sh runs as root,
# so binary resolution must prefer an explicit override, then the known root-owned
# standard sbin locations, and only then PATH — a wrapper or attacker-controlled
# `nginx` earlier in PATH must never be selected to validate/reload the config.

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

# A fake "standard sbin" dir with an executable nginx, and a separate PATH dir with
# a DIFFERENT (untrusted) nginx that must lose to the standard one.
std_dir=$work/sbin
path_dir=$work/evilpath
mkdir -p "$std_dir" "$path_dir"
printf '#!/bin/sh\necho std\n' >"$std_dir/nginx"
printf '#!/bin/sh\necho evil\n' >"$path_dir/nginx"
chmod +x "$std_dir/nginx" "$path_dir/nginx"

# 1. Explicit override wins over everything.
got=$(DEPLOY_NGINX_BIN=/opt/custom/nginx DEPLOY_NGINX_STD_DIRS=$std_dir PATH=$path_dir:$PATH resolve_nginx_bin)
check "override beats std dirs and PATH" "/opt/custom/nginx" "$got"

# 2. Standard sbin dir is preferred over an nginx earlier on PATH (the security case).
got=$(DEPLOY_NGINX_STD_DIRS=$std_dir PATH=$path_dir:$PATH resolve_nginx_bin)
check "standard sbin beats PATH nginx" "$std_dir/nginx" "$got"

# 3. Falls back to PATH only when no standard dir has nginx.
got=$(DEPLOY_NGINX_STD_DIRS=$work/none PATH=$path_dir:$PATH resolve_nginx_bin)
check "PATH fallback when std dirs empty" "$path_dir/nginx" "$got"

# 4. Nothing found -> nonzero and no output.
set +e
got=$(DEPLOY_NGINX_STD_DIRS=$work/none PATH=$work/empty resolve_nginx_bin 2>/dev/null)
rc=$?
set -e
check "no binary => nonzero" "1" "$rc"
check "no binary => empty stdout" "" "$got"

# 5. A non-executable file in a standard dir is skipped (must be -x).
noexec_dir=$work/noexec
mkdir -p "$noexec_dir"
printf 'not executable\n' >"$noexec_dir/nginx"
got=$(DEPLOY_NGINX_STD_DIRS="$noexec_dir $std_dir" PATH=$work/empty resolve_nginx_bin)
check "non-executable std candidate skipped" "$std_dir/nginx" "$got"

if [[ $fails -gt 0 ]]; then
    printf '\n%d test(s) failed\n' "$fails" >&2
    exit 1
fi
printf '\nall resolve_nginx_bin tests passed\n'
