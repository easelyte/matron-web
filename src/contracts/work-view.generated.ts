/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.

GENERATED FILE — DO NOT EDIT.
Source: src/contracts/work-view.schema.json
Source SHA-256: f2fad11f4cd7e3b9520bb397ee909aeec224f4155c15f01423d4a3c3c02488c9
Regenerate: node src/contracts/generate-work-view-types.cjs
*/

export interface WorkViewGroup {
    key: string;
    loops: [WorkViewLoop, ...WorkViewLoop[]];
}

export interface WorkViewLoop {
    id: number;
    title: string;
    repo: string;
    domain: string;
    priority: number;
    description: string;
    status: "active" | "blocked" | "parked" | "paused";
    claim: null | WorkViewClaim;
    opened?: string;
    next_action?: string;
    owner?: string;
}

export interface WorkViewClaim {
    convo_id: string;
    holder_label: string | null;
    claimed_at: string;
    liveness: "live" | "stale" | "unknown";
}

export interface WorkViewError {
    code: "store_missing" | "store_corrupt" | "builder_failed" | "builder_timeout";
    message: string;
}

export interface WorkViewOkEnvelope {
    schema_version: 1;
    status: "ok";
    group_by: "repo" | "domain";
    groups: [WorkViewGroup, ...WorkViewGroup[]];
    error?: never;
}

export interface WorkViewEmptyEnvelope {
    schema_version: 1;
    status: "empty";
    group_by: "repo" | "domain";
    groups: [];
    error?: never;
}

export interface WorkViewErrorEnvelope {
    schema_version: 1;
    status: "error";
    group_by: "repo" | "domain";
    groups: [];
    error: WorkViewError;
}

export type WorkViewEnvelope = WorkViewOkEnvelope | WorkViewEmptyEnvelope | WorkViewErrorEnvelope;

export const WORK_VIEW_STATUS_VALUES = ["ok", "empty", "error"] as const;
export const WORK_VIEW_GROUP_BY_VALUES = ["repo", "domain"] as const;
export const WORK_VIEW_LOOP_STATUS_VALUES = ["active", "blocked", "parked", "paused"] as const;
export const WORK_VIEW_LIVENESS_VALUES = ["live", "stale", "unknown"] as const;
export const WORK_VIEW_ERROR_CODE_VALUES = [
    "store_missing",
    "store_corrupt",
    "builder_failed",
    "builder_timeout",
] as const;
