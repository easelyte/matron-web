import {
    buildSidebarIndex,
    childSidebarPlacement,
    hasSubagentChildRows,
    isSubChat,
    childrenOf,
    runningChildrenOf,
    parentPresent,
} from "../../../src/journal/types";
import type { Conversation } from "../../../src/journal/types";

const convo = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
    id,
    title: "",
    session_state: "done",
    last_seq: 0,
    unread_count: 0,
    snippet: "",
    created_at: 0,
    read_up_to_seq: 0,
    ...extra,
});

describe("subchat derivations", () => {
    const p = convo("p1");
    const c1 = convo("p1:sub:a1", { parent_convo_id: "p1", created_at: 1, session_state: "running" });
    const c2 = convo("p1:sub:a2", { parent_convo_id: "p1", created_at: 2, session_state: "done" });
    const c3 = convo("p1:sub:a1:sub:a3", { parent_convo_id: c1.id, created_at: 3, session_state: "done" });
    const all = [p, c2, c3, c1];

    it("isSubChat true only for linked convos", () => {
        expect(isSubChat(p)).toBe(false);
        expect(isSubChat(c1)).toBe(true);
    });
    it("childrenOf is oldest-first and nullish-safe", () => {
        expect(childrenOf(all, "p1").map((c) => c.id)).toEqual(["p1:sub:a1", "p1:sub:a2"]);
        expect(childrenOf(all, c1.id).map((c) => c.id)).toEqual(["p1:sub:a1:sub:a3"]);
        expect(childrenOf(all, undefined)).toEqual([]);
    });
    it("runningChildrenOf filters to running", () => {
        expect(runningChildrenOf(all, "p1").map((c) => c.id)).toEqual(["p1:sub:a1"]);
    });
    it("parentPresent false for self-parent and absent parent", () => {
        const ids = new Set(all.map((c) => c.id));
        expect(parentPresent(c1, ids)).toBe(true);
        expect(parentPresent(convo("x", { parent_convo_id: "x" }), new Set(["x"]))).toBe(false);
        expect(parentPresent(convo("y", { parent_convo_id: "gone" }), ids)).toBe(false);
    });

    describe("buildSidebarIndex placement resolution", () => {
        const placementOf = (convos: Conversation[], archived: Set<string>, id: string): string =>
            childSidebarPlacement(convos.find((c) => c.id === id)!, buildSidebarIndex(convos, archived));

        it("resolves a running grandchild rooted at an ARCHIVED parent to top-level (never lost)", () => {
            // archived A → done child B → running grandchild C. B is 'hidden', so it is NOT a
            // valid host: C cannot nest and must resolve to top-level (has a row), not vanish.
            const A = convo("A"); // root (archived below)
            const B = convo("B", { parent_convo_id: "A", session_state: "done" });
            const C = convo("C", { parent_convo_id: "B", session_state: "running" });
            const convos = [A, B, C];
            const archived = new Set(["A"]);
            expect(placementOf(convos, archived, "B")).toBe("hidden");
            expect(placementOf(convos, archived, "C")).toBe("top-level");
        });

        it("resolves a done grandchild rooted at an archived parent to hidden", () => {
            const A = convo("A");
            const B = convo("B", { parent_convo_id: "A", session_state: "done" });
            const C = convo("C", { parent_convo_id: "B", session_state: "done" });
            const convos = [A, B, C];
            expect(placementOf(convos, new Set(["A"]), "C")).toBe("hidden");
        });

        it("nests a running child under a real top-level parent but not under a nested one", () => {
            // GP (top-level) → running P (nests) → running grandchild G (parent P is nested, so
            // G resolves top-level, not nested).
            const GP = convo("GP", { session_state: "running" });
            const P = convo("P", { parent_convo_id: "GP", session_state: "running" });
            const G = convo("G", { parent_convo_id: "P", session_state: "running" });
            const convos = [GP, P, G];
            const empty = new Set<string>();
            expect(placementOf(convos, empty, "P")).toBe("nested");
            expect(placementOf(convos, empty, "G")).toBe("top-level");
        });

        it("collapsing a parent hides its running child (nested → hidden), consistently", () => {
            // P (top-level) → running child C nests. Collapsing P suppresses C from EVERY consumer
            // that reads placement: hidden means no render, no auto-select, no unread/badge/mark-all.
            const P = convo("P", { session_state: "running" });
            const C = convo("C", { parent_convo_id: "P", session_state: "running" });
            const convos = [P, C];
            const empty = new Set<string>();
            expect(childSidebarPlacement(C, buildSidebarIndex(convos, empty))).toBe("nested");
            expect(childSidebarPlacement(C, buildSidebarIndex(convos, empty, new Set(["P"])))).toBe("hidden");
            // The parent row itself is untouched by collapse.
            expect(childSidebarPlacement(P, buildSidebarIndex(convos, empty, new Set(["P"])))).toBe("top-level");
        });

        it("hasSubagentChildRows tracks the host relationship regardless of collapse", () => {
            const P = convo("P", { session_state: "running" });
            const C = convo("C", { parent_convo_id: "P", session_state: "running" });
            const convos = [P, C];
            const empty = new Set<string>();
            // True whether expanded or collapsed → the menu's "Show subagents" stays reachable.
            expect(hasSubagentChildRows(P, buildSidebarIndex(convos, empty))).toBe(true);
            expect(hasSubagentChildRows(P, buildSidebarIndex(convos, empty, new Set(["P"])))).toBe(true);
            // A parent whose only child is done hosts NO child row → no menu item.
            const D = convo("D", { parent_convo_id: "P", session_state: "done" });
            expect(hasSubagentChildRows(P, buildSidebarIndex([P, D], empty))).toBe(false);
            // A childless conversation never hosts rows.
            expect(hasSubagentChildRows(convo("solo"), buildSidebarIndex([convo("solo")], empty))).toBe(false);
        });

        it("collapsing a NON-host parent does nothing (orphan/archived children unaffected)", () => {
            // Archived parent A → running child C recovers to top-level (A is not a host). Collapsing
            // A must not turn C hidden — collapse only gates children that WOULD nest under a real row.
            const A = convo("A", { session_state: "running" });
            const C = convo("C", { parent_convo_id: "A", session_state: "running" });
            const convos = [A, C];
            const archived = new Set(["A"]);
            expect(childSidebarPlacement(C, buildSidebarIndex(convos, archived, new Set(["A"])))).toBe("top-level");
            expect(hasSubagentChildRows(A, buildSidebarIndex(convos, archived, new Set(["A"])))).toBe(false);
        });

        it("does not infinite-loop on a parent_convo_id cycle", () => {
            const A = convo("A", { parent_convo_id: "B", session_state: "running" });
            const B = convo("B", { parent_convo_id: "A", session_state: "running" });
            // The guarantee under test is termination; assert it returns a fully-populated index.
            const index = buildSidebarIndex([A, B], new Set<string>());
            expect(index.placement.size).toBe(2);
            expect(["nested", "top-level", "hidden"]).toContain(index.placement.get("A"));
            expect(["nested", "top-level", "hidden"]).toContain(index.placement.get("B"));
        });
    });
});
