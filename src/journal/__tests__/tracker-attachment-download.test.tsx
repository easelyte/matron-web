/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import { MediaViewerContext } from "../media-viewer";
import { AttachmentChip, buildTrackerMediaCorpus } from "../tracker/ItemAttachments";
import { trackerItem } from "./tracker-fixtures";
import type { TrackerAttachment } from "../types";

const pdf: TrackerAttachment = { blob_ref: "pp44", mime: "application/pdf", name: "Cover proof.pdf", size: 577_000 };

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
        root = createRoot(container!);
        root.render(element);
    });
    return container;
}

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    document.body.innerHTML = "";
    jest.restoreAllMocks();
});

describe("AttachmentChip download", () => {
    it("downloads a file under its own name through the media cache, fetching only on click", async () => {
        const mediaUrl = jest.fn((id: string) => Promise.resolve(`blob:test/${id}`));
        const clicked: { href: string; download: string }[] = [];
        jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            clicked.push({ href: this.href, download: this.download });
        });
        const view = await mount(
            <AttachmentChip client={{ mediaUrl } as unknown as MatronJournalClient} attachment={pdf} />,
        );
        const chip = view.querySelector<HTMLButtonElement>("button.mj_TrackerAttachmentChip_download")!;
        expect(chip.getAttribute("aria-label")).toBe("Download Cover proof.pdf");
        expect(mediaUrl).not.toHaveBeenCalled();

        await act(async () => chip.click());

        expect(mediaUrl).toHaveBeenCalledWith("pp44");
        expect(clicked).toEqual([{ href: "blob:test/pp44", download: "Cover proof.pdf" }]);
        // The transient link does not stay in the page.
        expect(document.querySelector("a[download]")).toBeNull();
    });

    it("says so when the download fails, and can be tried again", async () => {
        const mediaUrl = jest.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValue("blob:test/pp44");
        jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
        const view = await mount(
            <AttachmentChip client={{ mediaUrl } as unknown as MatronJournalClient} attachment={pdf} />,
        );
        const chip = view.querySelector<HTMLButtonElement>("button.mj_TrackerAttachmentChip_download")!;
        await act(async () => chip.click());
        expect(chip.textContent).toContain("Couldn't download, try again");
        await act(async () => chip.click());
        expect(mediaUrl).toHaveBeenCalledTimes(2);
        expect(chip.textContent).not.toContain("Couldn't download");
    });

    it("stays a plain name chip without a client", async () => {
        const view = await mount(<AttachmentChip attachment={pdf} />);
        expect(view.querySelector("button")).toBeNull();
        expect(view.querySelector(".mj_TrackerAttachmentChip")?.textContent).toContain("Cover proof.pdf");
    });
});

it.each([
    ["application/pdf", "proof.pdf"],
    ["video/mp4", "clip.mp4"],
    ["audio/mpeg", "voice.mp3"],
    ["application/octet-stream", "diagram.svg"],
])("previews renderable tracker attachments (%s) through MediaViewer", async (mime, name) => {
    const attachment = { ...pdf, mime, name };
    const openViewer = jest.fn();
    const mediaUrl = jest.fn();
    const view = await mount(
        <MediaViewerContext.Provider value={{ openViewer }}>
            <AttachmentChip client={{ mediaUrl } as unknown as MatronJournalClient} attachment={attachment} />
        </MediaViewerContext.Provider>,
    );
    const button = view.querySelector<HTMLButtonElement>("button")!;
    await act(async () => button.click());
    expect(openViewer).toHaveBeenCalledWith(attachment.blob_ref, button);
    expect(mediaUrl).not.toHaveBeenCalled();
    expect(
        buildTrackerMediaCorpus(trackerItem({ attachments: [attachment] }), []).map((entry) => entry.mediaId),
    ).toEqual([attachment.blob_ref]);
});
