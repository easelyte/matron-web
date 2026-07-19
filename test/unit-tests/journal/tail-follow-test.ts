import { isNearBottom } from "../../../src/journal/types";

describe("isNearBottom", () => {
    it("uses an inclusive 80px threshold by default", () => {
        expect(isNearBottom(821, 1000, 100)).toBe(true);
        expect(isNearBottom(820, 1000, 100)).toBe(true);
        expect(isNearBottom(819, 1000, 100)).toBe(false);
    });
});
