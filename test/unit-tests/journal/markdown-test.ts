/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toString } from "hast-util-to-string";

import { copyText } from "../../../src/journal/clipboard";
import { HIGHLIGHT_MAX, MARKDOWN_MAX, MarkdownBody } from "../../../src/journal/markdown";

jest.mock("../../../src/journal/clipboard", () => ({ copyText: jest.fn() }));
jest.mock("hast-util-to-string", () => {
    const actual = jest.requireActual("hast-util-to-string");
    return { ...actual, toString: jest.fn(actual.toString) };
});

const copyTextMock = jest.mocked(copyText);
const actualToString = jest.requireActual<typeof import("hast-util-to-string")>("hast-util-to-string").toString;
const toStringMock = jest.mocked(toString);

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
    copyTextMock.mockReset();
    toStringMock.mockImplementation(actualToString);
    jest.useRealTimers();
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

test("does not autodetect an untyped fence", async () => {
    const container = await renderMarkdown("```\nconst answer = 42;\n```");
    const code = container.querySelector("code");

    expect(code?.classList.contains("hljs")).toBe(false);
    expect(code?.querySelectorAll('[class^="hljs-"]').length).toBe(0);
});

test("leaves an oversized labeled fence unhighlighted", async () => {
    const source = "a".repeat(HIGHLIGHT_MAX + 1);
    const container = await renderMarkdown(`\`\`\`js\n${source}\n\`\`\``);
    const code = container.querySelector("code");

    expect(code?.textContent).toBe(`${source}\n`);
    expect(code?.classList.contains("hljs")).toBe(false);
    expect(code?.querySelectorAll('[class^="hljs-"]').length).toBe(0);
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

test("hardens scheme-relative external links", async () => {
    const container = await renderMarkdown("[sign in](//attacker.example/phish)");
    const link = container.querySelector("a");

    expect(link?.getAttribute("href")).toBe("//attacker.example/phish");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer nofollow");
});

test("renders an unterminated TypeScript fence safely while streaming", async () => {
    const container = await renderMarkdown("```ts\nconst partial: string =", true);

    expect(container.querySelector("code")?.textContent).toBe("const partial: string =\n");
    expect(container.querySelector(".hljs")).toBeNull();
});

test("copies the exact raw fenced source and gates the success label on copyText", async () => {
    copyTextMock.mockResolvedValue(true);
    const container = await renderMarkdown("```ts\nconst first = 1;\n  const indented = 2;\n```");
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');

    expect(button).not.toBeNull();
    await act(async () => button!.click());

    expect(copyTextMock).toHaveBeenCalledWith("const first = 1;\n  const indented = 2;\n");
    expect(button?.textContent).toBe("Copied");
});

test("shows copy failure when copyText returns false", async () => {
    copyTextMock.mockResolvedValue(false);
    const container = await renderMarkdown("```js\nalert('no');\n```");
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');

    await act(async () => button!.click());

    expect(button?.textContent).toBe("Copy failed");
});

test("a second copy clears the first label timeout", async () => {
    jest.useFakeTimers();
    copyTextMock.mockResolvedValue(true);
    const container = await renderMarkdown("```ts\nconst value = 1;\n```");
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!;

    await act(async () => button.click());
    await act(async () => jest.advanceTimersByTime(1_000));
    await act(async () => button.click());
    await act(async () => jest.advanceTimersByTime(600));

    expect(button.textContent).toBe("Copied");

    await act(async () => jest.advanceTimersByTime(900));
    expect(button.textContent).toBe("Copy");
});

test("ignores a stale copy result when overlapping copies finish out of order", async () => {
    let resolveFirst!: (copied: boolean) => void;
    let resolveSecond!: (copied: boolean) => void;
    const first = new Promise<boolean>((resolve) => {
        resolveFirst = resolve;
    });
    const second = new Promise<boolean>((resolve) => {
        resolveSecond = resolve;
    });
    copyTextMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const container = await renderMarkdown("```ts\nconst value = 1;\n```");
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!;

    act(() => button.click());
    act(() => button.click());
    await act(async () => resolveSecond(true));
    expect(button.textContent).toBe("Copied");

    await act(async () => resolveFirst(false));
    expect(button.textContent).toBe("Copied");
});

test("clears the copy label timeout when its code block unmounts", async () => {
    jest.useFakeTimers();
    copyTextMock.mockResolvedValue(true);
    const container = await renderMarkdown("```ts\nconst value = 1;\n```");
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!;
    const setTimeoutSpy = jest.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = jest.spyOn(globalThis, "clearTimeout");

    await act(async () => button.click());
    const timerCall = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 1_500);
    const copyTimer = setTimeoutSpy.mock.results[timerCall]?.value;
    expect(timerCall).toBeGreaterThanOrEqual(0);
    await act(async () => rendered.at(-1)!.root.unmount());

    expect(clearTimeoutSpy).toHaveBeenCalledWith(copyTimer);
    expect(() => jest.runOnlyPendingTimers()).not.toThrow();
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    container.remove();
    rendered.pop();
});

test("truncates long fence labels and omits a label for an untyped fence", async () => {
    const longLabel = await renderMarkdown("```averyverylonglanguage\nvalue\n```");
    const label = longLabel.querySelector(".mj_CodeBlock_lang");

    expect(label?.textContent?.length).toBeLessThanOrEqual(16);

    const untyped = await renderMarkdown("```\nvalue\n```");
    expect(untyped.querySelector(".mj_CodeBlock_lang")).toBeNull();
});

test("isolates markdown render failures and logs the failing label", async () => {
    const error = new Error("code block render failed");
    toStringMock.mockImplementation((node) => {
        const text = actualToString(node);
        if (text.includes("failed")) throw error;
        return text;
    });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    rendered.push({ container, root });

    const badText = "```ts\nfailed\n```";
    await act(async () => {
        root.render(
            React.createElement(React.Fragment, null, [
                React.createElement(MarkdownBody, { text: badText, label: "bad-row", key: "bad" }),
                React.createElement(MarkdownBody, { text: "**healthy**", label: "good-row", key: "good" }),
            ]),
        );
    });

    expect(container.querySelector(".mj_MarkdownRaw")?.textContent).toBe(badText);
    expect(container.querySelector("strong")?.textContent).toBe("healthy");
    expect(consoleError).toHaveBeenCalledWith("[markdown] render failed", { label: "bad-row", err: error });
    consoleError.mockRestore();
});

test("resets a tripped boundary when the same row receives new text", async () => {
    const error = new Error("transient render failure");
    toStringMock.mockImplementation((node) => {
        const text = actualToString(node);
        if (text.includes("failed")) throw error;
        return text;
    });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    rendered.push({ container, root });

    await act(async () => {
        root.render(React.createElement(MarkdownBody, { text: "```ts\nfailed\n```", label: "stream-row" }));
    });
    expect(container.querySelector(".mj_MarkdownRaw")).not.toBeNull();

    await act(async () => {
        root.render(React.createElement(MarkdownBody, { text: "**recovered**", label: "stream-row" }));
    });

    expect(container.querySelector(".mj_MarkdownRaw")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("recovered");
    consoleError.mockRestore();
});
