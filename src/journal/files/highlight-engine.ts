/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The highlight.js engine behind the Files pane's CodePreview (loaded on first use by ./highlight) — reuses the EXISTING highlight.js
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

export function highlightWithHljs(
    language: string | undefined,
    code: string,
): { html: string; language?: string } {
    ensureRegistered();
    if (language && hljs.getLanguage(language)) {
        return { html: hljs.highlight(code, { language, ignoreIllegals: true }).value, language };
    }
    const auto = hljs.highlightAuto(code);
    return { html: auto.value, language: auto.language };
}
