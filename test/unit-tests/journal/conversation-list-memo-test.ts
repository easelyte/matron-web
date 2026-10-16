/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

import { sameStateExcept } from "../../../src/journal/components";
import type { ClientState } from "../../../src/journal/types";

describe("sameStateExcept", () => {
    const base = {
        conversations: [],
        textStreams: {},
        toolStreams: {},
        selectedConversationId: "a",
    } as unknown as ClientState;
    const ignored = new Set<keyof ClientState>(["textStreams", "toolStreams"]);

    it("treats a change to an ignored field as no change", () => {
        expect(sameStateExcept(base, { ...base, textStreams: { m1: "Hel" } }, ignored)).toBe(true);
        expect(sameStateExcept(base, { ...base, toolStreams: {} }, ignored)).toBe(true);
    });

    it("sees a change to any other field", () => {
        expect(sameStateExcept(base, { ...base, selectedConversationId: "b" }, ignored)).toBe(false);
        expect(sameStateExcept(base, { ...base, conversations: [] }, ignored)).toBe(false);
    });

    it("sees a field that appears or disappears", () => {
        expect(sameStateExcept(base, { ...base, controlError: "offline" }, ignored)).toBe(false);
        const { selectedConversationId: _dropped, ...rest } = base;
        expect(sameStateExcept(base, rest as ClientState, ignored)).toBe(false);
    });
});
