/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/** What a browser calls any image that reaches a paste as bytes rather than as a file. */
const BROWSER_IMAGE_NAME = /^image\.png$/i;
const IMAGE_ADDRESS_NAME = /^(.+)\.(apng|avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i;
const MAX_NAME_LENGTH = 200;

/**
 * The files of a paste, named for the agent that receives them. A copied file
 * keeps its own name. An image the browser calls `image.png` takes its name
 * from the address in the copied markup when there is one; a screenshot has
 * no name at all, so it is named for what it is and when it was pasted.
 */
export function namedPastedFiles(
    clipboard: { files: Iterable<File> | ArrayLike<File>; getData?: (format: string) => string },
    now: Date = new Date(),
): File[] {
    const files = Array.from(clipboard.files);
    return files.map((file) => {
        if (file.name && !BROWSER_IMAGE_NAME.test(file.name)) return file;
        // One pasted image: with several, nothing says which address is whose.
        const carried = files.length === 1 ? nameFromCopiedMarkup(clipboard.getData?.("text/html")) : null;
        const fromType = file.type.split("/")[1]?.split("+")[0] ?? "";
        const extension = fromType || file.name.split(".").pop() || "";
        const kind = file.type.startsWith("image/") ? "pasted-image" : "pasted-file";
        const stem = carried ?? `${kind}-${timestamp(now)}`;
        const name = extension ? `${stem}.${extension}` : stem;
        return new File([file], name, { type: file.type, lastModified: file.lastModified });
    });
}

/** The name, without its extension, of the only image in copied markup. */
function nameFromCopiedMarkup(html: string | undefined): string | null {
    if (!html) return null;
    const images = new DOMParser().parseFromString(html, "text/html").querySelectorAll("img");
    // Several images: nothing says which of them the pasted bytes are.
    const source = images.length === 1 ? images[0].getAttribute("src") : null;
    if (!source) return null;
    let last: string;
    try {
        const url = new URL(source);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        last = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    } catch {
        return null;
    }
    const stem = IMAGE_ADDRESS_NAME.exec(last)?.[1];
    if (!stem) return null;
    const clean = stem
        .split(/[/\\]/)
        .pop()!
        .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ")
        .trim()
        .slice(0, MAX_NAME_LENGTH);
    return clean.replace(/\.+/g, "") ? clean : null;
}

function timestamp(date: Date): string {
    const two = (value: number): string => String(value).padStart(2, "0");
    const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
    return `${day}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}
