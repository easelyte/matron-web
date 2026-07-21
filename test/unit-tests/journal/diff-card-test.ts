/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { parseDiffPayload } from "../../../src/journal/components";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

describe("parseDiffPayload", () => {
    it("parses a rich diff payload", () => {
        expect(
            parseDiffPayload({
                diff: "+new line",
                display_path: "src/example.ts",
                file_path: "/workspace/src/example.ts",
                viewer_url: "https://example.test/view?token=secret",
                tool: "edit",
                label: "Updated",
                added: 2,
                removed: 1,
                truncated: true,
                new_file: true,
            }),
        ).toEqual({
            diff: "+new line",
            displayPath: "src/example.ts",
            filePath: "/workspace/src/example.ts",
            viewerUrl: "https://example.test/view?token=secret",
            tool: "edit",
            label: "Updated",
            added: 2,
            removed: 1,
            truncated: true,
            newFile: true,
        });
    });

    it("leaves optional metadata undefined for a bare diff", () => {
        expect(parseDiffPayload({ diff: " context" })).toEqual({
            diff: " context",
            displayPath: undefined,
            filePath: undefined,
            viewerUrl: undefined,
            tool: undefined,
            label: undefined,
            added: undefined,
            removed: undefined,
            truncated: false,
            newFile: false,
        });
    });

    it("falls back to a legacy patch", () => {
        expect(parseDiffPayload({ patch: "@@ legacy @@" }).diff).toBe("@@ legacy @@");
    });

    it("preserves an explicitly empty diff instead of falling back to patch", () => {
        expect(parseDiffPayload({ diff: "", patch: "@@ legacy @@" }).diff).toBe("");
    });

    it("falls back to diagnostic JSON when diff and patch are absent", () => {
        const payload = { type: "diff", foo: 1 };
        expect(parseDiffPayload(payload).diff).toBe(JSON.stringify(payload, null, 2));
    });

    it.each([null, "", "javascript:alert(1)", "data:text/html,x", "/view?token=x"])(
        "rejects unsafe or invalid viewer URL %p without throwing",
        (viewerUrl) => {
            expect(() => parseDiffPayload({ diff: "x", viewer_url: viewerUrl })).not.toThrow();
            expect(parseDiffPayload({ diff: "x", viewer_url: viewerUrl }).viewerUrl).toBeUndefined();
        },
    );

    it("accepts an absolute HTTPS viewer URL", () => {
        expect(parseDiffPayload({ diff: "x", viewer_url: "https://example.test/view" }).viewerUrl).toBe(
            "https://example.test/view",
        );
    });

    it("treats empty optional strings as absent", () => {
        expect(parseDiffPayload({ diff: "x", display_path: "", file_path: "a/b.ts" })).toMatchObject({
            displayPath: undefined,
            filePath: "a/b.ts",
        });
    });

    it("keeps numeric counts and rejects string counts", () => {
        expect(parseDiffPayload({ diff: "x", added: 3, removed: 2 })).toMatchObject({ added: 3, removed: 2 });
        expect(parseDiffPayload({ diff: "x", added: "3", removed: "2" })).toMatchObject({
            added: undefined,
            removed: undefined,
        });
    });

    it("accepts only strict booleans for flags", () => {
        expect(parseDiffPayload({ diff: "x", truncated: "true", new_file: "true" })).toMatchObject({
            truncated: false,
            newFile: false,
        });
    });
});
