/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import fs from "node:fs";
import path from "node:path";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import postcss, { type Rule } from "postcss";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

import { MatronJournalClient } from "../client";
import { MatronApp } from "../components";
import { SearchField } from "../search-field";
import type { ClientState, Conversation } from "../types";

const DIR = path.join(__dirname, "..");

function Harness({ initial = "", onValue }: { initial?: string; onValue?: (v: string) => void }): React.ReactElement {
    const [value, setValue] = useState(initial);
    return (
        <SearchField
            label="Search things"
            placeholder="Search"
            value={value}
            onChange={(next) => {
                setValue(next);
                onValue?.(next);
            }}
        />
    );
}

async function mount(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.append(container);
    let root!: Root;
    await act(async () => {
        root = createRoot(container);
        root.render(element);
    });
    return { container, root };
}

async function type(input: HTMLInputElement, text: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
        setter.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

async function press(target: HTMLElement, key: string): Promise<KeyboardEvent> {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => void target.dispatchEvent(event));
    return event;
}

const clearButton = (container: HTMLElement): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]');

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
    document.body.innerHTML = "";
});

describe("SearchField", () => {
    it("shows the clear button only while there is text, with an accessible label", async () => {
        const { container, root } = await mount(<Harness />);
        const input = container.querySelector<HTMLInputElement>('input[aria-label="Search things"]')!;
        expect(input.type).toBe("search");
        expect(clearButton(container)).toBeNull();

        await type(input, "abc");
        const clear = clearButton(container)!;
        expect(clear).not.toBeNull();
        expect(clear.type).toBe("button");
        expect(clear.closest(".mj_SearchField")).toBe(input.closest(".mj_SearchField"));

        await type(input, "");
        expect(clearButton(container)).toBeNull();
        await act(async () => root.unmount());
    });

    it("clicking clear empties the field, reports the reset, and keeps focus in the field", async () => {
        const values: string[] = [];
        const { container, root } = await mount(<Harness onValue={(v) => values.push(v)} />);
        const input = container.querySelector<HTMLInputElement>("input")!;
        input.focus();
        await type(input, "design");

        const clear = clearButton(container)!;
        // A mouse press on the button must not steal focus from the field.
        const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        clear.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
        await act(async () => clear.click());

        expect(input.value).toBe("");
        expect(values[values.length - 1]).toBe("");
        expect(document.activeElement).toBe(input);
        expect(clearButton(container)).toBeNull();
        await act(async () => root.unmount());
    });

    it("Escape clears a filled field and owns the press; on an empty field it passes through", async () => {
        const outer = jest.fn();
        document.addEventListener("keydown", outer);
        const { container, root } = await mount(<Harness initial="loops" />);
        const input = container.querySelector<HTMLInputElement>("input")!;
        input.focus();

        const first = await press(input, "Escape");
        expect(input.value).toBe("");
        expect(first.defaultPrevented).toBe(true);
        expect(outer).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(input);

        const second = await press(input, "Escape");
        expect(second.defaultPrevented).toBe(false);
        expect(outer).toHaveBeenCalledTimes(1);

        document.removeEventListener("keydown", outer);
        await act(async () => root.unmount());
    });
});

describe("sidebar search uses the shared field", () => {
    function conversation(id: string, title: string): Conversation {
        return {
            id,
            title,
            session_state: "running",
            session_outcome: null,
            last_seq: 0,
            unread_count: 0,
            snippet: "",
            created_at: 0,
            parent_convo_id: null,
            read_up_to_seq: 0,
        };
    }

    it("filters the session list, and the clear button resets it with focus kept", async () => {
        const client = new MatronJournalClient();
        (client as unknown as { state: ClientState }).state = {
            ...client.getSnapshot(),
            phase: "signed-in",
            session: { serverUrl: "https://journal.example", token: "t", deviceId: 1, userId: 2, username: "tester" },
            conversations: [conversation("a", "Alpha design"), conversation("b", "Bravo ops")],
            selectedConversationId: "a",
            events: [],
            pendingMessages: [],
            connection: "online",
        };
        jest.spyOn(client, "searchMessages").mockResolvedValue(undefined);

        const { container, root } = await mount(<MatronApp client={client} />);
        const input = container.querySelector<HTMLInputElement>("#room-list-search-input")!;
        expect(input.closest(".mj_SearchField")).not.toBeNull();
        const before = container.querySelectorAll(".mj_RoomListItem").length;
        expect(before).toBeGreaterThanOrEqual(2);

        input.focus();
        await type(input, "bravo");
        expect(container.querySelectorAll(".mj_RoomListItem").length).toBeLessThan(before);
        expect(container.querySelector(".mj_RoomList")?.textContent).not.toContain("Alpha design");

        await act(async () => clearButton(container)!.click());
        expect(input.value).toBe("");
        expect(document.activeElement).toBe(input);
        expect(container.querySelectorAll(".mj_RoomListItem").length).toBe(before);
        expect(clearButton(container)).toBeNull();
        await act(async () => root.unmount());
    });
});

describe("search field styling", () => {
    const sheet = (file: string) => postcss.parse(fs.readFileSync(path.join(DIR, file), "utf8"), { from: file });
    const decls = (file: string, selector: string): Record<string, string> => {
        const out: Record<string, string> = {};
        sheet(file).walkRules((rule: Rule) => {
            if (rule.selectors.map((s) => s.trim()).includes(selector))
                rule.walkDecls((d) => void (out[d.prop] = d.value));
        });
        return out;
    };

    it("draws hover and the focus ring on the whole rounded bar, never on the inner input", () => {
        expect(decls("controls.pcss", ".mj_SearchField")["border-radius"]).toBe("var(--cpd-radius-md)");
        expect(decls("controls.pcss", ".mj_SearchField:hover")["border-color"]).toBeDefined();
        const ring = decls("controls.pcss", ".mj_SearchField:has(.mj_SearchField_input:focus-visible)");
        expect(ring.outline).toBe("var(--mj-focus-ring)");
        // The input's own ring is off, so the global :focus-visible floor can't draw a box inside the bar.
        expect(decls("controls.pcss", ".mj_SearchField_input:focus-visible").outline).toBe("none");
    });

    it("gives the clear button a 44px touch target and hides the engine's own clear glyph", () => {
        const css = fs.readFileSync(path.join(DIR, "controls.pcss"), "utf8");
        expect(decls("controls.pcss", ".mj_SearchField_clear::before").width).toBe("var(--mj-control-h-touch)");
        expect(decls("controls.pcss", ".mj_SearchField_clear::before").height).toBe("var(--mj-control-h-touch)");
        expect(css).toMatch(/\.mj_SearchField_input::-webkit-search-cancel-button[^{]*\{[^}]*display: none/);
    });

    it("routes every search input in the app through SearchField", () => {
        const offenders: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== "__tests__") walk(p);
                } else if (/\.tsx$/.test(entry.name) && entry.name !== "search-field.tsx") {
                    if (/type="search"/.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(DIR, p));
                }
            }
        };
        walk(DIR);
        expect(offenders).toEqual([]);
    });
});
