/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// The code-block highlighter and its curated grammars. markdown.tsx loads this module with a
// dynamic import the first time a message needs it, so highlight.js stays out of the first
// download.

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
import { createLowlight } from "lowlight";

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

export const lowlight = createLowlight(CURATED);
lowlight.registerAlias(ALIASES);

export type Highlighter = typeof lowlight;
