#!/usr/bin/env bash

# Copyright 2026 Matron Contributors.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
# Please see LICENSE files in the repository root for full details.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -v DEPLOY_WEB && -z $DEPLOY_WEB ]]; then
    echo "DEPLOY_WEB must not be empty" >&2
    exit 1
fi

WEB=${DEPLOY_WEB:-$(cd -- "$SCRIPT_DIR/.." && pwd)}

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
    local priority=$2
    local release=${3-}
    local reason=${4-}
    local payload
    local ts

    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf -v payload \
        '{"ts":"%s","action":"recover","phase":"%s","release":"%s","reason":"%s"}' \
        "$(json_escape "$ts")" \
        "$(json_escape "$phase")" \
        "$(json_escape "$release")" \
        "$(json_escape "$reason")"
    printf '%s\n' "$payload" >&2
    if ! logger -p "$priority" -t matron-web-recover -- "$payload"; then
        echo "failed to send recovery event to the system logger" >&2
    fi
}

main() {
    local candidate
    local candidate_entry
    local current_target
    local lock_status=0
    local newest_healthy=""
    local releases_root

    if ! WEB=$(realpath -- "$WEB" 2>/dev/null); then
        echo "recovery root does not exist" >&2
        log_event fs-assert-fail daemon.err "" "recovery root does not exist"
        return 1
    fi

    if ! { exec 9>"$WEB/.deploy.lock"; }; then
        echo "cannot open deployment lock" >&2
        log_event fs-assert-fail daemon.err "" "cannot open deployment lock"
        return 1
    fi
    flock -E 75 -w 30 9 || lock_status=$?
    if ((lock_status == 75)); then
        log_event lock-contended daemon.warning "" \
            "deployment lock remained contended after 30 seconds"
        return 0
    elif ((lock_status != 0)); then
        echo "failed to acquire deployment lock" >&2
        log_event fs-assert-fail daemon.err "" \
            "flock failed while acquiring the deployment lock (exit $lock_status)"
        return 1
    fi

    releases_root=$(readlink -f -- "$WEB/releases" 2>/dev/null || true)
    current_target=$(readlink -f -- "$WEB/current" 2>/dev/null || true)
    if [[ -n $releases_root && -n $current_target &&
        $(dirname -- "$current_target") == "$releases_root" &&
        $(basename -- "$current_target") == release-* &&
        -f $current_target/.healthy ]]; then
        log_event already-healthy daemon.info "$current_target" \
            "current already resolves to a healthy release"
        return 0
    fi

    if [[ -d $WEB/releases ]]; then
        while IFS= read -r -d '' candidate_entry; do
            candidate=${candidate_entry#* }
            if [[ -f $candidate/.healthy ]]; then
                newest_healthy=$candidate
                break
            fi
        done < <(
            find "$WEB/releases" -mindepth 1 -maxdepth 1 -type d \
                -name 'release-*' -printf '%T@ %p\0' | sort -z -nr
        )
    fi

    if [[ -z $newest_healthy ]]; then
        log_event no-healthy-release daemon.err "" \
            "no healthy release is available; current was not changed"
        return 1
    fi

    if ! ln -sfnT "releases/$(basename -- "$newest_healthy")" "$WEB/current.tmp"; then
        echo "failed to stage recovery pointer" >&2
        log_event fs-assert-fail daemon.err "$newest_healthy" \
            "failed to stage recovery pointer"
        return 1
    fi
    if ! mv -T -- "$WEB/current.tmp" "$WEB/current"; then
        echo "failed to atomically install recovery pointer" >&2
        log_event fs-assert-fail daemon.err "$newest_healthy" \
            "failed to atomically install recovery pointer"
        return 1
    fi

    log_event recovered daemon.info "$newest_healthy" \
        "current was atomically repointed to the newest healthy release"
}

main "$@"
