/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { DiffCard, EventContent, parseDiffPayload } from "../../../src/journal/components";
import type { JournalEvent } from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

type MountedComponent = {
    container: HTMLDivElement;
    root: Root;
};

const mountedComponents: MountedComponent[] = [];

function makeToken(payloadObj: Record<string, unknown>): string {
    return `https://x.test/view?token=${Buffer.from(JSON.stringify(payloadObj)).toString("base64url")}.sig`;
}

async function mountDiff(payload: Record<string, unknown>): Promise<MountedComponent> {
    const container = document.createElement("div");
    const root = createRoot(container);
    const mounted = { container, root };
    mountedComponents.push(mounted);
    await act(async () => {
        root.render(React.createElement(DiffCard, { data: parseDiffPayload(payload) }));
    });
    return mounted;
}

async function mountEvent(event: JournalEvent): Promise<MountedComponent> {
    const container = document.createElement("div");
    const root = createRoot(container);
    const mounted = { container, root };
    mountedComponents.push(mounted);
    await act(async () => {
        root.render(
            React.createElement(EventContent, {
                client: new MatronJournalClient(),
                event,
                answeredPrompts: new Set<number>(),
            }),
        );
    });
    return mounted;
}

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
    await act(async () => {
        for (const { root } of mountedComponents.splice(0)) root.unmount();
    });
});

describe("parseDiffPayload", () => {
    it("parses a rich diff payload", () => {
        expect(
            parseDiffPayload({
                diff: "+new line",
                display_path: "src/example.ts",
                file_path: "/workspace/src/example.ts",
                viewer_url: "https://example.test/view?token=secret",
                tool: "edit",
                label: "Updated",
                added: 2,
                removed: 1,
                truncated: true,
                new_file: true,
            }),
        ).toEqual({
            diff: "+new line",
            displayPath: "src/example.ts",
            filePath: "/workspace/src/example.ts",
            viewerUrl: "https://example.test/view?token=secret",
            viewerUrlExp: undefined,
            tool: "edit",
            label: "Updated",
            added: 2,
            removed: 1,
            truncated: true,
            newFile: true,
        });
    });

    it("leaves optional metadata undefined for a bare diff", () => {
        expect(parseDiffPayload({ diff: " context" })).toEqual({
            diff: " context",
            displayPath: undefined,
            filePath: undefined,
            viewerUrl: undefined,
            viewerUrlExp: undefined,
            tool: undefined,
            label: undefined,
            added: undefined,
            removed: undefined,
            truncated: false,
            newFile: false,
        });
    });

    it("falls back to a legacy patch", () => {
        expect(parseDiffPayload({ patch: "@@ legacy @@" }).diff).toBe("@@ legacy @@");
    });

    it("preserves an explicitly empty diff instead of falling back to patch", () => {
        expect(parseDiffPayload({ diff: "", patch: "@@ legacy @@" }).diff).toBe("");
    });

    it("falls back to diagnostic JSON when diff and patch are absent", () => {
        const payload = { type: "diff", foo: 1 };
        expect(parseDiffPayload(payload).diff).toBe(JSON.stringify(payload, null, 2));
    });

    it.each([null, "", "javascript:alert(1)", "data:text/html,x", "/view?token=x"])(
        "rejects unsafe or invalid viewer URL %p without throwing",
        (viewerUrl) => {
            expect(() => parseDiffPayload({ diff: "x", viewer_url: viewerUrl })).not.toThrow();
            expect(parseDiffPayload({ diff: "x", viewer_url: viewerUrl }).viewerUrl).toBeUndefined();
        },
    );

    it("accepts an absolute HTTPS viewer URL", () => {
        expect(parseDiffPayload({ diff: "x", viewer_url: "https://example.test/view" }).viewerUrl).toBe(
            "https://example.test/view",
        );
    });

    it("decodes a future integer viewer expiry", () => {
        const future = 2_000_000_000;
        expect(parseDiffPayload({ diff: "x", viewer_url: makeToken({ exp: future }) }).viewerUrlExp).toBe(future);
    });

    it("decodes a past integer viewer expiry", () => {
        const past = 1_000_000_000;
        expect(parseDiffPayload({ diff: "x", viewer_url: makeToken({ exp: past }) }).viewerUrlExp).toBe(past);
    });

    it.each([-1, 0, 1000.5, Number.MAX_SAFE_INTEGER])("rejects out-of-range viewer expiry %p", (exp) => {
        expect(parseDiffPayload({ diff: "x", viewer_url: makeToken({ exp }) }).viewerUrlExp).toBeUndefined();
    });

    it("rejects an oversized viewer URL before decoding", () => {
        const parsed = parseDiffPayload({
            diff: "x",
            viewer_url: "https://x.test/view?token=" + "A".repeat(20000),
        });
        expect(parsed.viewerUrl).toBeUndefined();
        expect(parsed.viewerUrlExp).toBeUndefined();
    });

    it("warns exactly once across undecodable tokens, silent for non-token rejects", () => {
        jest.isolateModules(() => {
            const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { parseDiffPayload: pdp } = require("../../../src/journal/components");
            pdp({ diff: "x" });
            pdp({ diff: "x", viewer_url: "https://x.test/view?token=" + "A".repeat(20000) });
            expect(warn).not.toHaveBeenCalled();
            pdp({ diff: "x", viewer_url: "https://x.test/view?token=secret" });
            pdp({ diff: "x", viewer_url: makeToken({ exp: -1 }) });
            expect(warn).toHaveBeenCalledTimes(1);
            warn.mockRestore();
        });
    });

    it("treats empty optional strings as absent", () => {
        expect(parseDiffPayload({ diff: "x", display_path: "", file_path: "a/b.ts" })).toMatchObject({
            displayPath: undefined,
            filePath: "a/b.ts",
        });
    });

    it("keeps numeric counts and rejects string counts", () => {
        expect(parseDiffPayload({ diff: "x", added: 3, removed: 2 })).toMatchObject({ added: 3, removed: 2 });
        expect(parseDiffPayload({ diff: "x", added: "3", removed: "2" })).toMatchObject({
            added: undefined,
            removed: undefined,
        });
    });

    it("accepts only strict booleans for flags", () => {
        expect(parseDiffPayload({ diff: "x", truncated: "true", new_file: "true" })).toMatchObject({
            truncated: false,
            newFile: false,
        });
    });
});

describe("DiffCard", () => {
    it.each([
        [{ diff: "x", display_path: "src/a/example.ts", file_path: "fallback.ts" }, "example.ts"],
        [{ diff: "x", file_path: "src/fallback.ts" }, "fallback.ts"],
        [{ diff: "x" }, "file"],
        [{ diff: "x", display_path: "", file_path: "a/b.ts" }, "b.ts"],
    ])("renders the resolved filename", async (payload, filename) => {
        const { container } = await mountDiff(payload);
        expect(container.querySelector(".mj_DiffCard_filename")?.textContent).toBe(filename);
    });

    it("links the filename only for a valid viewer URL", async () => {
        const linked = await mountDiff({ diff: "x", file_path: "a.ts", viewer_url: "https://example.test/view" });
        const link = linked.container.querySelector<HTMLAnchorElement>("a.mj_DiffCard_filename");
        expect(link?.getAttribute("href")).toBe("https://example.test/view");
        expect(link?.target).toBe("_blank");
        expect(link?.rel).toBe("noopener noreferrer");

        const plain = await mountDiff({ diff: "x", file_path: "b.ts", viewer_url: null });
        expect(plain.container.querySelector("a")).toBeNull();
        expect(plain.container.querySelector("span.mj_DiffCard_filename")?.textContent).toBe("b.ts");
    });

    it("renders counts and the new-file badge only when provided", async () => {
        const rich = await mountDiff({ diff: "x", added: 0, removed: 2, new_file: true });
        expect(rich.container.querySelector(".mj_DiffCard_added")?.textContent).toBe("+0");
        expect(rich.container.querySelector(".mj_DiffCard_removed")?.textContent).toBe("−2");
        expect(rich.container.querySelector(".mj_DiffCard_badge")?.textContent).toBe("new file");

        const bare = await mountDiff({ diff: "x" });
        expect(bare.container.querySelector(".mj_DiffCard_added")).toBeNull();
        expect(bare.container.querySelector(".mj_DiffCard_removed")).toBeNull();
        expect(bare.container.querySelector(".mj_DiffCard_badge")).toBeNull();
    });

    it("classifies diff lines by prefix", async () => {
        const { container } = await mountDiff({ diff: "+added\n-removed\n@@ hunk @@\n context" });
        const rows = Array.from(container.querySelectorAll(".mj_DiffCard_body > div"));
        expect(rows.map((row) => row.className)).toEqual([
            "mj_DiffLine_add",
            "mj_DiffLine_del",
            "mj_DiffLine_hunk",
            "mj_DiffLine_ctx",
        ]);
    });

    it("has no expansion controls for at most twelve lines", async () => {
        const { container } = await mountDiff({
            diff: Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n"),
        });
        expect(container.querySelector("button[aria-expanded]")).toBeNull();
        expect(container.querySelector(".mj_DiffCard_more")).toBeNull();
        expect(container.querySelectorAll(".mj_DiffCard_body > div")).toHaveLength(12);
    });

    it("expands and collapses from the accessible chevron button", async () => {
        const { container } = await mountDiff({
            diff: Array.from({ length: 14 }, (_, index) => `line ${index}`).join("\n"),
        });
        const chevron = container.querySelector<HTMLButtonElement>('button[aria-label="Expand diff"]');
        expect(chevron?.getAttribute("aria-expanded")).toBe("false");
        expect(container.querySelectorAll(".mj_DiffCard_body > div")).toHaveLength(12);
        expect(container.querySelector<HTMLButtonElement>(".mj_DiffCard_more")?.textContent).toBe("+2 more lines");

        await act(async () => chevron?.click());
        const collapse = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse diff"]');
        expect(collapse?.getAttribute("aria-expanded")).toBe("true");
        expect(container.querySelectorAll(".mj_DiffCard_body > div")).toHaveLength(14);
        expect(container.querySelector(".mj_DiffCard_more")).toBeNull();

        await act(async () => collapse?.click());
        expect(container.querySelector('button[aria-label="Expand diff"]')?.getAttribute("aria-expanded")).toBe(
            "false",
        );
        expect(container.querySelectorAll(".mj_DiffCard_body > div")).toHaveLength(12);
        expect(container.querySelector(".mj_DiffCard_more")).not.toBeNull();
    });

    it("expands from the more-lines button", async () => {
        const { container } = await mountDiff({
            diff: Array.from({ length: 13 }, (_, index) => `line ${index}`).join("\n"),
        });
        const more = container.querySelector<HTMLButtonElement>("button.mj_DiffCard_more");
        expect(more?.textContent).toBe("+1 more lines");
        await act(async () => more?.click());
        expect(container.querySelectorAll(".mj_DiffCard_body > div")).toHaveLength(13);
        expect(container.querySelector('button[aria-label="Collapse diff"]')).not.toBeNull();
    });

    it.each(["\n", "\n\n"])("ignores trailing newlines when deciding expandability", async (ending) => {
        const diff = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n") + ending;
        const { container } = await mountDiff({ diff });
        expect(container.querySelector("button[aria-expanded]")).toBeNull();
        expect(container.querySelector(".mj_DiffCard_more")).toBeNull();
        expect(container.querySelectorAll(".mj_DiffCard_body > div")).toHaveLength(12);
    });

    it("preserves leading whitespace in rendered text", async () => {
        const { container } = await mountDiff({ diff: "    indented" });
        expect(container.querySelector(".mj_DiffCard_body > div")?.textContent).toBe("    indented");
    });

    it("normalizes CRLF so rows do not retain carriage returns", async () => {
        const { container } = await mountDiff({ diff: "line 1\r\nline 2\r\n" });
        const rows = container.querySelectorAll(".mj_DiffCard_body > div");
        expect(rows).toHaveLength(2);
        expect(rows[0]?.textContent).toBe("line 1");
        expect(rows[1]?.textContent).toBe("line 2");
    });

    it("caps an over-large diff and flags the overflow", async () => {
        const { container } = await mountDiff({
            diff: Array.from({ length: 6000 }, (_, index) => `line ${index}`).join("\n"),
        });
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Expand diff"]')?.click());
        expect(container.querySelectorAll(".mj_DiffCard_body > div.mj_DiffLine_ctx")).toHaveLength(5000);
        expect(container.querySelector(".mj_DiffCard_truncated")?.textContent).toContain("diff too large");
    });

    it("renders truncated markers in the header and body", async () => {
        const { container } = await mountDiff({ diff: "x", truncated: true });
        expect(container.querySelector('[title="diff truncated"]')?.textContent).toBe("…");
        expect(container.querySelector(".mj_DiffCard_truncated")?.textContent).toBe("… diff truncated");
    });
});

describe("EventContent diff integration", () => {
    it("parses rich and legacy diff events into DiffCard", async () => {
        const rich = await mountEvent({
            seq: 1,
            convo_id: "c",
            ts: 0,
            sender: "assistant",
            type: "diff",
            payload: {
                display_path: "a/b.ts",
                viewer_url: "https://x/view?t=1",
                diff: "@@ rich @@",
                added: 1,
                removed: 0,
            },
        });
        const link = rich.container.querySelector<HTMLAnchorElement>("a.mj_DiffCard_filename");
        expect(link?.textContent).toBe("b.ts");
        expect(link?.getAttribute("href")).toBe("https://x/view?t=1");
        expect(rich.container.querySelector(".mj_DiffCard_added")?.textContent).toBe("+1");
        expect(rich.container.querySelector(".mj_DiffCard_removed")?.textContent).toBe("−0");

        const legacy = await mountEvent({
            seq: 2,
            convo_id: "c",
            ts: 1,
            sender: "assistant",
            type: "diff",
            payload: { patch: "@@ legacy @@" },
        });
        expect(legacy.container.querySelector(".mj_DiffCard_body")?.textContent).toContain("@@ legacy @@");
    });
});
