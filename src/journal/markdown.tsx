/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { toString } from "hast-util-to-string";
import React, {
    Component,
    memo,
    useEffect,
    useRef,
    useState,
    type ComponentPropsWithoutRef,
    type ReactNode,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { copyText } from "./clipboard";

export const MARKDOWN_MAX = 200_000;
export const MARKDOWN_MAX_LINES = 2_000;
export const HIGHLIGHT_MAX = 30_000;

const CURATED = {
    bash,
    javascript,
    typescript,
    python,
    json,
    diff,
    yaml,
    css,
    xml,
    go,
    rust,
    sql,
    markdown,
};

const ALIASES = {
    typescript: ["ts", "tsx"],
    javascript: ["js", "jsx"],
    bash: ["sh"],
    yaml: ["yml"],
    python: ["py"],
    markdown: ["md"],
};

const HIGHLIGHT_OPTIONS = { languages: CURATED, aliases: ALIASES };

/**
 * Shared resource guard: above this size/line budget the parser is skipped and the raw text
 * is shown/copied instead. Both MarkdownBody (render) and markdownToPlainText (Copy) gate on
 * this so a ~220KB / 20k-node message never parses on the main thread (~5.6s / 305MB → wedge).
 */
export function exceedsMarkdownRenderLimit(text: string): boolean {
    if (text.length > MARKDOWN_MAX) return true;
    // Count logical line endings — CR, LF, and CRLF each as ONE (CRLF matches once, not twice).
    // Counting only LF let a CR-only / CRLF payload slip past the line budget and still parse
    // to tens of thousands of nodes → a multi-second main-thread wedge in render AND Copy.
    const lineEndings = text.match(/\r\n|\r|\n/g)?.length ?? 0;
    return lineEndings >= MARKDOWN_MAX_LINES;
}

// Parse markdown SOURCE to an mdast tree with the SAME GFM extensions MarkdownBody renders
// from, so the plain-text extraction agrees with what the operator sees. A regex stripper is
// wrong here: it deletes paired intraword underscores (AWS_ACCESS_KEY_ID, foo_bar_baz) that
// CommonMark never treats as emphasis, silently corrupting identifiers/paths/config on paste.
const plainTextProcessor = unified().use(remarkParse).use(remarkGfm);

interface MdastNode {
    type: string;
    value?: string;
    alt?: string | null;
    // GFM task-list state lives here, NOT in the child text: true = [x], false = [ ], null/
    // undefined = an ordinary (non-task) list item.
    checked?: boolean | null;
    children?: MdastNode[];
}

// Node types whose children are joined WITHOUT a separator (inline runs + block wrappers
// whose own line break is provided by their block parent).
const INLINE_MDAST_TYPES = new Set([
    "paragraph",
    "heading",
    "emphasis",
    "strong",
    "delete",
    "link",
    "linkReference",
    "tableCell",
    "footnote",
    "footnoteReference",
]);

function mdastToText(node: MdastNode): string {
    switch (node.type) {
        // Literal nodes carry verbatim text — including intraword underscores, escaped
        // punctuation (already unescaped by the parser: `\*` → "*"), inline code, and the full
        // body of a fenced/indented code block.
        case "text":
        case "inlineCode":
        case "code":
        case "html":
            return node.value ?? "";
        case "image":
        case "imageReference":
            return node.alt ?? "";
        case "break":
            return "\n";
        case "thematicBreak":
            return "";
        default:
            break;
    }
    const children = node.children ?? [];
    if (node.type === "table") {
        // Rows on their own lines; cells tab-separated.
        return children.map(mdastToText).join("\n");
    }
    if (node.type === "tableRow") {
        return children.map(mdastToText).join("\t");
    }
    if (INLINE_MDAST_TYPES.has(node.type)) {
        return children.map(mdastToText).join("");
    }
    // Block container (root, list, listItem, blockquote, footnoteDefinition, …): its block
    // children are separated by a blank line.
    const body = children
        .map(mdastToText)
        .filter((part) => part.length > 0)
        .join("\n\n");
    // GFM task-list item: preserve the checkbox marker (state is on listItem.checked, never in
    // the child text) so pasted checklists keep done/todo distinct.
    if (node.type === "listItem" && node.checked != null) {
        return `${node.checked ? "[x]" : "[ ]"} ${body}`;
    }
    return body;
}

/**
 * Reduce markdown SOURCE to readable plain text for the "Copy" menu action ("Copy as
 * Markdown" keeps the raw body). Walks the parsed mdast and concatenates its text, so
 * technical identifiers with intraword underscores, escaped punctuation, inline code, and
 * fenced-code content survive exactly as rendered.
 */
export function markdownToPlainText(source: string): string {
    // Above the render budget, MarkdownBody shows the raw text unparsed — Copy agrees with it
    // and skips the parse entirely, so a huge message never wedges the main thread.
    if (exceedsMarkdownRenderLimit(source)) return source;
    const tree = plainTextProcessor.parse(source) as unknown as MdastNode;
    return mdastToText(tree)
        .replace(/[^\S\n]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

interface HighlightNode {
    type: string;
    tagName?: string;
    value?: string;
    properties?: Record<string, unknown>;
    children?: HighlightNode[];
}

function exceedsHighlightMax(node: HighlightNode): boolean {
    let length = 0;
    const pending = [node];
    while (pending.length > 0) {
        const current = pending.pop()!;
        if (current.type === "text") {
            length += current.value?.length ?? 0;
            if (length > HIGHLIGHT_MAX) return true;
        } else if (current.children) {
            pending.push(...current.children);
        }
    }
    return false;
}

function capCodeBlockHighlighting() {
    return (tree: HighlightNode): void => {
        const pending = [tree];
        while (pending.length > 0) {
            const current = pending.pop()!;
            if (current.tagName === "pre") {
                for (const child of current.children ?? []) {
                    if (child.tagName !== "code" || !exceedsHighlightMax(child)) continue;
                    child.properties ??= {};
                    const className = child.properties.className;
                    const classes = Array.isArray(className) ? className : [];
                    if (!classes.includes("no-highlight")) classes.push("no-highlight");
                    child.properties.className = classes;
                }
            }
            if (current.children) pending.push(...current.children);
        }
    };
}

interface MarkdownBodyProps {
    text: string;
    streaming?: boolean;
    label: string;
}

interface CodeBlockProps extends ComponentPropsWithoutRef<"pre">, ExtraProps {
    source: string;
}

function fenceLanguage(node: ExtraProps["node"], source: string): string | undefined {
    const offset = node?.position?.start.offset;
    if (offset === undefined) return undefined;
    const openingLine = source.slice(offset).split(/\r?\n/, 1)[0] ?? "";
    const match = /^ {0,3}(?:`{3,}|~{3,})\s*([^\s`~]+)/.exec(openingLine);
    return match?.[1]?.slice(0, 16);
}

function fencedCodeSource(node: ExtraProps["node"], source: string): string | undefined {
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    if (start === undefined || end === undefined) return undefined;

    const fencedSource = source.slice(start, end);
    const opening = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r|$)/.exec(fencedSource);
    if (!opening) return undefined;

    const body = fencedSource.slice(opening[0].length);
    const bodyWithoutTerminalEol = body.replace(/(?:\r\n|\n|\r)$/, "");
    const closingLineStart =
        Math.max(bodyWithoutTerminalEol.lastIndexOf("\n"), bodyWithoutTerminalEol.lastIndexOf("\r")) + 1;
    const closingLine = bodyWithoutTerminalEol.slice(closingLineStart);
    const marker = opening[1][0];
    const closing = new RegExp(`^ {0,3}\\${marker}{${opening[1].length},}[\\t ]*$`);

    return closing.test(closingLine) ? body.slice(0, closingLineStart) : body;
}

function CodeBlock({ node, source, children, ...props }: CodeBlockProps): React.ReactElement {
    const raw = fencedCodeSource(node, source) ?? (node ? toString(node) : "");
    const language = fenceLanguage(node, source);
    const [copyLabel, setCopyLabel] = useState("copy");
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const mountedRef = useRef(true);
    const copyOperationRef = useRef(0);

    function clearCopyTimer(): void {
        if (timerRef.current === undefined) return;
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
    }

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            clearCopyTimer();
        };
    }, []);

    async function handleCopy(): Promise<void> {
        const operation = ++copyOperationRef.current;
        clearCopyTimer();
        const copied = await copyText(raw);
        if (!mountedRef.current || operation !== copyOperationRef.current) return;
        setCopyLabel(copied ? "copied" : "copy failed");
        clearCopyTimer();
        timerRef.current = setTimeout(() => {
            setCopyLabel("copy");
            timerRef.current = undefined;
        }, 1_500);
    }

    return (
        <pre {...props} className="mj_CodeBlock">
            <span className="mj_CodeBlock_header">
                {language ? <span className="mj_CodeBlock_lang">{language}</span> : null}
                <button className="mj_CodeBlock_copy" type="button" aria-label="Copy code" onClick={handleCopy}>
                    {copyLabel}
                </button>
            </span>
            {children}
        </pre>
    );
}

function componentsFor(source: string): Components {
    return {
        pre(props) {
            return <CodeBlock {...props} source={source} />;
        },
        code({ node: _node, className, children }) {
            const isBlock = className?.split(/\s+/).some((name) => name === "hljs" || name.startsWith("language-"));
            return isBlock ? (
                <code className={className}>{children}</code>
            ) : (
                <code className="mj_InlineCode">{children}</code>
            );
        },
        a({ node: _node, href, children, ...props }) {
            const external = href !== undefined && /^(?:https?:|mailto:|\/\/)/i.test(href);
            return (
                <a
                    {...props}
                    {...(href ? { href } : {})}
                    {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}
                >
                    {children}
                </a>
            );
        },
        img({ node: _node, src, alt }) {
            return (
                <a href={src} target="_blank" rel="noopener noreferrer nofollow">
                    {alt || src}
                </a>
            );
        },
    };
}

interface MarkdownErrorBoundaryProps extends MarkdownBodyProps {
    children: ReactNode;
}

interface MarkdownErrorBoundaryState {
    hasError: boolean;
}

class MarkdownErrorBoundary extends Component<MarkdownErrorBoundaryProps, MarkdownErrorBoundaryState> {
    public state: MarkdownErrorBoundaryState = { hasError: false };

    public static getDerivedStateFromError(): MarkdownErrorBoundaryState {
        return { hasError: true };
    }

    public componentDidCatch(err: Error): void {
        console.error("[markdown] render failed", { label: this.props.label, err });
    }

    public componentDidUpdate(previous: MarkdownErrorBoundaryProps): void {
        if (this.state.hasError && previous.text !== this.props.text) {
            this.setState({ hasError: false });
        }
    }

    public render(): ReactNode {
        if (this.state.hasError) {
            return (
                <div className="mj_MessageText mj_MarkdownRaw" title="markdown render failed — showing raw text">
                    {this.props.text}
                </div>
            );
        }
        return this.props.children;
    }
}

function MarkdownBodyComponent({ text, streaming = false, label }: MarkdownBodyProps): React.ReactElement {
    if (exceedsMarkdownRenderLimit(text)) {
        return <div className="mj_MessageText mj_MarkdownRaw">{text}</div>;
    }

    return (
        <MarkdownErrorBoundary text={text} streaming={streaming} label={label}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={streaming ? [] : [capCodeBlockHighlighting, [rehypeHighlight, HIGHLIGHT_OPTIONS]]}
                components={componentsFor(text)}
            >
                {text}
            </ReactMarkdown>
        </MarkdownErrorBoundary>
    );
}

export const MarkdownBody = memo(
    MarkdownBodyComponent,
    (previous, next) =>
        previous.text === next.text && previous.streaming === next.streaming && previous.label === next.label,
);
