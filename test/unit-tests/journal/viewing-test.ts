import { isTabFocused, viewingConvoId, watchTabFocus } from "../../../src/journal/viewing";

it.each([
    ["visible", true, "c1"],
    ["visible", false, "c1"],
    ["hidden", true, null],
    ["hidden", false, null],
] as const)("reports viewing for visibility %s and focus %s", (visibilityState, focused, expected) => {
    const doc = { visibilityState, hasFocus: () => focused };
    expect(isTabFocused(doc)).toBe(visibilityState === "visible" && focused);
    expect(viewingConvoId("c1", doc)).toBe(expected);
    expect(viewingConvoId(undefined, doc)).toBeNull();
    expect(viewingConvoId("", doc)).toBeNull();
});

it("watches focus, blur and visibility changes and removes every listener", () => {
    const changed = jest.fn();
    const stop = watchTabFocus(window, document, changed);
    const fire = () => {
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
    };
    fire();
    expect(changed).toHaveBeenCalledTimes(3);
    stop();
    fire();
    expect(changed).toHaveBeenCalledTimes(3);
});
