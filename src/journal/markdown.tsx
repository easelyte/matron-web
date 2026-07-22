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
import React, { memo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

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

function CodeBlock({ node: _node, ...props }: ComponentPropsWithoutRef<"pre"> & ExtraProps): React.ReactElement {
    return <pre {...props} />;
}

const COMPONENTS: Components = {
    pre: CodeBlock,
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

function MarkdownBodyComponent({ text, streaming = false, label: _label }: MarkdownBodyProps): React.ReactElement {
    if (text.length > MARKDOWN_MAX) {
        return <div className="mj_MessageText mj_MarkdownRaw">{text}</div>;
    }

    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={streaming ? [] : [[rehypeHighlight, HIGHLIGHT_OPTIONS]]}
            components={COMPONENTS}
        >
            {text}
        </ReactMarkdown>
    );
}

export const MarkdownBody = memo(
    MarkdownBodyComponent,
    (previous, next) =>
        previous.text === next.text && previous.streaming === next.streaming && previous.label === next.label,
);
