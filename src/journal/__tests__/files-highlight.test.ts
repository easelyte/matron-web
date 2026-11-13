import { CODE_HIGHLIGHT_MAX, escapeHtml, highlightFile } from "../files/highlight";

describe("highlightFile (engine loads on first use)", () => {
    it("highlights by extension", async () => {
        const result = await highlightFile("a.json", '{"a": 1}');
        expect(result.language).toBe("json");
        expect(result.html).toContain("hljs-");
        expect(result.skipped).toBe(false);
    });

    it("skips highlighting above the size cap and escapes the text", async () => {
        const result = await highlightFile("a.ts", "<".repeat(CODE_HIGHLIGHT_MAX + 1));
        expect(result.skipped).toBe(true);
        expect(result.html.startsWith("&lt;")).toBe(true);
    });

    it("escapes html", () => {
        expect(escapeHtml("<a&b>")).toBe("&lt;a&amp;b&gt;");
    });
});
