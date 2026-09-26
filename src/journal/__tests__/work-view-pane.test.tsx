/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { WorkView, summaryLine } from "../tracker/WorkView";
import type { WorkViewLoader } from "../use-work-view";
import type { WorkViewEnvelope, WorkViewGroup, WorkViewGroupBy, WorkViewLoop } from "../work-view";
import okFixture from "./fixtures/work-view-ok.json";
import okDetailFixture from "./fixtures/work-view-ok-detail.json";
import { parseWorkViewEnvelope } from "../work-view";

// A fixed clock so ages ("3w old") are deterministic.
const NOW = Date.parse("2026-09-26T12:00:00Z");

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

const rowTitles = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll(".mj_WorkRow .mj_TrackerItemRow_title")).map(
        (node) => node.textContent ?? "",
    );

const headings = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll(".mj_WorkGroup_key")).map((node) => node.textContent ?? "");

function select(container: HTMLElement, label: string): HTMLSelectElement {
    return container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
}

async function choose(container: HTMLElement, label: string, value: string): Promise<void> {
    const node = select(container, label);
    await act(async () => {
        node.value = value;
        node.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

async function typeSearch(container: HTMLElement, text: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search work"]')!;
    // React tracks the input's value through the native setter; assign through it so onChange fires.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
        setter.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

function rowFor(container: HTMLElement, id: number): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>(`.mj_WorkRow[data-loop-id="${id}"]`)!;
}

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
    document.body.replaceChildren();
});

describe("WorkView list", () => {
    it("renders tracker rows: title, lead sentence, status chip, priority, the other dimension, owner, age", async () => {
        const work = jest.fn().mockResolvedValue(
            ok("repo", [
                group("matron-web", [
                    loop({
                        id: 7,
                        title: "Detail view",
                        priority: 4,
                        description: "**Lead** sentence with `code`.\n\n**Scope**\n- bullet",
                        domain: "infra",
                        owner: "operator",
                        opened: "2026-09-05T12:00:00Z",
                    }),
                ]),
            ]),
        );
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        expect(work).toHaveBeenCalledWith("repo", expect.any(AbortSignal));
        const row = rowFor(container, 7);
        // Same anatomy as ItemRow: the title line leads with the tabular id.
        expect(row.classList.contains("mj_TrackerItemRow")).toBe(true);
        expect(row.querySelector(".mj_TrackerItemRow_title")?.textContent).toBe("#7Detail view");
        // The secondary line is the lead paragraph as plain prose: markdown markers stripped.
        expect(row.querySelector(".mj_WorkRow_lead")?.textContent).toBe("Lead sentence with code.");
        expect(row.querySelector(".mj_WorkStatusChip")?.textContent).toBe("Active");
        expect(row.querySelector(".mj_WorkPriority")?.textContent).toBe("P4");
        // Grouped by repo, so the row shows the domain (the repo is already the heading).
        expect(row.querySelector(".mj_WorkRow_dimension")?.textContent).toBe("infra");
        expect(row.querySelector(".mj_WorkRow_owner")?.textContent).toBe("Operator");
        expect(row.querySelector(".mj_WorkRow_age")?.textContent).toBe("3w old");
        expect(row.getAttribute("aria-label")).toContain("opened 3 weeks ago");
        await unmount(root);
    });

    it("orders by priority, then oldest first, then id, and flags blocked with the needs-you treatment", async () => {
        const work = jest.fn().mockResolvedValue(
            ok("repo", [
                group("matron-web", [
                    loop({ id: 1, title: "Low", priority: 2, opened: "2026-01-01T00:00:00Z" }),
                    loop({ id: 2, title: "High newer", priority: 5, opened: "2026-09-20T00:00:00Z" }),
                    loop({
                        id: 3,
                        title: "High older",
                        priority: 5,
                        opened: "2026-08-01T00:00:00Z",
                        status: "blocked",
                    }),
                    loop({ id: 4, title: "High no date", priority: 5 }),
                ]),
            ]),
        );
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        expect(rowTitles(container)).toEqual(["#3High older", "#2High newer", "#4High no date", "#1Low"]);
        expect(rowFor(container, 3).classList.contains("mj_TrackerItemRow_needsyou")).toBe(true);
        expect(rowFor(container, 3).querySelector(".mj_WorkStatusChip_blocked")).not.toBeNull();
        expect(rowFor(container, 3).querySelector(".mj_WorkGlyph_blocked")).not.toBeNull();
        expect(rowFor(container, 2).classList.contains("mj_TrackerItemRow_needsyou")).toBe(false);
        await unmount(root);
    });

    it("hides parked and paused by default and reveals them from the status filter without refetching", async () => {
        const work = jest
            .fn()
            .mockResolvedValue(
                ok("repo", [
                    group("matron-web", [
                        loop({ id: 1, title: "In play" }),
                        loop({ id: 2, title: "Blocked one", status: "blocked" }),
                        loop({ id: 3, title: "Set aside", status: "parked" }),
                        loop({ id: 4, title: "Also set aside", status: "paused" }),
                    ]),
                ]),
            );
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        expect(rowTitles(container)).toEqual(["#1In play", "#2Blocked one"]);
        const options = Array.from(select(container, "Status").options).map((option) => option.textContent);
        expect(options).toEqual([
            "In play (2)",
            "All statuses (4)",
            "Active (1)",
            "Blocked (1)",
            "Parked (1)",
            "Paused (1)",
        ]);

        await choose(container, "Status", "all");
        expect(rowTitles(container)).toHaveLength(4);
        await choose(container, "Status", "parked");
        expect(rowTitles(container)).toEqual(["#3Set aside"]);
        // Filters are a view over the payload already loaded.
        expect(work).toHaveBeenCalledTimes(1);
        await unmount(root);
    });

    it("filters by domain and by search across id, title, description and next step", async () => {
        const work = jest
            .fn()
            .mockResolvedValue(
                ok("repo", [
                    group("matron-web", [
                        loop({ id: 11, title: "Tracker polish", domain: "infra" }),
                        loop({ id: 12, title: "Portal", domain: "clients", description: "Client-facing portal." }),
                        loop({ id: 13, title: "Hooks", domain: "process", next_action: "Retire the fork hook" }),
                    ]),
                ]),
            );
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        const domains = Array.from(select(container, "Domain").options).map((option) => option.textContent);
        expect(domains).toEqual(["All domains", "clients (1)", "infra (1)", "process (1)"]);
        await choose(container, "Domain", "clients");
        expect(rowTitles(container)).toEqual(["#12Portal"]);
        expect(container.querySelector(".mj_WorkSummary")?.textContent).toContain("1 of 3 loops");
        await choose(container, "Domain", "");

        await typeSearch(container, "fork hook");
        expect(rowTitles(container)).toEqual(["#13Hooks"]);
        await typeSearch(container, "#11");
        expect(rowTitles(container)).toEqual(["#11Tracker polish"]);
        await typeSearch(container, "client-facing");
        expect(rowTitles(container)).toEqual(["#12Portal"]);

        await typeSearch(container, "nothing matches this");
        expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe("No loops match");
        const clear = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent === "Clear filters",
        )!;
        await act(async () => clear.click());
        expect(rowTitles(container)).toHaveLength(3);
        expect(container.querySelector<HTMLInputElement>('input[aria-label="Search work"]')!.value).toBe("");
        await unmount(root);
    });

    it("drops a group the filters empty rather than leaving a bare header", async () => {
        const work = jest
            .fn()
            .mockResolvedValue(
                ok("repo", [
                    group("matron-web", [loop({ id: 1, title: "In play" })]),
                    group("snafu-studio", [loop({ id: 2, title: "Set aside", status: "parked" })]),
                ]),
            );
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        expect(headings(container)).toEqual(["matron-web"]);
        expect(container.querySelector(".mj_WorkGroup_count")?.textContent).toBe("1");
        await unmount(root);
    });

    it("says so when everything in the store is set aside, and offers the way back", async () => {
        const work = jest
            .fn()
            .mockResolvedValue(ok("repo", [group("matron-web", [loop({ id: 1, title: "Parked", status: "parked" })])]));
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe("Nothing in play");
        const showAll = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
            (button) => button.textContent === "Show all statuses",
        )!;
        await act(async () => showAll.click());
        expect(rowTitles(container)).toEqual(["#1Parked"]);
        await unmount(root);
    });

    it("switches to domain grouping, and the rows then show the repo", async () => {
        const work = jest.fn((groupBy: WorkViewGroupBy) =>
            Promise.resolve(
                groupBy === "repo"
                    ? ok("repo", [group("matron-web", [loop()])])
                    : ok("domain", [group("infra", [loop()])]),
            ),
        );
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        await act(async () => {
            const domainTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']")).find(
                (button) => button.textContent === "Domain",
            );
            domainTab!.click();
        });

        expect(work).toHaveBeenLastCalledWith("domain", expect.any(AbortSignal));
        expect(headings(container)).toEqual(["infra"]);
        expect(container.querySelector(".mj_WorkRow_dimension")?.textContent).toBe("matron-web");
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
                            // liveness is the ONE field a consumer may author: the producer CLI cannot
                            // reach the journal's DB handle, so it always emits "unknown" and the /work
                            // route fills it per request. See fixtures/WORK-VIEW-FIXTURES.md.
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
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        const claims = Array.from(container.querySelectorAll(".mj_WorkClaim")).map((node) => node.textContent);
        expect(claims).toEqual([
            "Session Alpha appears to be on this",
            "Session Beta · looks abandoned",
            "Session abcdef · claimed — liveness unknown",
        ]);
        expect(container.textContent?.toLowerCase()).not.toMatch(/locked|exclusive/);
        expect(container.textContent).not.toMatch(/null|undefined/);
        await unmount(root);
    });

    it("degrades cleanly when the server predates the optional detail fields", async () => {
        const work = jest.fn().mockResolvedValue(ok("repo", [group("matron-web", [loop({ id: 5 })])]));
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        const row = rowFor(container, 5);
        expect(row.querySelector(".mj_WorkRow_owner")).toBeNull();
        expect(row.querySelector(".mj_WorkRow_age")).toBeNull();
        expect(row.textContent).not.toMatch(/undefined|NaN|Invalid/);
        await unmount(root);
    });

    it("renders the explicit no-open-work state", async () => {
        const work = jest.fn().mockResolvedValue({
            schema_version: 1,
            status: "empty",
            group_by: "repo",
            groups: [],
        } satisfies WorkViewEnvelope);
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe("No open work");
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
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        expect(container.querySelector("[role='alert']")?.textContent).toContain("builder_timeout");
        expect(container.textContent).toContain("The Work builder timed out.");
        expect(container.textContent).not.toContain("No open work");
        await unmount(root);
    });

    it("fails loud when the Work request itself fails", async () => {
        const work = jest.fn().mockRejectedValue(new Error("The Work request failed."));
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        expect(container.querySelector("[role='alert']")?.textContent).toContain("Work unavailable");
        expect(container.textContent).toContain("The Work request failed.");
        await unmount(root);
    });

    it("shows a placeholder for a description-less loop, which still opens its detail", async () => {
        // An empty description is valid on the wire. The row still leads somewhere: the detail
        // carries status, priority, owner and the next step even when there is no prose.
        const work = jest.fn().mockResolvedValue(ok("repo", [group("matron-web", [loop({ id: 1, description: "" })])]));
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        const row = rowFor(container, 1);
        expect(row.tagName).toBe("BUTTON");
        expect(row.querySelector(".mj_WorkRow_lead_empty")?.textContent).toBe("No description yet.");
        await act(async () => row.click());
        expect(container.querySelector(".mj_WorkDetail_empty")?.textContent).toBe("No description yet.");
        await unmount(root);
    });
});

describe("WorkView loop detail", () => {
    const detailed = loop({
        id: 42,
        title: "Upgrade the Work display",
        priority: 4,
        status: "blocked",
        owner: "claude",
        opened: "2026-09-05T12:00:00Z",
        next_action: "Wait for the design review.",
        description: [
            "Make the Work view read like Missions.",
            "",
            "**Scope**",
            "- Rows like `ItemRow`",
            "- A detail view",
            "",
            "**Reference**",
            "- [Schema](https://example.com/schema.json)",
        ].join("\n"),
    });

    it("opens from a row and renders the header, meta grid, next-step callout and markdown body", async () => {
        const work = jest.fn().mockResolvedValue(ok("repo", [group("matron-web", [detailed])]));
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        await act(async () => rowFor(container, 42).click());

        expect(container.querySelector(".mj_TrackerItemHead_kind")?.textContent).toBe("#42 · Loop");
        expect(container.querySelector(".mj_TrackerDetail_head .mj_WorkStatusChip")?.textContent).toBe("Blocked");
        expect(container.querySelector("h1.mj_TrackerItemTitle")?.textContent).toBe("Upgrade the Work display");

        const meta = Object.fromEntries(
            Array.from(container.querySelectorAll(".mj_WorkMeta_cell")).map((cell) => [
                cell.querySelector("dt")?.textContent,
                cell.querySelector("dd")?.textContent,
            ]),
        );
        expect(meta.Priority).toBe("P4");
        expect(meta.Domain).toBe("infra");
        expect(meta.Repo).toBe("matron-web");
        expect(meta.Owner).toBe("Claude");
        expect(meta.Opened).toMatch(/2026/);
        expect(meta.Opened).toContain("3w ago");

        const next = container.querySelector(".mj_WorkNext");
        expect(next?.textContent).toContain("Wait for the design review.");
        // Blocked: the callout takes the attention treatment too.
        expect(next?.classList.contains("mj_WorkNext_attention")).toBe(true);

        const body = container.querySelector(".mj_WorkDetail_body")!;
        expect(Array.from(body.querySelectorAll("strong")).map((node) => node.textContent)).toEqual([
            "Scope",
            "Reference",
        ]);
        expect(Array.from(body.querySelectorAll("li")).map((node) => node.textContent)).toEqual([
            "Rows like ItemRow",
            "A detail view",
            "Schema",
        ]);
        expect(body.querySelector("code")?.textContent).toBe("ItemRow");
        const link = body.querySelector("a")!;
        expect(link.getAttribute("href")).toBe("https://example.com/schema.json");
        expect(link.getAttribute("target")).toBe("_blank");
        expect(link.getAttribute("rel")).toContain("noopener");
        await unmount(root);
    });

    it("never renders raw HTML from a description", async () => {
        const hostile = loop({
            id: 9,
            description: 'Lead.\n\n<img src=x onerror="window.__pwned=1"><script>1</script>',
        });
        const work = jest.fn().mockResolvedValue(ok("repo", [group("matron-web", [hostile])]));
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        await act(async () => rowFor(container, 9).click());
        const body = container.querySelector(".mj_WorkDetail_body")!;
        expect(body.querySelector("img, script")).toBeNull();
        await unmount(root);
    });

    it("goes back to the list with filters intact and focus on the opened row", async () => {
        const work = jest
            .fn()
            .mockResolvedValue(
                ok("repo", [
                    group("matron-web", [
                        loop({ id: 1, title: "One", status: "parked" }),
                        loop({ id: 2, title: "Two", status: "parked" }),
                    ]),
                ]),
            );
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);
        await choose(container, "Status", "parked");
        await act(async () => rowFor(container, 2).click());
        expect(container.querySelector(".mj_WorkRow")).toBeNull();

        const back = container.querySelector<HTMLButtonElement>('button[aria-label="Back to work"]')!;
        await act(async () => back.click());

        expect(select(container, "Status").value).toBe("parked");
        expect(rowTitles(container)).toEqual(["#1One", "#2Two"]);
        expect(document.activeElement).toBe(rowFor(container, 2));
        expect(work).toHaveBeenCalledTimes(1);
        await unmount(root);
    });

    it("is driven by the tracker selection when controlled", async () => {
        const work = jest.fn().mockResolvedValue(ok("repo", [group("matron-web", [detailed])]));
        const onOpenLoop = jest.fn();
        const onCloseLoop = jest.fn();
        const { container, root } = await mount(
            <WorkView api={loader(work)} now={NOW} onOpenLoop={onOpenLoop} onCloseLoop={onCloseLoop} />,
        );

        await act(async () => rowFor(container, 42).click());
        expect(onOpenLoop).toHaveBeenCalledWith(42);
        // Controlled: nothing changes until the owner updates the selection.
        expect(container.querySelector(".mj_WorkDetail")).toBeNull();

        await act(async () =>
            root.render(
                <WorkView
                    api={loader(work)}
                    now={NOW}
                    selectedLoopId={42}
                    onOpenLoop={onOpenLoop}
                    onCloseLoop={onCloseLoop}
                />,
            ),
        );
        expect(container.querySelector("h1.mj_TrackerItemTitle")?.textContent).toBe("Upgrade the Work display");
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Back to work"]')!.click());
        expect(onCloseLoop).toHaveBeenCalledTimes(1);
        await unmount(root);
    });

    it("moves focus to the search field when leaving a detail that was reached by deep link", async () => {
        const work = jest.fn().mockResolvedValue(ok("repo", [group("matron-web", [detailed])]));
        const props = { api: loader(work), now: NOW, onOpenLoop: jest.fn(), onCloseLoop: jest.fn() };
        const { container, root } = await mount(<WorkView {...props} selectedLoopId={42} />);
        container.querySelector<HTMLButtonElement>('button[aria-label="Back to work"]')!.focus();

        await act(async () => root.render(<WorkView {...props} />));
        expect(document.activeElement).toBe(container.querySelector('input[aria-label="Search work"]'));
        await unmount(root);
    });

    it("does not steal focus when the list first mounts", async () => {
        const work = jest.fn().mockResolvedValue(ok("repo", [group("matron-web", [detailed])]));
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);
        expect(container.contains(document.activeElement)).toBe(false);
        await unmount(root);
    });

    it("says a deep-linked loop is not open instead of rendering a blank pane", async () => {
        const work = jest.fn().mockResolvedValue(ok("repo", [group("matron-web", [loop({ id: 1 })])]));
        const { container, root } = await mount(
            <WorkView
                api={loader(work)}
                now={NOW}
                selectedLoopId={777}
                onOpenLoop={jest.fn()}
                onCloseLoop={jest.fn()}
            />,
        );

        expect(container.querySelector(".mj_TrackerItemHead_kind")?.textContent).toBe("#777 · Loop");
        expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe("Loop #777 isn’t open");
        await unmount(root);
    });

    it("shows loading, then the loop, for a deep link that lands before the data", async () => {
        let resolve!: (value: WorkViewEnvelope) => void;
        const work = jest.fn(
            () =>
                new Promise<WorkViewEnvelope>((settle) => {
                    resolve = settle;
                }),
        );
        const { container, root } = await mount(
            <WorkView
                api={loader(work)}
                now={NOW}
                selectedLoopId={42}
                onOpenLoop={jest.fn()}
                onCloseLoop={jest.fn()}
            />,
        );
        expect(container.querySelector("[role='status']")?.textContent).toContain("Loading Work");
        await act(async () => resolve(ok("repo", [group("matron-web", [detailed])])));
        expect(container.querySelector("h1.mj_TrackerItemTitle")?.textContent).toBe("Upgrade the Work display");
        await unmount(root);
    });

    it("omits the owner, opened and next-step pieces when the server does not send them", async () => {
        const work = jest.fn().mockResolvedValue(ok("repo", [group("matron-web", [loop({ id: 3 })])]));
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);
        await act(async () => rowFor(container, 3).click());

        const labels = Array.from(container.querySelectorAll(".mj_WorkMeta_label")).map((node) => node.textContent);
        expect(labels).toEqual(["Priority", "Domain", "Repo"]);
        expect(container.querySelector(".mj_WorkNext")).toBeNull();
        await unmount(root);
    });
});

describe("WorkView — against real producer output", () => {
    it("applies the default status filter to a genuinely producer-generated payload", async () => {
        // The statuses elsewhere in this file are consumer-authored. This one is not: the fixture
        // is raw output from the producer CLI over a synthetic store (see
        // fixtures/WORK-VIEW-FIXTURES.md), so it proves the pane's set-aside semantics agree with
        // what the producer actually emits.
        const work = jest.fn().mockResolvedValue(parseWorkViewEnvelope(okFixture));
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        expect(container.textContent).toContain("work-view-fixture-claimed-with-label");
        expect(container.textContent).not.toContain("work-view-fixture-parked");
        expect(container.textContent).toContain("work-view-fixture-no-description");
        // The structured description previews its lead sentence only.
        expect(rowFor(container, 901).querySelector(".mj_WorkRow_lead")?.textContent).toBe(
            "A claimed loop whose holder published a label.",
        );

        await choose(container, "Status", "all");
        expect(container.textContent).toContain("work-view-fixture-parked");
        await unmount(root);
    });

    it("renders the detail-capable producer payload end to end", async () => {
        const work = jest.fn().mockResolvedValue(parseWorkViewEnvelope(okDetailFixture));
        const { container, root } = await mount(<WorkView api={loader(work)} now={NOW} />);

        expect(rowFor(container, 901).querySelector(".mj_WorkRow_owner")?.textContent).toBe("Operator");
        await act(async () => rowFor(container, 901).click());
        expect(container.querySelector(".mj_WorkNext_text")?.textContent).toBe(
            "Build the detail view, then run the contact sheet.",
        );
        expect(container.querySelector(".mj_WorkDetail_body code")?.textContent).toBe("description");
        expect(container.querySelector(".mj_WorkDetail_body a")?.getAttribute("href")).toBe(
            "https://example.com/work-view.schema.json",
        );
        await unmount(root);
    });
});

describe("summaryLine", () => {
    it("previews the lead paragraph of a structured description", () => {
        const structured = "A one-line summary that stands alone.\n\n**Detail**\n- a bullet\n- another bullet";
        expect(summaryLine(structured)).toBe("A one-line summary that stands alone.");
    });

    it("falls back to the whole text for an unstructured description", () => {
        const legacy = "One long unbroken paragraph. Second sentence. Third sentence.";
        expect(summaryLine(legacy)).toBe(legacy);
    });

    it("collapses newlines inside the lead paragraph", () => {
        expect(summaryLine("wrapped\nlead line\n\nrest")).toBe("wrapped lead line");
    });

    it("strips inline markdown so the preview reads as prose", () => {
        expect(summaryLine("**Bold** lead with `code` and a [link](https://x.test).")).toBe(
            "Bold lead with code and a link.",
        );
        // snake_case identifiers are not emphasis.
        expect(summaryLine("Rename load_active_loops_strict first.")).toBe("Rename load_active_loops_strict first.");
    });

    it("is empty for an empty description", () => {
        expect(summaryLine("")).toBe("");
        expect(summaryLine("   \n\n  ")).toBe("");
    });
});
