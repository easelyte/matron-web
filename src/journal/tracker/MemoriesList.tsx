/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The Memories list — the user's standing rules and facts, one row per memory (name, type,
 * one-line description, last update), sorted by name by the client. A "New memory" button opens
 * the editor for a fresh one. Purely presentational — the parent supplies the rows and handlers.
 */

import React from "react";

import type { Memory, MemoryType } from "../types";
import { formatRelativeTime, oneLine } from "./format";

export function memoryTypeLabel(type: MemoryType): string {
    switch (type) {
        case "user":
            return "About you";
        case "feedback":
            return "How to work";
        case "project":
            return "Project";
        case "reference":
            return "Reference";
        default:
            return type;
    }
}

function MemoryRow({ memory, onOpen }: { memory: Memory; onOpen: (name: string) => void }): React.ReactElement {
    return (
        <button
            type="button"
            className="mj_TrackerMemoryRow"
            aria-label={`Memory ${memory.name}: ${oneLine(memory.description)}`}
            onClick={() => onOpen(memory.name)}
        >
            <span className="mj_TrackerMemoryRow_main">
                <span className="mj_TrackerMemoryRow_head">
                    <span className="mj_TrackerMemoryRow_name">{memory.name}</span>
                    <span className="mj_TrackerMemoryRow_type">{memoryTypeLabel(memory.type)}</span>
                </span>
                <span className="mj_TrackerMemoryRow_desc">{oneLine(memory.description)}</span>
                <span className="mj_TrackerMemoryRow_meta">
                    Updated {formatRelativeTime(memory.updated_at)} by{" "}
                    {memory.updated_by === "user" ? "you" : "an agent"}
                </span>
            </span>
        </button>
    );
}

export function MemoriesList({
    memories,
    onOpenMemory,
    onNewMemory,
}: {
    memories: Memory[];
    onOpenMemory: (name: string) => void;
    onNewMemory: () => void;
}): React.ReactElement {
    return (
        <div className="mj_TrackerList">
            <div className="mj_TrackerMemoriesHead">
                <p className="mj_TrackerCaption">
                    Standing rules and facts every agent can read. The Coordinator starts each session with this list.
                </p>
                <button type="button" className="mj_Btn mj_Btn_primary mj_TrackerButton" onClick={onNewMemory}>
                    New memory
                </button>
            </div>
            {memories.length === 0 ? (
                <div className="mj_TrackerEmpty">
                    <p className="mj_TrackerEmpty_title">No memories yet</p>
                    <p className="mj_TrackerEmpty_hint">
                        Tell an agent a rule about how you want work done and it saves one here, or add one yourself.
                    </p>
                </div>
            ) : (
                memories.map((memory) => <MemoryRow key={memory.id} memory={memory} onOpen={onOpenMemory} />)
            )}
        </div>
    );
}
