/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe('client "send" operation ratchet', () => {
    it('keeps exactly three "send" sites and guards each against child conversations', () => {
        const source = readFileSync(join(process.cwd(), "src/journal/client.ts"), "utf8");
        const matches = [...source.matchAll(/op:\s*"send"/g)];

        expect(matches).toHaveLength(3);
        for (const match of matches) {
            const before = source.slice(0, match.index);
            const methodStart = before.lastIndexOf("\n    private ");
            const methodPrefix = source.slice(methodStart, match.index);
            expect(methodPrefix).toContain("isChildConvo(");
        }
    });
});
