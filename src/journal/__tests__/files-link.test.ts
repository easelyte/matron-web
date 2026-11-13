/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { MouseEvent as ReactMouseEvent } from "react";

import { FILE_VIEWER_OPEN, filesDeepLinkHash, handleViewerLinkClick, viewerFilePath } from "../files-link";

function signed(payload: unknown, base = "https://any-bridge.example/nested/view"): string {
    const token = Buffer.from(JSON.stringify(payload)).toString("base64url") + ".signature";
    return `${base}?token=${token}`;
}

describe("viewerFilePath", () => {
    it.each(["#files=%2Fhome%2Freport.md", "http://localhost/#files=%2Fhome%2Freport.md"])(
        "reads a Files link: %s",
        (href) => {
            expect(viewerFilePath(href)).toBe("/home/report.md");
            expect(filesDeepLinkHash(href)).toBe("#files=%2Fhome%2Freport.md");
        },
    );
    it("decodes UTF-8 base64url on any http(s) host, ignoring expiry and other fields", () => {
        expect(viewerFilePath(signed({ path: "/home/日本語 résumé.md", exp: 1 }))).toBe("/home/日本語 résumé.md");
        expect(viewerFilePath(signed({ path: "/x" }, "http://another.example/view"))).toBe("/x");
    });
    it.each([
        undefined,
        "",
        "#files=",
        "#files=relative.md",
        "#files=%ZZ",
        "https://foreign.example/#files=%2Fx",
        "/view",
        "/view?token=broken.signature",
        "/view?token=***.sig",
        "/view?token=e30",
        "/view?token=e30.",
        signed({}),
        signed(null),
        signed({ path: 42 }),
        signed({ path: "" }),
        signed({ path: "relative.md" }),
        signed({ path: "/x" }, "https://example.com/download"),
        signed({ path: "/x" }, "https://example.com/page"),
        signed({ path: "/x" }, "https://example.com/view/"),
        signed({ path: "/x" }, "ftp://example.com/view"),
        "/view?token=e30.extra.sig",
    ])("leaves other or malformed links alone: %s", (href) => {
        expect(viewerFilePath(href)).toBeNull();
    });
});

describe("handleViewerLinkClick", () => {
    const opener = document.createElement("a");
    function click(overrides: Record<string, unknown> = {}): ReactMouseEvent<HTMLAnchorElement> {
        return {
            button: 0,
            defaultPrevented: false,
            currentTarget: opener,
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            ...overrides,
        } as unknown as ReactMouseEvent<HTMLAnchorElement>;
    }
    it.each(["#files=%2Fx", signed({ path: "/x" })])("opens only the path in place, preserving history: %s", (href) => {
        const listener = jest.fn();
        window.addEventListener(FILE_VIEWER_OPEN, listener);
        const previousUrl = window.location.href;
        opener.href = href;
        const event = click();
        handleViewerLinkClick(event, viewerFilePath(href)!);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(event.stopPropagation).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledTimes(1);
        expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ path: "/x", opener, href: opener.href });
        expect(window.location.href).toBe(previousUrl);
        window.removeEventListener(FILE_VIEWER_OPEN, listener);
    });
    it.each([
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
        { button: 1 },
        { button: 2 },
        { defaultPrevented: true },
    ])("keeps the browser default: %p", (overrides) => {
        const listener = jest.fn();
        window.addEventListener(FILE_VIEWER_OPEN, listener);
        const event = click(overrides);
        handleViewerLinkClick(event, "/x");
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).toHaveBeenCalledTimes(1);
        expect(listener).not.toHaveBeenCalled();
        window.removeEventListener(FILE_VIEWER_OPEN, listener);
    });
});
