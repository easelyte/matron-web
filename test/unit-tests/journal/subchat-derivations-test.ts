import { isSubChat, childrenOf, runningChildrenOf, parentPresent } from "../../../src/journal/types";
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
});
