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
    const [copyLabel, setCopyLabel] = useState("Copy");
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
        setCopyLabel(copied ? "Copied" : "Copy failed");
        clearCopyTimer();
        timerRef.current = setTimeout(() => {
            setCopyLabel("Copy");
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
    let newlineCount = 0;
    for (let index = 0; index < text.length && newlineCount < MARKDOWN_MAX_LINES; index += 1) {
        if (text.charCodeAt(index) === 10) newlineCount += 1;
    }

    if (text.length > MARKDOWN_MAX || newlineCount >= MARKDOWN_MAX_LINES) {
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
