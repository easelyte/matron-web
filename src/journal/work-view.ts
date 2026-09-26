/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import {
    WORK_VIEW_ERROR_CODE_VALUES,
    WORK_VIEW_GROUP_BY_VALUES,
    WORK_VIEW_LIVENESS_VALUES,
    WORK_VIEW_LOOP_STATUS_VALUES,
    type WorkViewClaim,
    type WorkViewEnvelope,
    type WorkViewError,
    type WorkViewGroup,
    type WorkViewLoop,
} from "../contracts/work-view.generated";

export type {
    WorkViewClaim,
    WorkViewEmptyEnvelope,
    WorkViewEnvelope,
    WorkViewError,
    WorkViewErrorEnvelope,
    WorkViewGroup,
    WorkViewLoop,
    WorkViewOkEnvelope,
} from "../contracts/work-view.generated";

export type WorkViewGroupBy = WorkViewEnvelope["group_by"];

export class WorkViewParseError extends Error {}

function fail(reason: string): never {
    throw new WorkViewParseError(`The journal server returned a malformed Work response (${reason}).`);
}

function record(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} is not an object`);
    return value as Record<string, unknown>;
}

function exactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
    name: string,
    optionalKeys: readonly string[] = [],
): void {
    const actual = Object.keys(value);
    const allowed = new Set([...keys, ...optionalKeys]);
    if (actual.some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
        fail(`${name} has unexpected fields`);
    }
}

function enumValue<T extends string>(value: unknown, values: readonly T[], name: string): T {
    if (typeof value !== "string" || !values.includes(value as T)) fail(`${name} is invalid`);
    return value as T;
}

function stringValue(value: unknown, name: string, allowEmpty = true): string {
    if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(`${name} is invalid`);
    return value;
}

function dateTimeValue(value: unknown, name: string): string {
    const parsed = stringValue(value, name, false);
    const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    if (!rfc3339.test(parsed) || Number.isNaN(Date.parse(parsed))) fail(`${name} is invalid`);
    return parsed;
}

function parseClaim(value: unknown): WorkViewClaim | null {
    if (value === null) return null;
    const claim = record(value, "claim");
    exactKeys(claim, ["convo_id", "holder_label", "claimed_at", "liveness"], "claim");
    if (claim.holder_label !== null && typeof claim.holder_label !== "string") fail("holder_label is invalid");
    return {
        convo_id: stringValue(claim.convo_id, "convo_id"),
        holder_label: claim.holder_label,
        claimed_at: dateTimeValue(claim.claimed_at, "claimed_at"),
        liveness: enumValue(claim.liveness, WORK_VIEW_LIVENESS_VALUES, "liveness"),
    };
}

/**
 * Loop fields a server MAY send. Journals that predate them omit them, so every consumer treats
 * them as absent-able; when present they are validated as strictly as the required fields.
 */
const OPTIONAL_LOOP_KEYS = ["opened", "next_action", "owner"] as const;

function parseLoop(value: unknown): WorkViewLoop {
    const loop = record(value, "loop");
    exactKeys(
        loop,
        ["id", "title", "repo", "domain", "priority", "description", "status", "claim"],
        "loop",
        OPTIONAL_LOOP_KEYS,
    );
    if (!Number.isInteger(loop.id) || (loop.id as number) < 1) fail("loop id is invalid");
    if (!Number.isInteger(loop.priority) || (loop.priority as number) < 1 || (loop.priority as number) > 5) {
        fail("loop priority is invalid");
    }
    const parsed: WorkViewLoop = {
        id: loop.id as number,
        title: stringValue(loop.title, "loop title", false),
        repo: stringValue(loop.repo, "loop repo", false),
        domain: stringValue(loop.domain, "loop domain", false),
        priority: loop.priority as number,
        description: stringValue(loop.description, "loop description"),
        status: enumValue(loop.status, WORK_VIEW_LOOP_STATUS_VALUES, "loop status"),
        claim: parseClaim(loop.claim),
    };
    if (Object.hasOwn(loop, "opened")) parsed.opened = dateTimeValue(loop.opened, "loop opened");
    if (Object.hasOwn(loop, "next_action"))
        parsed.next_action = stringValue(loop.next_action, "loop next_action", false);
    if (Object.hasOwn(loop, "owner")) parsed.owner = stringValue(loop.owner, "loop owner", false);
    return parsed;
}

function parseGroup(value: unknown): WorkViewGroup {
    const group = record(value, "group");
    exactKeys(group, ["key", "loops"], "group");
    if (!Array.isArray(group.loops) || group.loops.length === 0) fail("group loops are empty or invalid");
    return {
        key: stringValue(group.key, "group key", false),
        loops: group.loops.map(parseLoop) as WorkViewGroup["loops"],
    };
}

function parseError(value: unknown): WorkViewError {
    const error = record(value, "error");
    exactKeys(error, ["code", "message"], "error");
    return {
        code: enumValue(error.code, WORK_VIEW_ERROR_CODE_VALUES, "error code"),
        message: stringValue(error.message, "error message", false),
    };
}

/** Parse the untrusted HTTP response into the schema-generated discriminated envelope type. */
export function parseWorkViewEnvelope(value: unknown): WorkViewEnvelope {
    const envelope = record(value, "envelope");
    if (envelope.schema_version !== 1) fail("schema_version is unsupported");
    const groupBy = enumValue(envelope.group_by, WORK_VIEW_GROUP_BY_VALUES, "group_by");

    if (envelope.status === "ok") {
        exactKeys(envelope, ["schema_version", "status", "group_by", "groups"], "ok envelope");
        if (!Array.isArray(envelope.groups) || envelope.groups.length === 0) fail("ok groups are empty or invalid");
        return {
            schema_version: 1,
            status: "ok",
            group_by: groupBy,
            groups: envelope.groups.map(parseGroup) as Extract<WorkViewEnvelope, { status: "ok" }>["groups"],
        };
    }
    if (envelope.status === "empty") {
        exactKeys(envelope, ["schema_version", "status", "group_by", "groups"], "empty envelope");
        if (!Array.isArray(envelope.groups) || envelope.groups.length !== 0) fail("empty groups are invalid");
        return { schema_version: 1, status: "empty", group_by: groupBy, groups: [] };
    }
    if (envelope.status === "error") {
        exactKeys(envelope, ["schema_version", "status", "group_by", "groups", "error"], "error envelope");
        if (!Array.isArray(envelope.groups) || envelope.groups.length !== 0) fail("error groups are invalid");
        return {
            schema_version: 1,
            status: "error",
            group_by: groupBy,
            groups: [],
            error: parseError(envelope.error),
        };
    }
    fail("status is invalid");
}
