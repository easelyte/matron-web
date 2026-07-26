/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { markdownToPlainText } from "../../../src/journal/markdown";

describe("markdownToPlainText", () => {
    it("preserves intraword underscores in technical identifiers (not emphasis)", () => {
        expect(markdownToPlainText("AWS_ACCESS_KEY_ID")).toBe("AWS_ACCESS_KEY_ID");
        expect(markdownToPlainText("foo_bar_baz")).toBe("foo_bar_baz");
        expect(markdownToPlainText("my_file_name.txt")).toBe("my_file_name.txt");
        expect(markdownToPlainText("export AWS_ACCESS_KEY_ID=abc and foo_bar_baz")).toBe(
            "export AWS_ACCESS_KEY_ID=abc and foo_bar_baz",
        );
    });

    it("strips real emphasis but keeps the inner text", () => {
        expect(markdownToPlainText("**bold** and *italic* and _under_")).toBe("bold and italic and under");
        expect(markdownToPlainText("~~struck~~ through")).toBe("struck through");
    });

    it("unescapes escaped punctuation instead of leaving backslashes", () => {
        expect(markdownToPlainText("\\*literal\\*")).toBe("*literal*");
        expect(markdownToPlainText("a \\_b\\_ c")).toBe("a _b_ c");
    });

    it("reduces links to their visible text and drops the URL", () => {
        expect(markdownToPlainText("see [the docs](https://example.test/x) now")).toBe("see the docs now");
        expect(markdownToPlainText("![alt text](https://example.test/i.png)")).toBe("alt text");
    });

    it("keeps inline code and fenced-code content verbatim", () => {
        expect(markdownToPlainText("run `git status` please")).toBe("run git status please");
        expect(markdownToPlainText("```bash\nexport AWS_ACCESS_KEY_ID=abc\n```")).toBe("export AWS_ACCESS_KEY_ID=abc");
        // Underscores inside a code span must survive (they never parse as emphasis there).
        expect(markdownToPlainText("`a_b_c`")).toBe("a_b_c");
    });

    it("separates block elements with blank lines and flattens list bullets/headings", () => {
        expect(markdownToPlainText("# Title\n\nbody text")).toBe("Title\n\nbody text");
        expect(markdownToPlainText("- one\n- two")).toBe("one\n\ntwo");
    });

    it("returns an empty string for empty or whitespace-only input", () => {
        expect(markdownToPlainText("")).toBe("");
        expect(markdownToPlainText("   \n  ")).toBe("");
    });
});
