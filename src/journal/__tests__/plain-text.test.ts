/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { snippetText } from "../plain-text";

describe("snippetText (sidebar previews)", () => {
    it("reads as prose: bold, code, links and headings lose their markers", () => {
        expect(snippetText("**P1 — BRIDGE_DOWN** Operator bridge service not responding")).toBe(
            "P1 — BRIDGE_DOWN Operator bridge service not responding",
        );
        expect(snippetText("**TECH & AI BRIEF — 2026-09-23 (cont.)** [Opus 5.5](https://x.test/o) ships")).toBe(
            "TECH & AI BRIEF — 2026-09-23 (cont.) Opus 5.5 ships",
        );
        expect(snippetText("🔧 `sed -n 1,60p anton/core/paths.py | grep -n`")).toBe(
            "🔧 sed -n 1,60p anton/core/paths.py | grep -n",
        );
        expect(snippetText("# Heading first")).toBe("Heading first");
    });

    it("drops a mid-line heading and the unclosed marker a 120-char cut leaves behind", () => {
        expect(snippetText("Pushed. Session closed. ## Session summary **Do")).toBe(
            "Pushed. Session closed. Session summary Do",
        );
        expect(snippetText("ran `pnpm te")).toBe("ran pnpm te");
    });

    it("keeps what is not markup: issue hashes, snake_case, plain text", () => {
        expect(snippetText("Needs you — task #147 and #785")).toBe("Needs you — task #147 and #785");
        expect(snippetText("keep BRIDGE_DOWN and snake_case_names")).toBe("keep BRIDGE_DOWN and snake_case_names");
        expect(snippetText("Restarted nginx; error rate steady at 0.02%")).toBe(
            "Restarted nginx; error rate steady at 0.02%",
        );
        expect(snippetText("")).toBe("");
    });
});
