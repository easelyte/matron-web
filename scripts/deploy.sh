#!/usr/bin/env bash

# Copyright 2026 Matron Contributors.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
# Please see LICENSE files in the repository root for full details.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
WEB=${DEPLOY_WEB:-$(cd -- "$SCRIPT_DIR/.." && pwd)}
HEALTH_URL=${DEPLOY_HEALTH_URL:-http://127.0.0.1:8082/}
# shellcheck disable=SC2034 # Used by the --prune command added in T-1.2.
KEEP=${DEPLOY_KEEP:-5}

REL=""
PREV_TARGET=""

json_escape() {
    local value=${1-}

    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    value=${value//$'\n'/\\n}
    value=${value//$'\r'/\\r}
    value=${value//$'\t'/\\t}
    printf '%s' "$value"
}

log_event() {
    local phase=$1
    local action=${2:-deploy}
    local release=${3:-$REL}
    local prev_target=${4:-$PREV_TARGET}
    local payload
    local ts

    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf -v payload \
        '{"ts":"%s","action":"%s","phase":"%s","release":"%s","prev_target":"%s"}' \
        "$(json_escape "$ts")" \
        "$(json_escape "$action")" \
        "$(json_escape "$phase")" \
        "$(json_escape "$release")" \
        "$(json_escape "$prev_target")"
    logger -t matron-web-deploy -- "$payload" || true
}

# Callers must hold the shared fd-9 deployment lock.
rollback_to() {
    local requested_target=${1-}
    local releases_root
    local target
    local current_target

    releases_root=$(readlink -f -- "$WEB/releases" 2>/dev/null || true)
    target=$(readlink -f -- "$requested_target" 2>/dev/null || true)

    if [[ -z $releases_root || -z $target || $(dirname -- "$target") != "$releases_root" ]]; then
        echo "rollback target must be a release under $WEB/releases" >&2
        return 1
    fi
    if [[ ! -d $target || ! -f $target/.healthy ]]; then
        echo "rollback target is not a healthy release: $target" >&2
        return 1
    fi

    current_target=$(readlink -f -- "$WEB/current" 2>/dev/null || true)
    if [[ $target == "$current_target" ]]; then
        echo "rollback target is already current: $target" >&2
        return 1
    fi

    if ! ln -sfn "releases/$(basename -- "$target")" "$WEB/current.tmp"; then
        echo "failed to stage rollback pointer" >&2
        return 1
    fi
    if ! mv -T -- "$WEB/current.tmp" "$WEB/current"; then
        echo "failed to atomically install rollback pointer" >&2
        return 1
    fi
}

main() {
    local releases_device
    local web_device

    if ! WEB=$(realpath -- "$WEB" 2>/dev/null); then
        echo "deploy root does not exist" >&2
        log_event sanity-fail
        exit 1
    fi

    if [[ ${DEPLOY_SKIP_HEALTH:-0} == 1 && $WEB == /opt/matron/web-journal ]]; then
        echo "DEPLOY_SKIP_HEALTH=1 is forbidden for the production checkout" >&2
        log_event sanity-fail
        exit 1
    fi

    if ! { exec 9>"$WEB/.deploy.lock"; }; then
        echo "cannot open deployment lock" >&2
        log_event fs-assert-fail
        exit 1
    fi
    if ! flock -n 9; then
        echo "another deploy holds the lock" >&2
        log_event lock-contended
        exit 3
    fi

    if ! mkdir -p -- "$WEB/releases"; then
        echo "cannot create releases directory" >&2
        log_event fs-assert-fail
        exit 1
    fi
    if ! releases_device=$(stat -c %d -- "$WEB/releases") ||
        ! web_device=$(stat -c %d -- "$WEB") ||
        [[ $releases_device != "$web_device" ]]; then
        echo "deploy root and releases directory must share a filesystem" >&2
        log_event fs-assert-fail
        exit 1
    fi

    REL="$WEB/releases/release-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    if [[ -e $REL ]]; then
        echo "release id collision" >&2
        log_event release-id-collision
        exit 1
    fi

    if ! npm --prefix "$WEB" run build; then
        echo "release build failed" >&2
        log_event build-fail
        exit 1
    fi
    if [[ ! -d $WEB/webapp ]]; then
        echo "release build produced no webapp directory" >&2
        log_event sanity-fail
        exit 1
    fi
    if ! mv -- "$WEB/webapp" "$REL"; then
        echo "failed to stage release" >&2
        log_event build-fail
        exit 1
    fi

    if [[ ! -f $REL/index.html || ! -d $REL/assets ]] ||
        [[ -z $(find "$REL/assets" -mindepth 1 -print -quit) ]]; then
        echo "release failed the index/assets sanity gate" >&2
        log_event sanity-fail
        exit 1
    fi

    if [[ -e $WEB/current ]]; then
        PREV_TARGET=$(readlink -f -- "$WEB/current" 2>/dev/null || true)
    else
        PREV_TARGET=""
    fi

    if ! ln -sfn "releases/$(basename -- "$REL")" "$WEB/current.tmp"; then
        echo "failed to stage current pointer" >&2
        log_event fs-assert-fail
        exit 1
    fi
    if ! mv -T -- "$WEB/current.tmp" "$WEB/current"; then
        echo "failed to atomically install current pointer" >&2
        log_event fs-assert-fail
        exit 1
    fi
    log_event flip-ok

    if [[ ${DEPLOY_SKIP_HEALTH:-0} == 1 ]] || curl -fsS -o /dev/null "$HEALTH_URL"; then
        if ! touch -- "$REL/.healthy"; then
            echo "health passed but the release could not be marked healthy" >&2
            log_event fs-assert-fail
            exit 1
        fi

        if [[ -n $PREV_TARGET ]]; then
            if ! ln -sfn "$PREV_TARGET" "$WEB/previous.tmp"; then
                echo "failed to stage previous pointer" >&2
                log_event fs-assert-fail
                exit 1
            fi
            if ! mv -T -- "$WEB/previous.tmp" "$WEB/previous"; then
                echo "failed to atomically install previous pointer" >&2
                log_event fs-assert-fail
                exit 1
            fi
        fi

        log_event success
        exit 0
    fi

    if [[ -n $PREV_TARGET ]] && rollback_to "$PREV_TARGET"; then
        log_event health-fail-rolledback
        exit 1
    fi

    echo "health check failed and no healthy prior release is available" >&2
    log_event health-fail-no-prev
    exit 1
}

main "$@"
