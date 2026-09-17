/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { WorkView } from "../tracker/WorkView";
import type { WorkViewLoader } from "../use-work-view";
import type { WorkViewEnvelope, WorkViewGroup, WorkViewGroupBy, WorkViewLoop } from "../work-view";

function loop(over: Partial<WorkViewLoop> = {}): WorkViewLoop {
    return {
        id: 1,
        title: "Ship the Work pane",
        repo: "matron-web",
        domain: "infra",
        priority: 3,
        description: "Show active loops in the tracker.",
        status: "active",
        claim: null,
        ...over,
    };
}

function ok(groupBy: WorkViewGroupBy, groups: WorkViewGroup[]): WorkViewEnvelope {
    return {
        schema_version: 1,
        status: "ok",
        group_by: groupBy,
        groups: groups as [WorkViewGroup, ...WorkViewGroup[]],
    };
}

function group(key: string, loops: WorkViewLoop[]): WorkViewGroup {
    return { key, loops: loops as [WorkViewLoop, ...WorkViewLoop[]] };
}

function loader(work: WorkViewLoader["work"]): WorkViewLoader {
    return { work };
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

async function unmount(root: Root): Promise<void> {
    await act(async () => root.unmount());
}

describe("WorkView", () => {
    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        document.body.replaceChildren();
    });

    it("groups by repo, renders unassigned, orders by descending priority, and shows loop fields", async () => {
        const longDescription = `${"An intentionally detailed loop description. ".repeat(8)}Final detail.`;
        const work = jest.fn().mockResolvedValue(
            ok("repo", [
                group("matron-web", [
                    loop({ id: 2, title: "Lower priority", priority: 2 }),
                    loop({
                        id: 1,
                        title: "Highest priority",
                        priority: 5,
                        description: longDescription,
                        status: "blocked",
                    }),
                ]),
                group("unassigned", [loop({ id: 3, title: "Needs a repo", repo: "unassigned", domain: "unassigned" })]),
            ]),
        );
        const { container, root } = await mount(<WorkView api={loader(work)} />);

        expect(work).toHaveBeenCalledWith("repo", expect.any(AbortSignal));
        // The heading carries a trailing count span, so read the key node rather than textContent.
        const headings = Array.from(container.querySelectorAll(".mj_WorkGroup_header")).map(
            (node) => node.firstChild?.textContent,
        );
        expect(headings).toEqual(["matron-web", "unassigned"]);

        // Rows reuse the tracker's row anatomy (.mj_TrackerItemRow_*), shared with ItemRow and
        // MissionsList, rather than a Work-only card -- that consistency is the point.
        const titles = Array.from(container.querySelectorAll(".mj_TrackerWorkRow .mj_TrackerItemRow_title")).map(
            (node) => node.textContent,
        );
        expect(titles).toEqual(["#1Highest priority", "#2Lower priority", "#3Needs a repo"]);
        expect(container.textContent).toContain("P5");
        expect(container.textContent).toContain("blocked");

        // Collapsed, the description lives in the shared .mj_TrackerItemRow_body preview, which the
        // stylesheet truncates with a real CSS ellipsis -- the same mechanism ItemRow uses. It is
        // deliberately NOT sliced in JS: CSS truncation adapts to the pane width, never cuts
        // mid-word, and leaves the full text reachable by find-in-page and screen readers. So the
        // assertion is that the expanded block is absent, not that the text is.
        const firstRow = container.querySelectorAll(".mj_TrackerWorkRow_wrap")[0];
        expect(firstRow.querySelector(".mj_TrackerItemRow_body")?.textContent).toBe(longDescription);
        expect(container.querySelector(".mj_TrackerWorkRow_full")).toBeNull();

        // The row itself toggles expansion -- Phase 1 has no loop detail view to navigate to.
        const row = container.querySelector<HTMLButtonElement>(".mj_TrackerWorkRow")!;
        expect(row.getAttribute("aria-expanded")).toBe("false");
        await act(async () => row.click());
        expect(row.getAttribute("aria-expanded")).toBe("true");
        expect(container.querySelector(".mj_TrackerWorkRow_full")?.textContent).toBe(longDescription);
        // The one-line preview gives way to the full block rather than doubling it -- scoped to
        // the expanded row, since its siblings still show their own previews.
        expect(firstRow.querySelector(".mj_TrackerItemRow_body")).toBeNull();
        await unmount(root);
    });

    it("hides parked and paused work by default, and reveals it under All", async () => {
        // Defaults to the focused view for the same reason the Inbox defaults to "Needs you":
        // set-aside work is real but noise when scanning for what to pick up. It is 8 of 30 loops
        // on the live store, so this is the difference between a scannable list and a wall.
        const work = jest
            .fn()
            .mockResolvedValue(
                ok("repo", [
                    group("matron-web", [
                        loop({ id: 1, title: "In play" }),
                        loop({ id: 2, title: "Set aside", status: "parked" }),
                        loop({ id: 3, title: "Also set aside", status: "paused" }),
                    ]),
                ]),
            );
        const { container, root } = await mount(<WorkView api={loader(work)} />);

        expect(container.textContent).toContain("In play");
        expect(container.textContent).not.toContain("Set aside");
        expect(container.textContent).not.toContain("Also set aside");

        const all = Array.from(container.querySelectorAll<HTMLButtonElement>(".mj_TrackerToggleTab")).find(
            (node) => node.textContent === "All",
        )!;
        await act(async () => all.click());

        expect(container.textContent).toContain("Set aside");
        expect(container.textContent).toContain("Also set aside");
        // Switching scope must not refetch -- the filter is a view over the payload we already have.
        expect(work).toHaveBeenCalledTimes(1);
        await unmount(root);
    });

    it("drops a group the filter empties rather than leaving a bare header", async () => {
        const work = jest
            .fn()
            .mockResolvedValue(
                ok("repo", [
                    group("matron-web", [loop({ id: 1, title: "In play" })]),
                    group("snafu-studio", [loop({ id: 2, title: "Set aside", status: "parked" })]),
                ]),
            );
        const { container, root } = await mount(<WorkView api={loader(work)} />);

        const headings = Array.from(container.querySelectorAll(".mj_WorkGroup_header")).map(
            (node) => node.firstChild?.textContent,
        );
        expect(headings).toEqual(["matron-web"]);
        await unmount(root);
    });

    it("says so when everything is filtered away, instead of rendering a blank pane", async () => {
        // A blank pane under a non-empty store reads as broken. This is distinct from the
        // endpoint's own `empty` envelope, which means the store really has no active work.
        const work = jest
            .fn()
            .mockResolvedValue(ok("repo", [group("matron-web", [loop({ id: 1, status: "parked" })])]));
        const { container, root } = await mount(<WorkView api={loader(work)} />);

        expect(container.textContent).toContain("Nothing active");
        expect(container.textContent).toContain("Switch to All");
        await unmount(root);
    });

    it("switches to domain grouping and renders the changed response", async () => {
        const work = jest.fn((groupBy: WorkViewGroupBy) =>
            Promise.resolve(
                groupBy === "repo"
                    ? ok("repo", [group("matron-web", [loop()])])
                    : ok("domain", [group("infra", [loop()])]),
            ),
        );
        const { container, root } = await mount(<WorkView api={loader(work)} />);

        await act(async () => {
            const domainTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']")).find(
                (button) => button.textContent === "Domain",
            );
            domainTab!.click();
        });

        expect(work).toHaveBeenLastCalledWith("domain", expect.any(AbortSignal));
        expect(container.querySelector(".mj_WorkGroup_header")?.firstChild?.textContent).toBe("infra");
        await unmount(root);
    });

    it("renders live, stale, and unknown claims with honest advisory copy and a label-less fallback", async () => {
        const claimedAt = "2026-09-15T12:34:56Z";
        const work = jest.fn().mockResolvedValue(
            ok("repo", [
                group("matron-web", [
                    loop({
                        id: 1,
                        claim: {
                            convo_id: "live-conversation",
                            holder_label: "Session Alpha",
                            // liveness is the ONE field a consumer may author: the producer CLI cannot reach
                            // the journal's DB handle, so it always emits "unknown" and the /work route
                            // fills it per request. Every other field in these payloads matches the
                            // generated fixtures. See fixtures/WORK-VIEW-FIXTURES.md.
                            claimed_at: claimedAt,
                            liveness: "live",
                        },
                    }),
                    loop({
                        id: 2,
                        claim: {
                            convo_id: "stale-conversation",
                            holder_label: "Session Beta",
                            claimed_at: claimedAt,
                            liveness: "stale",
                        },
                    }),
                    loop({
                        id: 3,
                        claim: {
                            convo_id: "abcdef123456",
                            holder_label: null,
                            claimed_at: claimedAt,
                            liveness: "unknown",
                        },
                    }),
                ]),
            ]),
        );
        const { container, root } = await mount(<WorkView api={loader(work)} />);

        const badges = Array.from(container.querySelectorAll(".mj_WorkClaimBadge")).map((node) => node.textContent);
        expect(badges).toEqual([
            "Session Alpha appears to be on this",
            "Session Beta · looks abandoned",
            "Session abcdef · claimed — liveness unknown",
        ]);
        expect(container.textContent?.toLowerCase()).not.toMatch(/locked|exclusive/);
        expect(container.textContent).not.toMatch(/null/);
        await unmount(root);
    });

    it("renders the explicit no-active-work state", async () => {
        const work = jest.fn().mockResolvedValue({
            schema_version: 1,
            status: "empty",
            group_by: "repo",
            groups: [],
        } satisfies WorkViewEnvelope);
        const { container, root } = await mount(<WorkView api={loader(work)} />);

        expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe("No active work");
        await unmount(root);
    });

    it("fails loud for an error envelope instead of rendering the empty state", async () => {
        const work = jest.fn().mockResolvedValue({
            schema_version: 1,
            status: "error",
            group_by: "repo",
            groups: [],
            error: { code: "builder_timeout", message: "The Work builder timed out." },
        } satisfies WorkViewEnvelope);
        const { container, root } = await mount(<WorkView api={loader(work)} />);

        expect(container.querySelector("[role='alert']")?.textContent).toContain("builder_timeout");
        expect(container.textContent).toContain("The Work builder timed out.");
        expect(container.textContent).not.toContain("No active work");
        await unmount(root);
    });

    it("fails loud when the Work request itself fails", async () => {
        const work = jest.fn().mockRejectedValue(new Error("The Work request failed."));
        const { container, root } = await mount(<WorkView api={loader(work)} />);

        expect(container.querySelector("[role='alert']")?.textContent).toContain("Work unavailable");
        expect(container.textContent).toContain("The Work request failed.");
        expect(container.textContent).not.toContain("No active work");
        await unmount(root);
    });
});
