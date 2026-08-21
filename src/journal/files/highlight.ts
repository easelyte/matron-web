/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Standalone code highlighter for the Files pane's CodePreview — reuses the EXISTING highlight.js
 * dependency and the SAME curated language subset the message renderer uses (markdown.tsx), so a
 * highlighted file looks identical to a highlighted fenced block. Emits `hljs-*` classes that
 * journal.pcss themes for both light and dark; no new stylesheet.
 *
 * We highlight the raw file directly instead of wrapping it in a markdown fence: a file whose
 * bytes contain a ``` fence would break out of the wrapper and mis-render. Direct highlight also
 * lets us pick the language from the file extension deterministically.
 */

import hljs from "highlight.js/lib/core";
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

import { extensionOf } from "./format";

// Above this size, syntax highlighting is skipped (plain escaped text) — mirrors markdown.tsx's
// per-block guard so a large file never wedges the main thread tokenising.
export const CODE_HIGHLIGHT_MAX = 120_000;
// Above this the file is not rendered inline at all (download instead) — a multi-MB text file in
// a <pre> wedges layout even without highlighting. The server also caps inline reads at 5 MB.
export const CODE_RENDER_MAX = 512_000;

let registered = false;

function ensureRegistered(): void {
    if (registered) return;
    hljs.registerLanguage("bash", bash);
    hljs.registerLanguage("css", css);
    hljs.registerLanguage("diff", diff);
    hljs.registerLanguage("go", go);
    hljs.registerLanguage("javascript", javascript);
    hljs.registerLanguage("json", json);
    hljs.registerLanguage("markdown", markdown);
    hljs.registerLanguage("python", python);
    hljs.registerLanguage("rust", rust);
    hljs.registerLanguage("sql", sql);
    hljs.registerLanguage("typescript", typescript);
    hljs.registerLanguage("xml", xml);
    hljs.registerLanguage("yaml", yaml);
    registered = true;
}

// Extension → curated hljs language. Only languages in the curated set above; everything else
// falls through to highlightAuto (which scans the registered subset), then to plain escaped text.
const EXT_LANGUAGE: Record<string, string> = {
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    json: "json",
    diff: "diff",
    patch: "diff",
    yaml: "yaml",
    yml: "yaml",
    css: "css",
    pcss: "css",
    scss: "css",
    html: "xml",
    xml: "xml",
    svg: "xml",
    go: "go",
    rs: "rust",
    sql: "sql",
    md: "markdown",
    markdown: "markdown",
};

export function languageForFilename(name: string): string | undefined {
    return EXT_LANGUAGE[extensionOf(name)];
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface HighlightResult {
    /** HTML with hljs spans (or escaped plain text when highlighting is skipped/failed). */
    html: string;
    /** The language actually used, or undefined when rendered as plain text. */
    language?: string;
    /** True when highlighting was skipped due to size (CODE_HIGHLIGHT_MAX). */
    skipped: boolean;
}

/**
 * Highlight a whole file. Deterministic language from the extension when known; else highlightAuto
 * over the curated subset; else plain escaped text. Never throws — a tokeniser failure degrades to
 * escaped text so the viewer always renders.
 */
export function highlightFile(filename: string, code: string): HighlightResult {
    if (code.length > CODE_HIGHLIGHT_MAX) {
        return { html: escapeHtml(code), skipped: true };
    }
    ensureRegistered();
    const language = languageForFilename(filename);
    try {
        if (language && hljs.getLanguage(language)) {
            return { html: hljs.highlight(code, { language, ignoreIllegals: true }).value, language, skipped: false };
        }
        const auto = hljs.highlightAuto(code);
        return { html: auto.value, language: auto.language, skipped: false };
    } catch {
        return { html: escapeHtml(code), skipped: false };
    }
}
