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

const HIGHLIGHT_OPTIONS = { languages: CURATED, aliases: ALIASES, detect: true };

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

function CodeBlock({ node, source, children, ...props }: CodeBlockProps): React.ReactElement {
    const raw = node ? toString(node) : "";
    const language = fenceLanguage(node, source);
    const [copyLabel, setCopyLabel] = useState("Copy");
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const mountedRef = useRef(true);

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
        clearCopyTimer();
        const copied = await copyText(raw);
        if (!mountedRef.current) return;
        setCopyLabel(copied ? "Copied" : "Copy failed");
        clearCopyTimer();
        timerRef.current = setTimeout(() => {
            setCopyLabel("Copy");
            timerRef.current = undefined;
        }, 1_500);
    }

    return (
        <pre {...props} className="mj_CodeBlock">
            {language ? <span className="mj_CodeBlock_lang">{language}</span> : null}
            {children}
            <button className="mj_CodeBlock_copy" type="button" aria-label="Copy code" onClick={handleCopy}>
                {copyLabel}
            </button>
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
            const external = href !== undefined && /^(?:https?:|mailto:)/i.test(href);
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
    if (text.length > MARKDOWN_MAX) {
        return <div className="mj_MessageText mj_MarkdownRaw">{text}</div>;
    }

    return (
        <MarkdownErrorBoundary text={text} streaming={streaming} label={label}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={streaming ? [] : [[rehypeHighlight, HIGHLIGHT_OPTIONS]]}
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
