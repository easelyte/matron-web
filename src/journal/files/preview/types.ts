/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import type { FileMeta, FilesApiLike } from "../filesApi";

/** Common props every preview renderer receives once the dispatcher has loaded the file's meta. */
export interface RendererProps {
    api: FilesApiLike;
    /** Absolute path of the file being previewed. */
    path: string;
    /** Display name (basename) — used for language detection, download filename, labels. */
    filename: string;
    meta: FileMeta;
}
