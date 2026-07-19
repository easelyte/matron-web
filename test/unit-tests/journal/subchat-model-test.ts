import { coerceParentId } from "../../src/journal/types";

describe("coerceParentId", () => {
    it("returns null for non-string, empty, and whitespace inputs", () => {
        for (const bad of [0, {}, [], null, undefined, "", "   "]) {
            expect(coerceParentId(bad)).toBeNull();
        }
    });
    it("returns the trimmed string for a real id", () => {
        expect(coerceParentId("p1:sub:a1")).toBe("p1:sub:a1");
        expect(coerceParentId("  p1:sub:a1  ")).toBe("p1:sub:a1");
    });
});
