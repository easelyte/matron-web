/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MarkdownBody } from "../markdown";
import { TrackerLinkInfoContext, type TrackerLinkInfo, titleMatches } from "../tracker-link-title";
import type { NumberLookupOutcome } from "../types";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container?.remove();
});

const OWN = `${window.location.origin}/u/alice`;

async function render(text: string, info?: TrackerLinkInfo): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.append(container);
    const body = <MarkdownBody text={text} label="msg" onTrackerLink={() => undefined} />;
    await act(async () => {
        root = createRoot(container!);
        root.render(
            info ? <TrackerLinkInfoContext.Provider value={info}>{body}</TrackerLinkInfoContext.Provider> : body,
        );
    });
    // Let the lookups settle.
    await act(async () => {
        await Promise.resolve();
    });
    return container;
}

const found = (kind: "item" | "mission" | "milestone" | "project", title: string, num = 12): NumberLookupOutcome => ({
    status: "found",
    hit: { kind, id: `${kind}_${num}`, num, title },
});

function chip(view: HTMLElement): HTMLElement | null {
    return view.querySelector<HTMLElement>("a.mj_TrackerLink .mj_TrackerLinkTarget");
}

describe("tracker link titles", () => {
    it("shows the kind and title of a bare #N link's target", async () => {
        const info = jest.fn().mockResolvedValue(found("item", "Ship the release notes"));
        const view = await render(`See [#12](${OWN}/12).`, info);

        expect(info).toHaveBeenCalledWith("alice", 12);
        expect(chip(view)?.textContent).toBe("item · Ship the release notes");
        expect(chip(view)?.classList.contains("mj_TrackerLinkTarget--mismatch")).toBe(false);
    });

    it("shows no chip when the link already carries the right title", async () => {
        const info = jest.fn().mockResolvedValue(found("mission", "Ship the release notes"));
        const view = await render(`[#12 Ship the release…](${OWN}/12)`, info);

        expect(info).toHaveBeenCalledWith("alice", 12);
        expect(view.querySelector("a.mj_TrackerLink")?.textContent).toBe("#12 Ship the release…");
        expect(chip(view)).toBeNull();
    });

    it("keeps the chip on a label that names nothing, even when it starts the title", async () => {
        const info = jest.fn().mockResolvedValue(found("item", "Here is the release plan"));
        const view = await render(`[here](${OWN}/12) and [Here](${OWN}/12)`, info);

        const chips = view.querySelectorAll<HTMLElement>("a.mj_TrackerLink .mj_TrackerLinkTarget");
        expect(chips).toHaveLength(2);
        for (const c of chips) {
            expect(c.textContent).toBe("item · Here is the release plan");
            expect(c.classList.contains("mj_TrackerLinkTarget--mismatch")).toBe(false);
        }
    });

    it("flags a link titled after another record with an address on the same site", async () => {
        const info = jest
            .fn()
            .mockResolvedValue(found("item", "Merge https://example.com/org/repo/pull/10 (live tracking fix)"));
        const view = await render(`[#12 Merge https://example.com/org/repo/pull/11 (search fix)](${OWN}/12)`, info);

        expect(chip(view)?.classList.contains("mj_TrackerLinkTarget--mismatch")).toBe(true);
    });

    it("flags a link whose written title is not its target's", async () => {
        const info = jest.fn().mockResolvedValue(found("item", "Office move to the new building"));
        const view = await render(`[#12 Merge: release notes export](${OWN}/12)`, info);

        expect(chip(view)?.textContent).toBe("⚠ item · Office move to the new building");
        expect(chip(view)?.classList.contains("mj_TrackerLinkTarget--mismatch")).toBe(true);
        expect(chip(view)?.getAttribute("title")).toContain("#12 is not");
    });

    it("treats a link whose text is its own URL as a bare link, not a wrong title", async () => {
        const info = jest.fn().mockResolvedValue(found("item", "Ship the release notes", 68));
        const view = await render(`The steps are on matron://item/68 and ${OWN}/68.`, info);

        const chips = view.querySelectorAll<HTMLElement>("a.mj_TrackerLink .mj_TrackerLinkTarget");
        expect(chips).toHaveLength(2);
        for (const c of chips) {
            expect(c.textContent).toBe("item · Ship the release notes");
            expect(c.classList.contains("mj_TrackerLinkTarget--mismatch")).toBe(false);
        }
    });

    it('does not read a generic label like "click here" as a wrong title', async () => {
        const info = jest.fn().mockResolvedValue(found("item", "Ship the release notes"));
        const view = await render(`[click here](${OWN}/12) or [read more](${OWN}/12)`, info);

        for (const c of view.querySelectorAll<HTMLElement>("a.mj_TrackerLink .mj_TrackerLinkTarget")) {
            expect(c.textContent).toBe("item · Ship the release notes");
            expect(c.classList.contains("mj_TrackerLinkTarget--mismatch")).toBe(false);
        }
    });

    it("flags a link whose text names another number, even when the journal sends no title", async () => {
        const info = jest.fn().mockResolvedValue({ status: "found", hit: { kind: "item", id: "it_12", num: 12 } });
        const view = await render(`[#13](${OWN}/12)`, info);

        expect(chip(view)?.textContent).toBe("⚠ item");
        expect(chip(view)?.classList.contains("mj_TrackerLinkTarget--mismatch")).toBe(true);
    });

    it("flags a number that does not exist", async () => {
        const info = jest.fn().mockResolvedValue({ status: "none" });
        const view = await render(`[#99](${OWN}/99)`, info);

        expect(chip(view)?.textContent).toBe("⚠ not found");
        expect(chip(view)?.classList.contains("mj_TrackerLinkTarget--mismatch")).toBe(true);
    });

    it("shows nothing extra when the journal cannot be asked", async () => {
        const info = jest.fn().mockResolvedValue({ status: "failed" });
        const view = await render(`[#12](${OWN}/12)`, info);

        expect(view.querySelector("a.mj_TrackerLink")?.textContent).toBe("#12");
        expect(chip(view)).toBeNull();
    });

    it("reads the old matron:// links against the signed-in user", async () => {
        const info = jest.fn().mockResolvedValue(found("project", "Launch", 5));
        const view = await render("[#5](matron://project/5) and [#6](matron://item/6)", info);

        expect(info).toHaveBeenCalledWith(null, 5);
        expect(info).toHaveBeenCalledWith(null, 6);
        expect(chip(view)?.textContent).toBe("project · Launch");
    });

    it("reads another user's link against that user", async () => {
        const info = jest.fn().mockResolvedValue(found("milestone", "First draft", 3));
        await render(`[#3](${window.location.origin}/u/bob/3)`, info);
        expect(info).toHaveBeenCalledWith("bob", 3);
    });

    it("renders the plain link where no lookup is provided", async () => {
        const view = await render(`[#12](${OWN}/12)`);
        expect(view.querySelector("a.mj_TrackerLink")?.textContent).toBe("#12");
        expect(chip(view)).toBeNull();
    });
});

describe("titleMatches", () => {
    it("accepts the title, a prefix of it, an abbreviation or a close paraphrase", () => {
        expect(titleMatches("Merge: release notes…", "Merge: release notes export for the launch")).toBe(true);
        expect(titleMatches("office-move item", "Office move to the new building: options")).toBe(true);
        expect(titleMatches("CAFÉ menu", "Cafe menu update")).toBe(true);
    });

    it("refuses a title about something else, and an empty one", () => {
        expect(titleMatches("the new merge question", "Office move to the new building")).toBe(false);
        expect(titleMatches("here", "Merge: release notes export")).toBe(false);
        expect(titleMatches("", "Merge")).toBe(false);
    });

    it("compares an address in a title as one whole word", () => {
        const actual = "Merge https://example.com/org/repo/pull/10 (live tracking fix)";
        expect(titleMatches("Merge https://example.com/org/repo/pull/11 (search fix)", actual)).toBe(false);
        expect(titleMatches("Merge https://example.com/org/repo/pull/1", actual)).toBe(false);
        expect(titleMatches("https://example.com/org/repo/pull/10", "Merge https://example.com/org/repo/pull/11")).toBe(
            false,
        );
        expect(titleMatches(actual, actual)).toBe(true);
        expect(titleMatches("Merge https://example.com/org/repo/pull/10", actual)).toBe(true);
        expect(titleMatches("Merge https://example.com/org/repo/pu…", actual)).toBe(true);
        expect(titleMatches("Merge (live tracking fix)", actual)).toBe(true);
        // Every other word the same: the address alone tells them apart.
        expect(titleMatches("Merge https://example.com/org/repo/pull/11 (live tracking fix)", actual)).toBe(false);
        expect(titleMatches("Fix https://example.com/Files/A", "Fix https://example.com/Files/a")).toBe(false);
        expect(titleMatches("Fix https://example.com/item(1) docs", "Fix https://example.com/item(2) docs")).toBe(
            false,
        );
        expect(titleMatches("Fix [https://example.com/a]", "Fix https://example.com/a")).toBe(true);
        // An address cut short inside wrapping punctuation is still cut short.
        expect(
            titleMatches(
                "Merge (https://example.com/org/repo/pull/1...)",
                "Merge https://example.com/org/repo/pull/10",
            ),
        ).toBe(true);
        expect(
            titleMatches(
                "Merge https://example.com/org/repo/pull/1..., then ship",
                "Merge https://example.com/org/repo/pull/10 then ship",
            ),
        ).toBe(true);
        expect(titleMatches("Fix (see https://example.com/a)", "Fix: see https://example.com/a")).toBe(true);
    });
});
