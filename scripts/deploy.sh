#!/usr/bin/env bash

# Copyright 2026 Matron Contributors.
#
# SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
# Please see LICENSE files in the repository root for full details.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
WEB=${DEPLOY_WEB:-$(cd -- "$SCRIPT_DIR/.." && pwd)}
HEALTH_URL=${DEPLOY_HEALTH_URL:-http://127.0.0.1:8082/}
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

# Callers must hold the shared fd-9 deployment lock.
rollback_command() {
    local candidate
    local candidate_entry
    local current_target
    local releases_root
    local target

    releases_root=$(readlink -f -- "$WEB/releases" 2>/dev/null || true)
    current_target=$(readlink -f -- "$WEB/current" 2>/dev/null || true)
    target=$(readlink -e -- "$WEB/previous" 2>/dev/null || true)

    if [[ -z $target || $(dirname -- "$target") != "$releases_root" ||
        ! -f $target/.healthy || $target == "$current_target" ]]; then
        target=""
    fi

    if [[ -z $target ]]; then
        while IFS= read -r -d '' candidate_entry; do
            candidate=${candidate_entry#* }
            if [[ -f $candidate/.healthy && $candidate != "$current_target" ]]; then
                target=$candidate
                break
            fi
        done < <(
            find "$WEB/releases" -mindepth 1 -maxdepth 1 -type d \
                -name 'release-*' -printf '%T@ %p\0' | sort -z -nr
        )
    fi

    if [[ -z $target ]]; then
        echo "no servable prior release" >&2
        log_event rollback rollback "" "$current_target"
        return 1
    fi

    if ! rollback_to "$target"; then
        log_event rollback rollback "$target" "$current_target"
        return 1
    fi

    if [[ -n $current_target ]]; then
        if ! ln -sfn "$current_target" "$WEB/previous.tmp"; then
            echo "failed to stage previous pointer after rollback" >&2
            log_event fs-assert-fail rollback "$target" "$current_target"
            return 1
        fi
        if ! mv -T -- "$WEB/previous.tmp" "$WEB/previous"; then
            echo "failed to atomically install previous pointer after rollback" >&2
            log_event fs-assert-fail rollback "$target" "$current_target"
            return 1
        fi
    fi

    log_event rollback rollback "$target" "$current_target"
}

# Callers must hold the shared fd-9 deployment lock.
prune_command() {
    local assume_yes=$1
    local confirmation
    local current_target
    local entry
    local index
    local keep_count
    local previous_target
    local release
    local -a prune_candidates=()
    local -a release_entries=()
    local -A retained=()

    if [[ ! $KEEP =~ ^[0-9]+$ ]]; then
        echo "DEPLOY_KEEP must be a non-negative integer" >&2
        log_event sanity-fail
        return 1
    fi
    keep_count=$((10#$KEEP))

    mapfile -d '' -t release_entries < <(
        find "$WEB/releases" -mindepth 1 -maxdepth 1 -type d \
            -name 'release-*' -printf '%T@ %p\0' | sort -z -nr
    )

    for ((index = 0; index < ${#release_entries[@]} && index < keep_count; index++)); do
        release=${release_entries[index]#* }
        retained["$release"]=1
    done

    current_target=$(readlink -f -- "$WEB/current" 2>/dev/null || true)
    previous_target=$(readlink -f -- "$WEB/previous" 2>/dev/null || true)
    if [[ -n $current_target ]]; then
        retained["$current_target"]=1
    fi
    if [[ -n $previous_target ]]; then
        retained["$previous_target"]=1
    fi

    for entry in "${release_entries[@]}"; do
        release=${entry#* }
        if [[ ! -v 'retained[$release]' ]]; then
            prune_candidates+=("$release")
        fi
    done

    if ((${#prune_candidates[@]} == 0)); then
        log_event prune
        return 0
    fi

    if [[ $assume_yes != 1 ]]; then
        echo "The following release directories will be permanently deleted:" >&2
        printf '  %s\n' "${prune_candidates[@]}" >&2
        printf "Type 'yes' to confirm pruning: " >&2
        if ! IFS= read -r confirmation || [[ $confirmation != yes ]]; then
            echo "prune cancelled" >&2
            log_event prune
            return 1
        fi
    fi

    if ! rm -rf -- "${prune_candidates[@]}"; then
        echo "failed to prune one or more releases" >&2
        log_event fs-assert-fail
        return 1
    fi

    log_event prune
}

main() {
    local assume_yes=0
    local command=deploy
    local releases_device
    local web_device

    case ${1-} in
        "")
            if (($# != 0)); then
                echo "usage: $0 [--rollback | --prune [--yes]]" >&2
                exit 2
            fi
            ;;
        --rollback)
            if (($# != 1)); then
                echo "usage: $0 --rollback" >&2
                exit 2
            fi
            command=rollback
            ;;
        --prune)
            if (($# == 2)) && [[ $2 == --yes ]]; then
                assume_yes=1
            elif (($# != 1)); then
                echo "usage: $0 --prune [--yes]" >&2
                exit 2
            fi
            command=prune
            ;;
        *)
            echo "usage: $0 [--rollback | --prune [--yes]]" >&2
            exit 2
            ;;
    esac

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

    case $command in
        rollback)
            rollback_command
            return
            ;;
        prune)
            prune_command "$assume_yes"
            return
            ;;
    esac

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
