#!/usr/bin/env bash

# Copyright 2026 Matron Contributors.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
# Please see LICENSE files in the repository root for full details.

set -euo pipefail

HARNESS_PATH=$(/usr/bin/readlink -f -- "${BASH_SOURCE[0]}")
HARNESS_DIR=$(/usr/bin/dirname -- "$HARNESS_PATH")
RECOVER=$(/usr/bin/readlink -f -- "$HARNESS_DIR/../recover-current.sh")
REPOSITORY_ROOT=$(/usr/bin/readlink -f -- "$HARNESS_DIR/../..")
ORIGINAL_PATH=$PATH

if [[ $(/usr/bin/basename -- "$0") == logger ]]; then
    /usr/bin/printf '%s\n' "$*" >>"$RECOVER_TEST_EVENT_LOG"
    exit
fi

if [[ $(/usr/bin/basename -- "$0") == flock ]]; then
    if [[ -n ${RECOVER_TEST_FLOCK_REACHED_FILE:-} ]]; then
        /usr/bin/touch -- "$RECOVER_TEST_FLOCK_REACHED_FILE"
    fi
    if [[ -n ${RECOVER_TEST_FLOCK_STATUS:-} ]]; then
        exit "$RECOVER_TEST_FLOCK_STATUS"
    fi
    exec /usr/bin/flock "$@"
fi

fail() {
    /usr/bin/printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_eq() {
    local expected=$1
    local actual=$2
    local description=$3

    [[ $actual == "$expected" ]] ||
        fail "$description (expected '$expected', got '$actual')"
}

assert_contains() {
    local file=$1
    local text=$2
    local description=$3

    /usr/bin/grep -Fq -- "$text" "$file" || fail "$description"
}

assert_no_path() {
    [[ ! -e $1 && ! -L $1 ]] || fail "$2 (unexpected path: $1)"
}

TEST_ROOT=$(/usr/bin/mktemp -d /tmp/matron-recover-harness.XXXXXX)
STUB_BIN=$TEST_ROOT/stub-bin

cleanup() {
    if [[ -n ${TEST_ROOT:-} && -d $TEST_ROOT &&
        $TEST_ROOT == /tmp/matron-recover-harness.* ]]; then
        /usr/bin/rm -rf -- "$TEST_ROOT"
    fi
}
trap cleanup EXIT

/usr/bin/mkdir -p -- "$STUB_BIN"
/usr/bin/ln -s -- "$HARNESS_PATH" "$STUB_BIN/logger"
/usr/bin/ln -s -- "$HARNESS_PATH" "$STUB_BIN/flock"

new_fixture() {
    local name=$1

    FIXTURE=$TEST_ROOT/$name
    WEB=$FIXTURE/web
    EVENT_LOG=$FIXTURE/events.log
    /usr/bin/mkdir -p -- "$WEB/releases"
    : >"$EVENT_LOG"
    [[ $WEB != "$REPOSITORY_ROOT" ]] || fail "fixture resolved to the repository root"
}

seed_release() {
    local name=$1
    local mtime=$2
    local healthy=${3:-yes}
    local release=$WEB/releases/$name

    /usr/bin/mkdir -p -- "$release/assets"
    /usr/bin/printf '%s\n' "$name" >"$release/index.html"
    /usr/bin/printf '%s\n' "$name" >"$release/assets/x"
    if [[ $healthy == yes ]]; then
        /usr/bin/touch -- "$release/.healthy"
    fi
    /usr/bin/touch -d "@$mtime" -- "$release"
    /usr/bin/printf '%s\n' "$release"
}

current_target() {
    /usr/bin/readlink -e -- "$WEB/current"
}

run_recover() {
    env \
        DEPLOY_WEB="$WEB" \
        RECOVER_TEST_EVENT_LOG="$EVENT_LOG" \
        RECOVER_TEST_FLOCK_REACHED_FILE="${RECOVER_TEST_FLOCK_REACHED_FILE:-}" \
        RECOVER_TEST_FLOCK_STATUS="${RECOVER_TEST_FLOCK_STATUS:-}" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        /usr/bin/timeout 5 "$RECOVER"
}

wait_for_flock() {
    local marker=$1
    local process=$2
    local output=$3
    local attempt
    local status

    for ((attempt = 0; attempt < 500; attempt++)); do
        [[ -e $marker ]] && return
        if ! /usr/bin/kill -0 "$process" 2>/dev/null; then
            set +e
            wait "$process"
            status=$?
            set -e
            fail "recovery exited $status before attempting the deployment lock; output: $(<"$output")"
        fi
        /usr/bin/sleep 0.01
    done
    fail "timed out waiting for recovery to attempt the deployment lock"
}

case_dangling_current() {
    local newest

    /usr/bin/printf 'case 1: dangling current\n' >&2
    new_fixture dangling-current
    seed_release release-a 100 >/dev/null
    newest=$(seed_release release-b 200)
    /usr/bin/ln -s -- releases/missing "$WEB/current"

    run_recover >"$FIXTURE/recover.out" 2>&1
    assert_eq "$newest" "$(current_target)" \
        "dangling current must be repointed to the newest healthy release"
}

case_missing_current() {
    local newest

    /usr/bin/printf 'case 2: missing current\n' >&2
    new_fixture missing-current
    newest=$(seed_release release-a 100)

    run_recover >"$FIXTURE/recover.out" 2>&1
    assert_eq "$newest" "$(current_target)" \
        "missing current must be created and resolve"
}

case_unhealthy_current() {
    local healthy
    local unhealthy

    /usr/bin/printf 'case 3: resolved but unhealthy current\n' >&2
    new_fixture unhealthy-current
    healthy=$(seed_release release-a 100)
    unhealthy=$(seed_release release-b 200 no)
    /usr/bin/ln -s -- "$unhealthy" "$WEB/current"

    run_recover >"$FIXTURE/recover.out" 2>&1
    assert_eq "$healthy" "$(current_target)" \
        "resolved un-.healthy current must be replaced by an older healthy release"
}

case_skip_newest_unhealthy() {
    local healthy

    /usr/bin/printf 'case 4: skip newest un-.healthy release\n' >&2
    new_fixture skip-unhealthy
    healthy=$(seed_release release-a 100)
    seed_release release-b 200 no >/dev/null

    run_recover >"$FIXTURE/recover.out" 2>&1
    assert_eq "$healthy" "$(current_target)" \
        "recovery must skip a newer release without .healthy"
}

case_no_healthy_release() {
    local status=0

    /usr/bin/printf 'case 5: no healthy release\n' >&2
    new_fixture no-healthy
    seed_release release-a 100 no >/dev/null

    run_recover >"$FIXTURE/recover.out" 2>&1 || status=$?
    assert_eq 1 "$status" "recovery without a healthy release must fail"
    assert_no_path "$WEB/current" \
        "recovery without a healthy release must not fabricate current"
    assert_contains "$EVENT_LOG" "-p daemon.err" \
        "no-healthy recovery must log at err priority"
    assert_contains "$FIXTURE/recover.out" '"phase":"no-healthy-release"' \
        "no-healthy recovery must fail loudly on stderr"
}

case_already_healthy() {
    local current

    /usr/bin/printf 'case 6: already healthy current\n' >&2
    new_fixture already-healthy
    current=$(seed_release release-a 100)
    seed_release release-b 200 >/dev/null
    /usr/bin/ln -s -- "$current" "$WEB/current"

    run_recover >"$FIXTURE/recover.out" 2>&1
    assert_eq "$current" "$(current_target)" \
        "already-healthy current must remain unchanged"
    assert_contains "$EVENT_LOG" '"phase":"already-healthy"' \
        "healthy no-op must be observable"
}

case_reject_unmanaged_healthy_current() {
    local managed
    local unmanaged

    /usr/bin/printf 'case 7: reject unmanaged healthy current\n' >&2
    new_fixture unmanaged-healthy
    managed=$(seed_release release-a 100)
    unmanaged=$FIXTURE/release-external
    /usr/bin/mkdir -p -- "$unmanaged"
    /usr/bin/touch -- "$unmanaged/.healthy"
    /usr/bin/ln -s -- "$unmanaged" "$WEB/current"

    run_recover >"$FIXTURE/recover.out" 2>&1
    assert_eq "$managed" "$(current_target)" \
        "healthy current outside releases must be replaced by a managed release"
    assert_contains "$EVENT_LOG" '"phase":"recovered"' \
        "unmanaged healthy current must take the recovery path"

    new_fixture unnamed-healthy-child
    managed=$(seed_release release-a 100)
    unmanaged=$WEB/releases/not-a-release
    /usr/bin/mkdir -p -- "$unmanaged"
    /usr/bin/touch -- "$unmanaged/.healthy"
    /usr/bin/ln -s -- "$unmanaged" "$WEB/current"

    run_recover >"$FIXTURE/recover.out" 2>&1
    assert_eq "$managed" "$(current_target)" \
        "healthy current without a release-* name must be replaced"
}

case_lock_outcomes() {
    local RECOVER_TEST_FLOCK_STATUS
    local status=0

    /usr/bin/printf 'case 8: lock timeout and execution error\n' >&2
    new_fixture lock-timeout
    seed_release release-a 100 >/dev/null
    RECOVER_TEST_FLOCK_STATUS=75

    run_recover >"$FIXTURE/recover.out" 2>&1 || status=$?
    assert_eq 0 "$status" "explicit lock timeout must retain warning-success policy"
    assert_no_path "$WEB/current" "lock timeout must not change current"
    assert_contains "$EVENT_LOG" '"phase":"lock-contended"' \
        "explicit lock timeout must log contention"

    new_fixture lock-error
    seed_release release-a 100 >/dev/null
    RECOVER_TEST_FLOCK_STATUS=70
    status=0

    run_recover >"$FIXTURE/recover.out" 2>&1 || status=$?
    assert_eq 1 "$status" "non-timeout flock failure must fail recovery"
    assert_no_path "$WEB/current" "flock failure must not change current"
    assert_contains "$EVENT_LOG" '"phase":"fs-assert-fail"' \
        "non-timeout flock failure must log an error"
}

case_staging_directory() {
    local status=0

    /usr/bin/printf 'case 9: staging path is a directory\n' >&2
    new_fixture staging-directory
    seed_release release-a 100 >/dev/null
    /usr/bin/mkdir -- "$WEB/current.tmp"

    run_recover >"$FIXTURE/recover.out" 2>&1 || status=$?
    assert_eq 1 "$status" "recovery must fail when current.tmp is a directory"
    assert_no_path "$WEB/current" \
        "staging-directory failure must not install a directory as current"
    [[ -d $WEB/current.tmp ]] || fail "staging-directory failure must preserve current.tmp"
    assert_contains "$FIXTURE/recover.out" "failed to stage recovery pointer" \
        "staging-directory failure must be loud"
}

case_shared_lock_reread() {
    local current
    local marker
    local process
    local status=0

    /usr/bin/printf 'case 10: shared lock and state re-read\n' >&2
    new_fixture shared-lock
    current=$(seed_release release-a 100)
    marker=$FIXTURE/flock.reached
    /usr/bin/ln -s -- releases/missing "$WEB/current"
    exec 8>"$WEB/.deploy.lock"
    /usr/bin/flock -n 8 || fail "fixture could not acquire the deployment lock"

    local RECOVER_TEST_FLOCK_REACHED_FILE=$marker
    run_recover >"$FIXTURE/recover.out" 2>&1 &
    process=$!
    wait_for_flock "$marker" "$process" "$FIXTURE/recover.out"
    [[ -z $(/usr/bin/readlink -e -- "$WEB/current" 2>/dev/null || true) ]] ||
        fail "recovery touched current before acquiring the deployment lock"

    /usr/bin/ln -sfn -- "$current" "$WEB/current.tmp"
    /usr/bin/mv -T -- "$WEB/current.tmp" "$WEB/current"
    /usr/bin/flock -u 8
    exec 8>&-
    wait "$process" || status=$?

    assert_eq 0 "$status" "recovery must succeed after waiting for the shared lock"
    assert_eq "$current" "$(current_target)" \
        "recovery must re-read current after acquiring the shared lock"
    assert_contains "$EVENT_LOG" '"phase":"already-healthy"' \
        "post-lock state re-read must take the healthy no-op path"
}

[[ -x $RECOVER ]] || fail "recovery script is not executable: $RECOVER"
case_dangling_current
case_missing_current
case_unhealthy_current
case_skip_newest_unhealthy
case_no_healthy_release
case_already_healthy
case_reject_unmanaged_healthy_current
case_lock_outcomes
case_staging_directory
case_shared_lock_reread
/usr/bin/printf 'all recovery harness cases passed\n' >&2
