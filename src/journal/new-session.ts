/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * One-tap New session (redesign v6 surface C): the box's start options, the operator's
 * remembered defaults (client-side, per box — CONTRACTS 4), and the split button's hint.
 */

import { type RecentFolder } from "./types";

export type AgentKind = "claude" | "codex";

export interface ModelOption {
    value: string;
    label: string;
}

/** What a box offers for a new session: the bridge's `recent_folders` reply. */
export interface SessionOptions {
    folders: RecentFolder[];
    models: ModelOption[];
    /** The model a start with no pick runs on, when the box knows it. */
    defaultModel?: string;
    agents: AgentKind[];
    defaultAgent?: AgentKind;
    /** The folder a start with no workdir uses, when the box reports it. */
    defaultFolder?: string;
}

/** The operator's stored choice for one-tap start ("Remember as my defaults"). */
export interface RememberedDefaults {
    folder?: string;
    model?: string;
    agent?: AgentKind;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const asAgent = (value: unknown): AgentKind | undefined =>
    value === "claude" || value === "codex" ? value : undefined;

export function parseSessionOptions(result: unknown): SessionOptions {
    const body = isRecord(result) ? result : {};
    const folders = Array.isArray(body.folders)
        ? body.folders.flatMap((raw): RecentFolder[] => {
              if (!isRecord(raw) || typeof raw.path !== "string" || !raw.path) return [];
              const lastUsed =
                  typeof raw.last_used === "number" && Number.isFinite(raw.last_used) ? raw.last_used : null;
              return [{ path: raw.path, last_used: lastUsed }];
          })
        : [];
    const models = Array.isArray(body.model_options)
        ? body.model_options.flatMap((raw): ModelOption[] =>
              isRecord(raw) && typeof raw.value === "string" && raw.value
                  ? [{ value: raw.value, label: typeof raw.label === "string" && raw.label ? raw.label : raw.value }]
                  : [],
          )
        : [];
    const agents = Array.isArray(body.agent_options)
        ? body.agent_options.flatMap((raw): AgentKind[] => {
              const agent = asAgent(isRecord(raw) ? raw.value : raw);
              return agent ? [agent] : [];
          })
        : [];
    return {
        folders,
        models,
        defaultModel: typeof body.default_model === "string" && body.default_model ? body.default_model : undefined,
        agents: agents.length ? agents : ["claude"],
        defaultAgent: asAgent(body.default_agent),
        defaultFolder: typeof body.default_folder === "string" && body.default_folder ? body.default_folder : undefined,
    };
}

const rememberKey = (boxId: number | string): string => `matron.newSessionDefaults.${boxId}`;

export function readRememberedDefaults(boxId: number | string): RememberedDefaults | undefined {
    try {
        const raw = JSON.parse(localStorage.getItem(rememberKey(boxId)) ?? "null") as unknown;
        if (!isRecord(raw)) return undefined;
        return {
            folder: typeof raw.folder === "string" && raw.folder ? raw.folder : undefined,
            model: typeof raw.model === "string" && raw.model ? raw.model : undefined,
            agent: asAgent(raw.agent),
        };
    } catch {
        return undefined;
    }
}

export function writeRememberedDefaults(boxId: number | string, defaults: RememberedDefaults): void {
    try {
        localStorage.setItem(rememberKey(boxId), JSON.stringify(defaults));
    } catch {
        // Storage unavailable: the choice applies to this start only.
    }
}

export function basename(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Short model name for the hint: "Opus 4.5" → "Opus", "claude-sonnet-4-5" → "Sonnet". */
function shortModel(model: string, models: readonly ModelOption[]): string {
    const label = models.find((option) => option.value === model)?.label ?? model;
    const family = /(opus|sonnet|haiku|fable)/i.exec(label)?.[1];
    const first = family ?? label.split(/\s+/)[0] ?? label;
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * The split button's defaults hint ("Opus · workspace"), shown only when the defaults are
 * KNOWN: the agent/model and the folder. Undefined otherwise — never a guess.
 */
export function defaultsHint(
    remembered: RememberedDefaults | undefined,
    options: SessionOptions | undefined,
): string | undefined {
    const folder = remembered?.folder ?? options?.defaultFolder;
    const agent = remembered?.agent ?? options?.defaultAgent;
    const model = remembered?.model ?? options?.defaultModel;
    if (!folder) return undefined;
    if (agent === "codex") return `Codex · ${basename(folder)}`;
    if (!model) return undefined;
    return `${shortModel(model, options?.models ?? [])} · ${basename(folder)}`;
}

/** Start parameters for one tap: the remembered defaults, else the box's own (no picks). */
export function oneTapStart(remembered: RememberedDefaults | undefined): {
    workdir: string;
    model?: string;
    agent?: AgentKind;
    browser: false;
} {
    return {
        workdir: remembered?.folder ?? "",
        model: remembered?.agent === "codex" ? undefined : remembered?.model,
        agent: remembered?.agent,
        browser: false,
    };
}

const REMEMBERED_BOX_KEY = "matron.newSessionBox";

/** The box the operator last saved defaults for; one tap prefers it while it is connected. */
export function readRememberedBox(): number | undefined {
    try {
        const raw = Number(localStorage.getItem(REMEMBERED_BOX_KEY));
        return Number.isFinite(raw) && raw > 0 ? raw : undefined;
    } catch {
        return undefined;
    }
}

export function writeRememberedBox(boxId: number): void {
    try {
        localStorage.setItem(REMEMBERED_BOX_KEY, String(boxId));
    } catch {
        // Storage unavailable: one tap falls back to the first connected box.
    }
}

export function forgetRememberedDefaults(boxId: number | string): void {
    try {
        localStorage.removeItem(rememberKey(boxId));
    } catch {
        // Nothing to forget.
    }
}

/** The one-tap target: the remembered box when connected, else the first connected box. */
export function pickBox<T extends { device_id: number; connected: boolean }>(boxes: readonly T[]): T | undefined {
    const remembered = readRememberedBox();
    return boxes.find((box) => box.connected && box.device_id === remembered) ?? boxes.find((box) => box.connected);
}
