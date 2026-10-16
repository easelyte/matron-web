/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { readFileSync } from "node:fs";

// Matron Desktop injects macOS title-bar CSS (`-webkit-app-region`) that selects these classes.
// Renaming one silently stops the window dragging from there: change matron-desktop's
// src/macos-titlebar.ts in step, then update this list.
const DESKTOP_TITLE_BAR_CLASSES = ["mj_ChatHeader", "mj_ConversationListHeader", "mj_Login", "mj_Login_column"];

describe("classes Matron Desktop relies on", () => {
    const components = readFileSync("src/journal/components.tsx", "utf8");

    it.each(DESKTOP_TITLE_BAR_CLASSES)("still renders %s", (name) => {
        expect(components).toMatch(new RegExp(`className=\\{?["\`][^"\`]*\\b${name}(?![\\w-])`));
    });
});
