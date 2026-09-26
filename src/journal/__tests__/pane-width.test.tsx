/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { applyPaneBand, paneBand } from "../pane-width";

describe("chat-pane breakpoints", () => {
    it("bands the chat pane width: narrow ≤480 · medium ≤760 · wide", () => {
        expect(paneBand(420)).toBe("narrow");
        expect(paneBand(480)).toBe("narrow");
        expect(paneBand(481)).toBe("medium");
        expect(paneBand(760)).toBe("medium");
        expect(paneBand(761)).toBe("wide");
    });

    it("sets data-pane on the chat pane for its band", () => {
        const pane = document.createElement("div");
        applyPaneBand(pane, 420);
        expect(pane.dataset.pane).toBe("narrow");
        applyPaneBand(pane, 700);
        expect(pane.dataset.pane).toBe("medium");
        applyPaneBand(pane, 1100);
        expect(pane.dataset.pane).toBe("wide");
    });
});
