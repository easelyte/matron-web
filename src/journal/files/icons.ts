/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// FileKind → icon component, reusing the app's file-affordance icon set (icons.tsx). Parallels the
// module-scoped FILE_KIND_ICON in components.tsx but lives in files/ so the pane never imports the
// 297 KB components.tsx (avoids a circular import). Icons themselves are the shared, canonical ones.

import type React from "react";

import {
    ArchiveFileIcon,
    AudioFileIcon,
    FileIcon,
    ImageFileIcon,
    PdfFileIcon,
    TextFileIcon,
    VideoFileIcon,
} from "../icons";
import type { FileKind } from "../types";

type IconComponent = (props: React.SVGProps<SVGSVGElement>) => React.ReactElement;

const KIND_ICON: Record<FileKind, IconComponent> = {
    image: ImageFileIcon,
    pdf: PdfFileIcon,
    text: TextFileIcon,
    audio: AudioFileIcon,
    video: VideoFileIcon,
    archive: ArchiveFileIcon,
    generic: FileIcon,
};

export function fileKindIcon(kind: FileKind): IconComponent {
    return KIND_ICON[kind];
}
