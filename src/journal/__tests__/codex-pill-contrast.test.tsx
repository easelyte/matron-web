/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../client";
import { SubagentStrip } from "../components";
import type { ClientState, Conversation, Session } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const MINIMUM_NON_TEXT_CONTRAST = 3;
const THEMES = ["light", "dark"] as const;
const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "tester",
};

function conversation(id: string, extra: Partial<Conversation> = {}): Conversation {
    return {
        id,
        title: id,
        session_state: "running",
        session_outcome: null,
        last_seq: 0,
        unread_count: 0,
        snippet: "",
        created_at: 0,
        parent_convo_id: null,
        read_up_to_seq: 0,
        ...extra,
    };
}

function signedInClient(conversations: Conversation[]): MatronJournalClient {
    const client = new MatronJournalClient();
    (client as unknown as { state: ClientState }).state = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: SESSION,
        conversations,
        selectedConversationId: "room",
        events: [],
        pendingMessages: [],
        connection: "online",
    };
    return client;
}

type Rgba = [number, number, number, number];

function rgbaChannels(color: string): Rgba {
    const hex = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
    if (hex) {
        const expanded = hex.length === 3 ? [...hex].map((channel) => `${channel}${channel}`).join("") : hex;
        return [
            ...([0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16)) as [
                number,
                number,
                number,
            ]),
            1,
        ];
    }
    const channels = color.match(/[\d.]+/g)?.map(Number);
    if (!channels || channels.length < 3 || channels.length > 4 || channels.some(Number.isNaN)) {
        throw new Error(`Expected an rgb color, received ${color}`);
    }
    const [red, green, blue, alpha = 1] = channels;
    return [red, green, blue, color.includes("%") ? alpha / 100 : alpha];
}

function resolveColor(color: string): string {
    const variable = color.match(/^var\((--[^,)]+)/)?.[1];
    if (!variable) return color;
    const resolved = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    if (!resolved) throw new Error(`Expected ${variable} to resolve to a color`);
    return resolveColor(resolved);
}

function declaredColor(selector: string, property: string, stylesheet: HTMLStyleElement): string {
    const rule = [...(stylesheet.sheet?.cssRules ?? [])].find(
        (candidate): candidate is CSSStyleRule =>
            "selectorText" in candidate && (candidate as CSSStyleRule).selectorText === selector,
    );
    const value = rule?.style.getPropertyValue(property).trim();
    if (!value) throw new Error(`Expected ${selector} to declare ${property}`);
    return resolveColor(value);
}

function declaredValue(selector: string, property: string, stylesheet: HTMLStyleElement): string {
    const rule = [...(stylesheet.sheet?.cssRules ?? [])].find(
        (candidate): candidate is CSSStyleRule =>
            "selectorText" in candidate && (candidate as CSSStyleRule).selectorText === selector,
    );
    const value = rule?.style.getPropertyValue(property).trim();
    if (!value) throw new Error(`Expected ${selector} to declare ${property}`);
    return value;
}

function composite(foreground: string, background: string): string {
    const [red, green, blue, alpha] = rgbaChannels(foreground);
    if (alpha === 1) return `rgb(${red} ${green} ${blue})`;
    const [backgroundRed, backgroundGreen, backgroundBlue] = rgbaChannels(background);
    return `rgb(${red * alpha + backgroundRed * (1 - alpha)} ${green * alpha + backgroundGreen * (1 - alpha)} ${blue * alpha + backgroundBlue * (1 - alpha)})`;
}

function relativeLuminance(color: string): number {
    const [red, green, blue] = rgbaChannels(color)
        .slice(0, 3)
        .map((channel) => {
            const normalized = channel / 255;
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
    const foregroundLuminance = relativeLuminance(foreground);
    const backgroundLuminance = relativeLuminance(background);
    return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
    );
}

describe("Codex and Claude pill non-text contrast", () => {
    let root: Root;
    let container: HTMLDivElement;
    let style: HTMLStyleElement;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        style = document.createElement("style");
        style.textContent = ["shell.pcss", "journal.pcss"]
            .map((file) => readFileSync(resolve(__dirname, "..", file), "utf8"))
            .join("\n");
        document.head.append(style);
    });

    beforeEach(() => {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        delete document.documentElement.dataset.theme;
    });

    afterAll(() => style.remove());

    it.each(THEMES)("keeps every rendered mark and outcome glyph at 3:1 in the %s theme", async (theme) => {
        document.documentElement.dataset.theme = theme;
        const conversations = [
            conversation("room"),
            conversation("room:codex:running", { parent_convo_id: "room" }),
            conversation("room:sub:running", { parent_convo_id: "room" }),
            conversation("room:codex:completed", {
                parent_convo_id: "room",
                session_state: "done",
                session_outcome: "completed",
            }),
            conversation("room:sub:completed", {
                parent_convo_id: "room",
                session_state: "done",
                session_outcome: "completed",
            }),
            conversation("room:codex:interrupted", {
                parent_convo_id: "room",
                session_state: "done",
                session_outcome: "interrupted",
            }),
            conversation("room:codex:failed", {
                parent_convo_id: "room",
                session_state: "done",
                session_outcome: "failed",
            }),
        ];
        const client = signedInClient(conversations);

        await act(async () =>
            root.render(<SubagentStrip client={client} state={client.getSnapshot()} mode="parent" />),
        );

        const pills = container.querySelectorAll<HTMLElement>(".mj_SubagentPill");
        expect(pills).toHaveLength(conversations.length - 1);
        expect(declaredValue(".mj_SubagentPill", "background", style)).toBe("var(--cpd-state-selected)");
        expect(declaredValue(".mj_SubagentPill_finished", "background", style)).toBe(
            "var(--cpd-color-bg-subtle-primary)",
        );
        const canvas = resolveColor("var(--cpd-color-bg-canvas-default)");
        const violations: Array<{ pill: string | null; glyph: string | null; ratio: number }> = [];
        for (const pill of pills) {
            // jsdom preserves custom properties in computed colors but does not resolve a
            // var() used by the background shorthand, so resolve the production rule directly.
            const declaredBackground = declaredColor(
                pill.classList.contains("mj_SubagentPill_finished") ? ".mj_SubagentPill_finished" : ".mj_SubagentPill",
                "background",
                style,
            );
            const background = composite(declaredBackground, canvas);
            const glyphs = pill.querySelectorAll<HTMLElement>(".mj_WorkerMark, .mj_Spinner, .mj_SubagentPill_icon");
            expect(glyphs.length).toBeGreaterThanOrEqual(2);
            for (const glyph of glyphs) {
                const computed = getComputedStyle(glyph);
                const foregroundColors = glyph.classList.contains("mj_Spinner")
                    ? [
                          computed.borderTopColor,
                          computed.borderRightColor,
                          computed.borderBottomColor,
                          computed.borderLeftColor,
                      ]
                    : [computed.color];
                for (const foregroundColor of foregroundColors) {
                    const ratio = contrastRatio(composite(resolveColor(foregroundColor), background), background);
                    if (ratio < MINIMUM_NON_TEXT_CONTRAST) {
                        violations.push({ pill: pill.textContent, glyph: glyph.getAttribute("class"), ratio });
                    }
                }
            }
        }
        expect(violations).toEqual([]);
    });

    it.each(THEMES)(
        "keeps the spinner moving and every border at 3:1 on both pill backgrounds in the %s theme",
        async (theme) => {
            document.documentElement.dataset.theme = theme;
            const conversations = [
                conversation("room"),
                conversation("room:codex:running", { parent_convo_id: "room" }),
            ];
            const client = signedInClient(conversations);

            await act(async () =>
                root.render(<SubagentStrip client={client} state={client.getSnapshot()} mode="parent" />),
            );

            const spinner = container.querySelector<HTMLElement>(".mj_SubagentPill .mj_Spinner");
            expect(spinner).not.toBeNull();
            const computed = getComputedStyle(spinner!);
            const borderColors = [
                computed.borderTopColor,
                computed.borderRightColor,
                computed.borderBottomColor,
                computed.borderLeftColor,
            ].map(resolveColor);
            expect(new Set(borderColors).size).toBeGreaterThan(1);

            const canvas = resolveColor("var(--cpd-color-bg-canvas-default)");
            const backgrounds = [".mj_SubagentPill", ".mj_SubagentPill_finished"].map((selector) =>
                composite(declaredColor(selector, "background", style), canvas),
            );
            for (const borderColor of borderColors) {
                for (const background of backgrounds) {
                    expect(contrastRatio(composite(borderColor, background), background)).toBeGreaterThanOrEqual(
                        MINIMUM_NON_TEXT_CONTRAST,
                    );
                }
            }
        },
    );
});
