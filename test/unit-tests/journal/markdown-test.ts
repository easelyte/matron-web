/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MARKDOWN_MAX, MarkdownBody } from "../../../src/journal/markdown";

interface RenderedMarkdown {
    container: HTMLDivElement;
    root: Root;
}

const rendered: RenderedMarkdown[] = [];

async function renderMarkdown(text: string, streaming = false): Promise<HTMLDivElement> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    rendered.push({ container, root });
    await act(async () => {
        root.render(React.createElement(MarkdownBody, { text, streaming, label: "test-message" }));
    });
    return container;
}

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
    while (rendered.length) {
        const current = rendered.pop()!;
        await act(async () => current.root.unmount());
        current.container.remove();
    }
});

test("renders inline markdown formatting with semantic tags", async () => {
    const container = await renderMarkdown("**bold** *emphasis* `inline` [link](/journal)");

    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("emphasis");
    expect(container.querySelector("code.mj_InlineCode")?.textContent).toBe("inline");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/journal");
});

test("renders GFM tables, task lists, and strikethrough", async () => {
    const container = await renderMarkdown(
        "| Name | Done |\n| --- | --- |\n| Test | yes |\n\n- [x] shipped\n\n~~removed~~",
    );

    expect(container.querySelector("table tbody td")?.textContent).toBe("Test");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    expect(container.querySelector("del")?.textContent).toBe("removed");
});

test("highlights a TypeScript fence using its ts alias", async () => {
    const container = await renderMarkdown("```ts\nconst answer: number = 42;\n```");
    const code = container.querySelector("code");

    expect(code?.classList.contains("hljs")).toBe(true);
    expect(code?.querySelectorAll('[class^="hljs-"]').length).toBeGreaterThan(0);
});

test("leaves an unknown language fence unhighlighted without throwing", async () => {
    const container = await renderMarkdown("```notalang\nsome words\n```");
    const code = container.querySelector("code");

    expect(code?.className).toBe("hljs language-notalang");
    expect(code?.querySelectorAll('[class^="hljs-"]').length).toBe(0);
});

test("omits highlighting while streaming", async () => {
    const container = await renderMarkdown("```ts\nconst answer: number = 42;\n```", true);
    const code = container.querySelector("code");

    expect(code?.classList.contains("hljs")).toBe(false);
    expect(code?.querySelectorAll('[class^="hljs-"]').length).toBe(0);
});

test("uses the raw fallback above the markdown size limit", async () => {
    const text = "x".repeat(MARKDOWN_MAX + 1);
    const container = await renderMarkdown(text);
    const fallback = container.querySelector(".mj_MessageText.mj_MarkdownRaw");

    expect(fallback?.textContent).toBe(text);
    expect(container.querySelector("p")).toBeNull();
});

test("renders markdown images as hardened links without fetching them", async () => {
    const container = await renderMarkdown("![diagram](https://example.com/diagram.png)");
    const link = container.querySelector("a");

    expect(container.querySelector("img")).toBeNull();
    expect(link?.textContent).toBe("diagram");
    expect(link?.getAttribute("href")).toBe("https://example.com/diagram.png");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
});

test("escapes raw HTML, strips unsafe URLs, and hardens external links", async () => {
    const container = await renderMarkdown(
        '<img src="x" onerror="alert(1)"> [unsafe](javascript:alert(1)) [safe](https://example.com)',
    );
    const links = container.querySelectorAll("a");

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src="x" onerror="alert(1)">');
    expect(links[0]?.hasAttribute("href")).toBe(false);
    expect(links[0]?.hasAttribute("target")).toBe(false);
    expect(links[1]?.getAttribute("target")).toBe("_blank");
    expect(links[1]?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
});

test("renders an unterminated TypeScript fence safely while streaming", async () => {
    const container = await renderMarkdown("```ts\nconst partial: string =", true);

    expect(container.querySelector("code")?.textContent).toBe("const partial: string =\n");
    expect(container.querySelector(".hljs")).toBeNull();
});
