/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { type CSSProperties, type ReactNode } from "react";

export interface SgrState {
    fg: string | null;
    bold: boolean;
}

export interface ParseResult {
    nodes: ReactNode[];
    state: SgrState;
    tail: string;
}

export const INITIAL_SGR_STATE: SgrState = {
    fg: null,
    bold: false,
};

const ESC = "\x1b";
const MAX_NODES = 2000;

// 16-color foreground palette tuned for the dark terminal background.
const PALETTE: Record<number, string> = {
    30: "#8b909a",
    31: "#e06c75",
    32: "#98c379",
    33: "#e5c07b",
    34: "#61afef",
    35: "#c678dd",
    36: "#56b6c2",
    37: "#dcdcdc",
    90: "#a7adb8",
    91: "#ef8a93",
    92: "#b6e08e",
    93: "#f0d089",
    94: "#83c5f0",
    95: "#d692ec",
    96: "#80c8d1",
    97: "#ffffff",
};

function spanStyle(state: SgrState): CSSProperties {
    const style: CSSProperties = {};
    if (state.fg) style.color = state.fg;
    if (state.bold) style.fontWeight = 600;
    return style;
}

function isStyled(state: SgrState): boolean {
    return state.fg !== null || state.bold;
}

function applyParam(state: SgrState, param: number): void {
    if (param === 0) {
        state.fg = null;
        state.bold = false;
    } else if (param === 1) {
        state.bold = true;
    } else if (param === 22) {
        state.bold = false;
    } else if (param === 39) {
        state.fg = null;
    } else if ((param >= 30 && param <= 37) || (param >= 90 && param <= 97)) {
        state.fg = PALETTE[param] ?? null;
    }
    // Background, inverse, dim, and unsupported single parameters are ignored.
}

function applyParams(state: SgrState, params: number[]): void {
    let i = 0;
    while (i < params.length) {
        const param = params[i];
        if (param === 38 || param === 48) {
            const colorMode = params[i + 1];
            if (colorMode === 5) {
                i += 3;
                continue;
            }
            if (colorMode === 2) {
                i += 5;
                continue;
            }
        }
        applyParam(state, param);
        i++;
    }
}

// Parse a chunk of text containing ANSI SGR escapes into React nodes.
// Maintains style state and a tail of any incomplete escape sequence so chunks
// split mid-escape by the WebSocket transport render correctly.
export function parseAnsi(input: string, prevState: SgrState, prevTail: string, startKey: number): ParseResult {
    const buffer = prevTail + input;
    const state: SgrState = { ...prevState };
    const nodes: ReactNode[] = [];
    const plainText: string[] = [];
    let usePlainText = false;
    let textStart = 0;
    let i = 0;
    let key = startKey;

    const flushText = (end: number): void => {
        if (end <= textStart) return;
        const text = buffer.slice(textStart, end);
        plainText.push(text);
        if (nodes.length >= MAX_NODES) {
            usePlainText = true;
            return;
        }
        if (isStyled(state)) {
            nodes.push(
                <span key={key++} style={spanStyle(state)}>
                    {text}
                </span>,
            );
        } else {
            nodes.push(text);
        }
    };

    while (i < buffer.length) {
        if (buffer[i] !== ESC) {
            i++;
            continue;
        }
        // Found ESC. Need at least ESC + '[' + ... + final byte.
        if (i + 1 >= buffer.length) break; // incomplete, hold in tail
        if (buffer[i + 1] !== "[") {
            // Non-CSI escape: drop the ESC and the next byte from output.
            flushText(i);
            i += 2;
            textStart = i;
            continue;
        }
        // CSI: scan for final byte in range @–~ (0x40–0x7e).
        let j = i + 2;
        while (j < buffer.length) {
            const code = buffer.charCodeAt(j);
            if (code >= 0x40 && code <= 0x7e) break;
            j++;
        }
        if (j >= buffer.length) break; // incomplete sequence, hold in tail

        flushText(i);
        const final = buffer[j];
        const params = buffer.slice(i + 2, j);
        if (final === "m") {
            const parts = params.length === 0 ? [0] : params.split(";").map((p) => (p === "" ? 0 : Number(p)));
            applyParams(state, parts);
        }
        // Non-SGR CSI sequences (cursor moves, etc.) are stripped.
        i = j + 1;
        textStart = i;
    }

    flushText(i);
    return { nodes: usePlainText ? [plainText.join("")] : nodes, state, tail: buffer.slice(i) };
}

// A head-truncated stream can begin after ESC while retaining the rest of SGR.
// Other cut offsets intentionally remain visible as a documented residual.
export function stripLeadingSgrFragment(content: string): string {
    return content.replace(/^\[[0-9;]*m/, "");
}
