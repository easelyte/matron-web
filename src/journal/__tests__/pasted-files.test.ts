/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { namedPastedFiles } from "../pasted-files";

const NOW = new Date(2026, 10, 5, 14, 3, 9);
const image = (name = "image.png", type = "image/png"): File => new File(["img"], name, { type });
const names = (files: File[]): string[] => files.map((file) => file.name);
const withHtml = (html: string) => (format: string) => (format === "text/html" ? html : "");

describe("namedPastedFiles", () => {
    it("keeps the name of a copied file", () => {
        const file = new File(["%PDF"], "Quarterly report v2.pdf", { type: "application/pdf" });
        expect(namedPastedFiles({ files: [file] }, NOW)[0]).toBe(file);
    });

    it.each(["image.jpg", "image.pdf", "image.png.zip"])("keeps a copied file called %s", (name) => {
        const file = new File(["x"], name);
        expect(namedPastedFiles({ files: [file] }, NOW)[0]).toBe(file);
    });

    it("gives a renamed image the extension of its type", () => {
        expect(names(namedPastedFiles({ files: [image("image.png", "image/jpeg")] }, NOW))).toEqual([
            "pasted-image-2026-11-05-140309.jpeg",
        ]);
    });

    it("names a screenshot for what it is and when it was pasted", () => {
        expect(names(namedPastedFiles({ files: [image()] }, NOW))).toEqual(["pasted-image-2026-11-05-140309.png"]);
    });

    it("names a nameless file from its type", () => {
        const file = new File(["x"], "", { type: "application/pdf" });
        expect(names(namedPastedFiles({ files: [file] }, NOW))).toEqual(["pasted-file-2026-11-05-140309.pdf"]);
    });

    it("takes a copied image's name from its address, with the extension of its bytes", () => {
        const getData = withHtml(`<meta charset="utf-8"><img src="https://example.com/a/Team%20photo.jpg?w=300">`);
        expect(names(namedPastedFiles({ files: [image()], getData }, NOW))).toEqual(["Team photo.png"]);
    });

    it.each([
        ["a page", `<img src="https://example.com/article.html">`],
        ["inline data", `<img src="data:image/png;base64,iVBORw0KGgo=">`],
        ["an address with no file in it", `<img src="https://example.com/">`],
        ["only dots", `<img src="https://example.com/...png">`],
        ["markup with no image", `<p>hello</p>`],
        ["markup with several images", `<img src="https://example.com/a.png"><img src="https://example.com/b.png">`],
    ])("ignores %s", (_label, html) => {
        const files = namedPastedFiles({ files: [image()], getData: withHtml(html) }, NOW);
        expect(names(files)).toEqual(["pasted-image-2026-11-05-140309.png"]);
    });

    it("does not guess whose address is whose across several images", () => {
        const getData = withHtml(`<img src="https://example.com/cat.png">`);
        expect(names(namedPastedFiles({ files: [image(), image()], getData }, NOW))).toEqual([
            "pasted-image-2026-11-05-140309.png",
            "pasted-image-2026-11-05-140309.png",
        ]);
    });

    it("keeps the bytes and type of a renamed file", async () => {
        const [renamed] = namedPastedFiles({ files: [image()] }, NOW);
        expect(renamed.type).toBe("image/png");
        expect(renamed.size).toBe(3);
    });
});
