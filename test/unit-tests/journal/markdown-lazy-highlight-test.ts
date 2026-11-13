/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { Root } from "react-dom/client";

// Each test resets the module registry so markdown.tsx starts with no highlighter loaded. React
// and react-dom are imported from the same fresh registry, so there is one copy of React.
type Act = typeof import("react").act;
const cleanups: Array<() => void> = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    document.body.innerHTML = "";
    jest.resetModules();
    jest.dontMock("../../../src/journal/highlighter");
});

async function freshModules(): Promise<{
    markdown: typeof import("../../../src/journal/markdown");
    act: Act;
    render: (text: string, streaming?: boolean) => Promise<HTMLDivElement>;
}> {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const markdown = await import("../../../src/journal/markdown");
    const act = React.act;
    const render = async (text: string, streaming = false): Promise<HTMLDivElement> => {
        const container = document.createElement("div");
        document.body.append(container);
        const root: Root = createRoot(container);
        cleanups.push(() => act(() => root.unmount()));
        await act(async () => {
            root.render(React.createElement(markdown.MarkdownBody, { text, streaming, label: "test-message" }));
        });
        return container;
    };
    return { markdown, act, render };
}

test("a labelled fence renders plain first, then highlights once the highlighter loads", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const markdown = await import("../../../src/journal/markdown");
    const act = React.act;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanups.push(() => act(() => root.unmount()));

    // A synchronous act flushes the render and its effects, which starts the load, but not the
    // load itself: the first paint has no highlighter.
    act(() => {
        root.render(
            React.createElement(markdown.MarkdownBody, {
                text: "```ts\nconst answer: number = 42;\n```",
                label: "test-message",
            }),
        );
    });
    const before = container.querySelector("code");
    expect(before?.textContent).toBe("const answer: number = 42;\n");
    expect(before?.querySelectorAll('[class^="hljs-"]').length).toBe(0);

    await act(async () => {
        await markdown.loadHighlighter();
    });
    const code = container.querySelector("code");
    expect(code?.textContent).toBe("const answer: number = 42;\n");
    expect(code?.classList.contains("hljs")).toBe(true);
    expect(code?.querySelectorAll('[class^="hljs-"]').length).toBeGreaterThan(0);
});

test("a message without a labelled fence never loads the highlighter", async () => {
    const factory = jest.fn(() => jest.requireActual("../../../src/journal/highlighter"));
    jest.doMock("../../../src/journal/highlighter", factory);
    const { act, render } = await freshModules();

    await render("Plain text with `inline code`.\n\n```\nuntyped fence\n```");
    await act(async () => {
        await Promise.resolve();
    });
    expect(factory).not.toHaveBeenCalled();
});

test("a streaming message does not load the highlighter", async () => {
    const factory = jest.fn(() => jest.requireActual("../../../src/journal/highlighter"));
    jest.doMock("../../../src/journal/highlighter", factory);
    const { act, render } = await freshModules();

    await render("```ts\nconst a = 1;\n```", true);
    await act(async () => {
        await Promise.resolve();
    });
    expect(factory).not.toHaveBeenCalled();
});

test.each([
    ["a block quote", "> ```ts\n> const a: number = 1;\n> ```"],
    ["a list item", "- ```ts\n  const a: number = 1;\n  ```"],
])("a labelled fence inside %s loads the highlighter and highlights", async (_where, text) => {
    const { markdown, act, render } = await freshModules();
    const container = await render(text);
    await act(async () => {
        await markdown.loadHighlighter();
    });
    const code = container.querySelector("code");
    expect(code?.classList.contains("hljs")).toBe(true);
    expect(code?.querySelectorAll('[class^="hljs-"]').length).toBeGreaterThan(0);
});

test("a nested labelled fence starts the load by itself", async () => {
    const factory = jest.fn(() => jest.requireActual("../../../src/journal/highlighter"));
    jest.doMock("../../../src/journal/highlighter", factory);
    const { act, render } = await freshModules();

    await render("> ```python\n> x = 1\n> ```");
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(factory).toHaveBeenCalledTimes(1);
});
