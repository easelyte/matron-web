#!/usr/bin/env bash

# Copyright 2026 Matron Contributors.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
# Please see LICENSE files in the repository root for full details.

set -euo pipefail

HARNESS_PATH=$(/usr/bin/readlink -f -- "${BASH_SOURCE[0]}")
HARNESS_DIR=$(/usr/bin/dirname -- "$HARNESS_PATH")
DEPLOY=$(/usr/bin/readlink -f -- "$HARNESS_DIR/../deploy.sh")
ORIGINAL_PATH=$PATH

boundary_wait() {
    local parent=$PPID

    /usr/bin/printf '%s\n' "$$" >"$DEPLOY_TEST_BOUNDARY_FILE"
    while /usr/bin/kill -0 "$parent" 2>/dev/null; do
        /usr/bin/sleep 0.01
    done
}

stub_npm() {
    local web=""

    while (($# > 0)); do
        case $1 in
            --prefix)
                web=$2
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done
    [[ -n $web ]] || return 2

    if [[ -n ${DEPLOY_TEST_BUILD_STARTED_FILE:-} ]]; then
        /usr/bin/touch -- "$DEPLOY_TEST_BUILD_STARTED_FILE"
    fi
    if [[ -n ${DEPLOY_TEST_BUILD_RELEASE_FILE:-} ]]; then
        while [[ ! -e $DEPLOY_TEST_BUILD_RELEASE_FILE ]]; do
            /usr/bin/sleep 0.01
        done
    fi
    if [[ -n ${DEPLOY_TEST_BUILD_DELAY:-} ]]; then
        /usr/bin/sleep "$DEPLOY_TEST_BUILD_DELAY"
    fi

    /usr/bin/mkdir -p -- "$web/webapp/assets"
    if [[ ${DEPLOY_TEST_BUILD_MODE:-complete} == complete ]]; then
        /usr/bin/printf 'build-%s\n' "$BASHPID" >"$web/webapp/index.html"
    fi
    /usr/bin/printf 'asset-%s\n' "$BASHPID" >"$web/webapp/assets/x"
}

stub_logger() {
    /usr/bin/printf '%s\n' "$*" >>"$DEPLOY_TEST_EVENT_LOG"
}

stub_curl() {
    local url=${*: -1}

    if [[ -n ${DEPLOY_TEST_CURL_REQUEST_FILE:-} ]]; then
        /usr/bin/printf '%s\n' "$url" >"$DEPLOY_TEST_CURL_REQUEST_FILE"
    fi
    if [[ ${DEPLOY_TEST_CURL_STATUS:-} == 503 ]]; then
        /usr/bin/printf 'curl: simulated HTTP 503 from local fixture\n' >&2
        return 22
    fi
    /usr/bin/curl "$@"
}

stub_date() {
    if [[ ${DEPLOY_TEST_FIXED_DATE:-0} == 1 && ${*: -1} == +%Y%m%dT%H%M%SZ ]]; then
        /usr/bin/printf '%s\n' '20300102T030405Z'
        return
    fi
    /usr/bin/date "$@"
}

stub_ln() {
    local destination=${*: -1}

    /usr/bin/ln "$@"
    if [[ ${DEPLOY_TEST_INJECT_POINT:-} == after-current-tmp-create &&
        $destination == "$DEPLOY_WEB/current.tmp" ]]; then
        boundary_wait
    fi
}

stub_mv() {
    local source=${*: -2:1}
    local destination=${*: -1}

    if [[ ${DEPLOY_TEST_INJECT_POINT:-} == before-current-mv &&
        $source == "$DEPLOY_WEB/current.tmp" &&
        $destination == "$DEPLOY_WEB/current" ]]; then
        boundary_wait
        return
    fi

    /usr/bin/mv "$@"
    if [[ ${DEPLOY_TEST_INJECT_POINT:-} == after-release-mv &&
        $source == "$DEPLOY_WEB/webapp" &&
        $destination == "$DEPLOY_WEB/releases/"release-* ]]; then
        boundary_wait
    fi
}

stub_touch() {
    local destination=${*: -1}

    if [[ ${DEPLOY_TEST_INJECT_POINT:-} == after-flip-before-healthy &&
        $destination == "$DEPLOY_WEB/releases/"release-*/.healthy ]]; then
        boundary_wait
        return
    fi
    /usr/bin/touch "$@"
}

case $(/usr/bin/basename -- "$0") in
    npm)
        stub_npm "$@"
        exit
        ;;
    logger)
        stub_logger "$@"
        exit
        ;;
    curl)
        stub_curl "$@"
        exit
        ;;
    date)
        stub_date "$@"
        exit
        ;;
    ln)
        stub_ln "$@"
        exit
        ;;
    mv)
        stub_mv "$@"
        exit
        ;;
    touch)
        stub_touch "$@"
        exit
        ;;
esac

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

assert_file() {
    [[ -f $1 ]] || fail "$2 (missing file: $1)"
}

assert_no_file() {
    [[ ! -e $1 && ! -L $1 ]] || fail "$2 (unexpected path: $1)"
}

assert_contains() {
    local file=$1
    local text=$2
    local description=$3

    /usr/bin/grep -Fq -- "$text" "$file" || fail "$description"
}

TEST_ROOT=$(/usr/bin/mktemp -d /tmp/matron-deploy-harness.XXXXXX)
STUB_BIN=$TEST_ROOT/stub-bin

cleanup() {
    if [[ -n ${TEST_ROOT:-} && -d $TEST_ROOT &&
        $TEST_ROOT == /tmp/matron-deploy-harness.* ]]; then
        /usr/bin/rm -rf -- "$TEST_ROOT"
    fi
}
trap cleanup EXIT

/usr/bin/mkdir -p -- "$STUB_BIN"
for command_name in npm logger curl date ln mv touch; do
    /usr/bin/ln -s -- "$HARNESS_PATH" "$STUB_BIN/$command_name"
done

new_fixture() {
    local name=$1

    FIXTURE=$TEST_ROOT/$name
    WEB=$FIXTURE/web
    EVENT_LOG=$FIXTURE/events.log
    /usr/bin/mkdir -p -- "$WEB/releases"
    : >"$EVENT_LOG"
    [[ $WEB != /opt/matron/web-journal ]] || fail "fixture resolved to production"
}

seed_release() {
    local name=$1
    local mtime=$2
    local release=$WEB/releases/$name

    /usr/bin/mkdir -p -- "$release/assets"
    /usr/bin/printf '%s\n' "$name" >"$release/index.html"
    /usr/bin/printf '%s\n' "$name" >"$release/assets/x"
    /usr/bin/touch -- "$release/.healthy"
    /usr/bin/touch -d "@$mtime" -- "$release"
    /usr/bin/printf '%s\n' "$release"
}

release_count() {
    local releases=("$WEB"/releases/release-*)

    if [[ ! -e ${releases[0]} ]]; then
        /usr/bin/printf '0\n'
    else
        /usr/bin/printf '%s\n' "${#releases[@]}"
    fi
}

current_target() {
    /usr/bin/readlink -e -- "$WEB/current"
}

run_healthy_deploy() {
    env \
        DEPLOY_WEB="$WEB" \
        DEPLOY_SKIP_HEALTH=1 \
        DEPLOY_TEST_EVENT_LOG="$EVENT_LOG" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        /usr/bin/timeout 10 "$DEPLOY" "$@"
}

wait_for_boundary() {
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
            fail "process exited $status before boundary marker; output: $(<"$output")"
        fi
        /usr/bin/sleep 0.01
    done
    fail "timed out waiting for boundary marker $marker"
}

kill_at_boundary() {
    local point=$1
    shift
    local marker=$FIXTURE/boundary
    local output=$FIXTURE/killed.out
    local process
    local status

    env \
        DEPLOY_WEB="$WEB" \
        DEPLOY_SKIP_HEALTH=1 \
        DEPLOY_TEST_EVENT_LOG="$EVENT_LOG" \
        DEPLOY_TEST_INJECT_POINT="$point" \
        DEPLOY_TEST_BOUNDARY_FILE="$marker" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        "$DEPLOY" "$@" >"$output" 2>&1 &
    process=$!
    wait_for_boundary "$marker" "$process" "$output"
    /usr/bin/kill -9 "$process"
    set +e
    wait "$process" 2>/dev/null
    status=$?
    set -e
    assert_eq 137 "$status" "kill injection must terminate deploy with SIGKILL"
}

start_503_server() {
    local request_file=$1
    local port=$((30000 + BASHPID % 10000))
    local server_state

    (
        /usr/bin/printf 'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' |
            /usr/bin/nc -l 127.0.0.1 "$port" >"$request_file"
    ) 2>"$request_file.stderr" &
    SERVER_PID=$!
    SERVER_URL=http://127.0.0.1:$port/
    SERVER_CURL_STATUS=""
    /usr/bin/sleep 0.1
    server_state=$(/usr/bin/ps -o stat= -p "$SERVER_PID" 2>/dev/null || true)
    if [[ -z $server_state || $server_state == Z* ]]; then
        wait "$SERVER_PID" 2>/dev/null || true
        SERVER_PID=""
        SERVER_CURL_STATUS=503
    fi
}

stop_server() {
    if [[ -n $SERVER_PID ]] && /usr/bin/kill -0 "$SERVER_PID" 2>/dev/null; then
        /usr/bin/kill "$SERVER_PID" 2>/dev/null || true
    fi
    if [[ -n $SERVER_PID ]]; then
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}

case_no_gap() {
    local reader
    local status=0
    local target

    /usr/bin/printf 'case 1: no-gap invariant\n' >&2
    new_fixture no-gap
    target=$(seed_release release-a 100)
    /usr/bin/ln -s -- "releases/$(/usr/bin/basename -- "$target")" "$WEB/current"

    (
        while [[ ! -e $FIXTURE/reader.stop ]]; do
            target=$(/usr/bin/readlink -e -- "$WEB/current" 2>/dev/null || true)
            if [[ -z $target || ! -f $target/index.html ]]; then
                /usr/bin/touch -- "$FIXTURE/reader.failed"
                exit 1
            fi
            /usr/bin/touch -- "$FIXTURE/reader.sampled"
        done
    ) &
    reader=$!
    while [[ ! -e $FIXTURE/reader.sampled ]]; do
        /usr/bin/sleep 0.01
    done

    env \
        DEPLOY_WEB="$WEB" \
        DEPLOY_SKIP_HEALTH=1 \
        DEPLOY_TEST_BUILD_DELAY=0.2 \
        DEPLOY_TEST_EVENT_LOG="$EVENT_LOG" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        /usr/bin/timeout 10 "$DEPLOY" >"$FIXTURE/deploy.out" 2>&1 || status=$?
    /usr/bin/touch -- "$FIXTURE/reader.stop"
    wait "$reader" || true

    assert_eq 0 "$status" "no-gap deploy must succeed"
    assert_no_file "$FIXTURE/reader.failed" "reader observed a missing or dangling current"
    assert_file "$(current_target)/index.html" "current must remain servable after deploy"
}

case_kill_injection() {
    local old_target
    local point
    local rollback_status
    local target
    local unhealthy
    local unhealthy_count

    /usr/bin/printf 'case 2: kill injection\n' >&2
    for point in after-release-mv after-current-tmp-create before-current-mv after-flip-before-healthy; do
        new_fixture "kill-$point"
        old_target=$(seed_release release-a 100)
        /usr/bin/ln -s -- "releases/$(/usr/bin/basename -- "$old_target")" "$WEB/current"

        kill_at_boundary "$point"
        target=$(current_target)
        assert_file "$target/index.html" "$point left current unservable"

        unhealthy_count=0
        for unhealthy in "$WEB"/releases/release-*; do
            if [[ ! -f $unhealthy/.healthy ]]; then
                unhealthy_count=$((unhealthy_count + 1))
            fi
        done
        [[ $unhealthy_count -ge 1 ]] || fail "$point left no un-.healthy release to test"

        rollback_status=0
        run_healthy_deploy --rollback >"$FIXTURE/rollback.out" 2>&1 || rollback_status=$?
        target=$(current_target)
        assert_file "$target/.healthy" "$point rollback selected an un-.healthy release"
        assert_eq "$old_target" "$target" "$point must leave or restore the prior healthy release"
        if [[ $point == after-flip-before-healthy ]]; then
            assert_eq 0 "$rollback_status" "post-flip kill must roll back to the prior healthy release"
        else
            [[ $rollback_status -ne 0 ]] || fail "$point rollback should refuse the already-current release"
        fi
    done
}

case_concurrency() {
    local first
    local first_status=0
    local second_status=0
    local target
    local release

    /usr/bin/printf 'case 3: concurrency\n' >&2
    new_fixture concurrency
    target=$(seed_release release-a 100)
    /usr/bin/ln -s -- "releases/$(/usr/bin/basename -- "$target")" "$WEB/current"

    env \
        DEPLOY_WEB="$WEB" \
        DEPLOY_SKIP_HEALTH=1 \
        DEPLOY_TEST_BUILD_STARTED_FILE="$FIXTURE/build.started" \
        DEPLOY_TEST_BUILD_RELEASE_FILE="$FIXTURE/build.release" \
        DEPLOY_TEST_EVENT_LOG="$EVENT_LOG" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        "$DEPLOY" >"$FIXTURE/first.out" 2>&1 &
    first=$!
    wait_for_boundary "$FIXTURE/build.started" "$first" "$FIXTURE/first.out"

    run_healthy_deploy >"$FIXTURE/second.out" 2>&1 || second_status=$?
    assert_eq 3 "$second_status" "contending deploy must exit 3"
    assert_eq 1 "$(release_count)" "contending deploy must not touch releases"

    /usr/bin/touch -- "$FIXTURE/build.release"
    wait "$first" || first_status=$?
    assert_eq 0 "$first_status" "lock-winning deploy must succeed"
    assert_eq 2 "$(release_count)" "exactly one concurrent deploy must create a release"
    target=$(current_target)
    assert_file "$target/.healthy" "promoted concurrent release must be healthy"
    for release in "$WEB"/releases/release-*; do
        assert_file "$release/index.html" "concurrency left a partial release"
        assert_file "$release/assets/x" "concurrency left a release without assets"
    done
}

case_same_second() {
    local first_target
    local second_target
    local release

    /usr/bin/printf 'case 4: same-second collision safety\n' >&2
    new_fixture same-second

    env \
        DEPLOY_WEB="$WEB" \
        DEPLOY_SKIP_HEALTH=1 \
        DEPLOY_TEST_FIXED_DATE=1 \
        DEPLOY_TEST_EVENT_LOG="$EVENT_LOG" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        /usr/bin/timeout 10 "$DEPLOY" >"$FIXTURE/first.out" 2>&1
    first_target=$(current_target)
    env \
        DEPLOY_WEB="$WEB" \
        DEPLOY_SKIP_HEALTH=1 \
        DEPLOY_TEST_FIXED_DATE=1 \
        DEPLOY_TEST_EVENT_LOG="$EVENT_LOG" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        /usr/bin/timeout 10 "$DEPLOY" >"$FIXTURE/second.out" 2>&1
    second_target=$(current_target)

    assert_eq 2 "$(release_count)" "same-second deploys must create two releases"
    [[ $first_target != "$second_target" ]] || fail "same-second releases must have distinct PID suffixes"
    for release in "$WEB"/releases/release-*; do
        [[ $(/usr/bin/basename -- "$release") =~ ^release-20300102T030405Z-[0-9]+$ ]] ||
            fail "release lacks timestamp-PID identity: $release"
        assert_file "$release/index.html" "same-second build was not preserved"
        assert_file "$release/.healthy" "same-second build was not marked healthy"
    done
    if /usr/bin/find "$WEB/releases" -mindepth 2 -type d -name webapp -print -quit |
        /usr/bin/grep -q .; then
        fail "same-second deploy nested webapp under an existing release"
    fi
}

case_failing_health() {
    local release_a
    local release_b
    local release
    local status=0
    local unhealthy_count=0

    /usr/bin/printf 'case 5: failing-health rollback and previous integrity\n' >&2
    new_fixture failing-health
    release_a=$(seed_release release-a 100)
    release_b=$(seed_release release-b 200)
    /usr/bin/ln -s -- "releases/$(/usr/bin/basename -- "$release_b")" "$WEB/current"
    /usr/bin/ln -s -- "$release_a" "$WEB/previous"
    start_503_server "$FIXTURE/request.txt"

    env \
        DEPLOY_WEB="$WEB" \
        DEPLOY_SKIP_HEALTH=0 \
        DEPLOY_HEALTH_URL="$SERVER_URL" \
        DEPLOY_TEST_CURL_REQUEST_FILE="$FIXTURE/curl-request.txt" \
        DEPLOY_TEST_CURL_STATUS="$SERVER_CURL_STATUS" \
        DEPLOY_TEST_EVENT_LOG="$EVENT_LOG" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        /usr/bin/timeout 10 "$DEPLOY" >"$FIXTURE/deploy.out" 2>&1 || status=$?
    stop_server

    assert_eq 1 "$status" "503 deploy must fail without a nested-lock timeout"
    assert_contains "$FIXTURE/curl-request.txt" "$SERVER_URL" \
        "503 fixture did not receive the deploy health request"
    assert_eq "$release_b" "$(current_target)" "503 deploy must restore current to B"
    assert_eq "$release_a" "$(/usr/bin/readlink -e -- "$WEB/previous")" \
        "503 deploy must leave previous pointing at A"
    for release in "$WEB"/releases/release-*; do
        if [[ ! -f $release/.healthy ]]; then
            unhealthy_count=$((unhealthy_count + 1))
        fi
    done
    assert_eq 1 "$unhealthy_count" "failed release must remain without .healthy"
    assert_contains "$EVENT_LOG" '"phase":"health-fail-rolledback"' \
        "missing health-fail-rolledback event"
}

case_unhealthy_rollback_skip() {
    local release_a
    local release_b
    local release_c

    /usr/bin/printf 'case 6: un-.healthy rollback skip\n' >&2
    new_fixture rollback-skip
    release_a=$(seed_release release-a 100)
    release_b=$(seed_release release-b 200)
    release_c=$WEB/releases/release-c
    /usr/bin/mkdir -p -- "$release_c/assets"
    /usr/bin/printf 'release-c\n' >"$release_c/index.html"
    /usr/bin/printf 'release-c\n' >"$release_c/assets/x"
    /usr/bin/touch -d '@300' -- "$release_c"
    /usr/bin/ln -s -- "$release_b" "$WEB/current"
    /usr/bin/ln -s -- "$release_c" "$WEB/previous"

    run_healthy_deploy --rollback >"$FIXTURE/rollback.out" 2>&1
    assert_eq "$release_a" "$(current_target)" \
        "rollback must skip the mtime-newest un-.healthy release"
    assert_no_file "$release_c/.healthy" "rollback must not bless an unverified release"
}

run_eight_deploys() {
    local index
    local target

    DEPLOYED_RELEASES=()
    for ((index = 1; index <= 8; index++)); do
        run_healthy_deploy >"$FIXTURE/deploy-$index.out" 2>&1
        target=$(current_target)
        /usr/bin/touch -d "@$((100 + index))" -- "$target"
        DEPLOYED_RELEASES+=("$target")
        assert_eq "$index" "$(release_count)" "plain deploy deleted a release at run $index"
    done
}

case_prune() {
    local current
    local previous

    /usr/bin/printf 'case 7: operator prune boundary\n' >&2
    new_fixture prune-newest
    run_eight_deploys
    current=$(current_target)
    previous=$(/usr/bin/readlink -e -- "$WEB/previous")
    env \
        DEPLOY_WEB="$WEB" \
        DEPLOY_KEEP=5 \
        DEPLOY_SKIP_HEALTH=1 \
        DEPLOY_TEST_EVENT_LOG="$EVENT_LOG" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        /usr/bin/timeout 10 "$DEPLOY" --prune --yes >"$FIXTURE/prune.out" 2>&1
    assert_eq 5 "$(release_count)" "prune must retain exactly the newest five when pointers are within them"
    assert_file "$current/.healthy" "prune deleted current"
    assert_file "$previous/.healthy" "prune deleted previous"

    new_fixture prune-protected-old
    run_eight_deploys
    current=$(current_target)
    previous=${DEPLOYED_RELEASES[0]}
    /usr/bin/ln -sfn -- "$previous" "$WEB/previous"
    env \
        DEPLOY_WEB="$WEB" \
        DEPLOY_KEEP=5 \
        DEPLOY_SKIP_HEALTH=1 \
        DEPLOY_TEST_EVENT_LOG="$EVENT_LOG" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        /usr/bin/timeout 10 "$DEPLOY" --prune --yes >"$FIXTURE/prune.out" 2>&1
    assert_eq 6 "$(release_count)" "prune must retain newest five plus an old protected previous"
    assert_file "$current/.healthy" "prune deleted current"
    assert_file "$previous/.healthy" "prune deleted protected old previous"
}

case_kill_during_rollback() {
    local release_a
    local release_b

    /usr/bin/printf 'case 8: kill during rollback\n' >&2
    new_fixture kill-rollback
    release_a=$(seed_release release-a 100)
    release_b=$(seed_release release-b 200)
    /usr/bin/ln -s -- "$release_b" "$WEB/current"
    /usr/bin/ln -s -- "$release_a" "$WEB/previous"

    kill_at_boundary before-current-mv --rollback
    assert_eq "$release_b" "$(current_target)" \
        "kill before rollback mv must leave original current intact"
    assert_file "$(current_target)/.healthy" "kill during rollback left current unhealthy"
}

case_sanity_gate() {
    local old_target
    local release
    local status=0
    local unhealthy_count=0

    /usr/bin/printf 'case 9: sanity-gate failure\n' >&2
    new_fixture sanity-fail
    old_target=$(seed_release release-a 100)
    /usr/bin/ln -s -- "$old_target" "$WEB/current"

    env \
        DEPLOY_WEB="$WEB" \
        DEPLOY_SKIP_HEALTH=1 \
        DEPLOY_TEST_BUILD_MODE=missing-index \
        DEPLOY_TEST_EVENT_LOG="$EVENT_LOG" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        /usr/bin/timeout 10 "$DEPLOY" >"$FIXTURE/deploy.out" 2>&1 || status=$?

    assert_eq 1 "$status" "incomplete build must fail the sanity gate"
    assert_eq "$old_target" "$(current_target)" "sanity failure must not flip current"
    assert_no_file "$WEB/current.tmp" "sanity failure must abort before staging a pointer"
    assert_eq 2 "$(release_count)" "sanity-failed release must be left in place"
    for release in "$WEB"/releases/release-*; do
        if [[ ! -f $release/.healthy ]]; then
            unhealthy_count=$((unhealthy_count + 1))
            assert_no_file "$release/index.html" "sanity fixture unexpectedly contains index.html"
        fi
    done
    assert_eq 1 "$unhealthy_count" "sanity-failed release must remain un-.healthy"
    assert_contains "$EVENT_LOG" '"phase":"sanity-fail"' "missing sanity-fail event"
}

case_first_health_failure() {
    local release
    local status=0

    /usr/bin/printf 'case 10: first-ever deploy health failure\n' >&2
    new_fixture first-health-fail
    start_503_server "$FIXTURE/request.txt"

    env \
        DEPLOY_WEB="$WEB" \
        DEPLOY_SKIP_HEALTH=0 \
        DEPLOY_HEALTH_URL="$SERVER_URL" \
        DEPLOY_TEST_CURL_REQUEST_FILE="$FIXTURE/curl-request.txt" \
        DEPLOY_TEST_CURL_STATUS="$SERVER_CURL_STATUS" \
        DEPLOY_TEST_EVENT_LOG="$EVENT_LOG" \
        PATH="$STUB_BIN:$ORIGINAL_PATH" \
        /usr/bin/timeout 10 "$DEPLOY" >"$FIXTURE/deploy.out" 2>&1 || status=$?
    stop_server

    assert_eq 1 "$status" "first-ever 503 deploy must fail"
    assert_contains "$FIXTURE/curl-request.txt" "$SERVER_URL" \
        "503 fixture did not receive the first-deploy health request"
    assert_eq 1 "$(release_count)" "first-ever failure must leave its release in place"
    release=$(current_target)
    assert_file "$release/index.html" "first-ever failure must leave current on the built release"
    assert_no_file "$release/.healthy" "first-ever failed release must remain un-.healthy"
    [[ ! -e $WEB/previous ]] || fail "first-ever failure must not create previous"
    assert_contains "$EVENT_LOG" '"phase":"health-fail-no-prev"' \
        "missing health-fail-no-prev event"
}

[[ -x $DEPLOY ]] || fail "deploy script is not executable: $DEPLOY"
case_no_gap
case_kill_injection
case_concurrency
case_same_second
case_failing_health
case_unhealthy_rollback_skip
case_prune
case_kill_during_rollback
case_sanity_gate
case_first_health_failure
/usr/bin/printf 'all deploy harness cases passed\n' >&2
