/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MatronJournalClient } from "../client";
import { ItemDetail } from "../tracker/ItemDetail";
import type { TrackerAttachment } from "../types";
import { fakeSeen, type FakeSeen, trackerComment, trackerItem } from "./tracker-fixtures";

function fakeClient(): { seen: FakeSeen; mediaUrl: jest.Mock; openTrackerLink: jest.Mock; getSnapshot: jest.Mock } {
    return {
        seen: fakeSeen(),
        mediaUrl: jest.fn((id: string) => Promise.resolve(`blob:test/${id}`)),
        openTrackerLink: jest.fn(),
        getSnapshot: jest.fn().mockReturnValue({ selectedConversationId: "c1", conversations: [] }),
    };
}

const shot: TrackerAttachment = {
    blob_ref: "aa11",
    mime: "image/png",
    name: "login.png",
    size: 2048,
    width: 800,
    height: 400,
};
const extra: TrackerAttachment = { blob_ref: "bb22", mime: "image/jpeg", name: "extra.jpg", size: 4096 };
const log: TrackerAttachment = { blob_ref: "cc33", mime: "text/plain", name: "build.log", size: 512 };

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

afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    document.body.innerHTML = "";
});

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("ItemDetail inline images", () => {
    it("places a body image where the body refers to it, then the unused attachments", async () => {
        const client = fakeClient();
        const view = await mount(
            <ItemDetail
                item={trackerItem({
                    body: "Before\n\n![The login page](attachment:aa11)\n\nAfter",
                    attachments: [shot, extra, log],
                })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        const body = view.querySelector(".mj_TrackerItemBody")!;
        const children = Array.from(body.children).map((node) => node.tagName.toLowerCase());
        expect(children).toEqual(["p", "figure", "p"]);
        expect(body.textContent).not.toContain("attachment:");

        const inline = body.querySelector<HTMLImageElement>("figure img")!;
        expect(inline.getAttribute("src")).toBe("blob:test/aa11");
        expect(inline.alt).toBe("The login page");
        expect(body.querySelector("figcaption")?.textContent).toBe("The login page");
        // Sized from the attachment's dimensions before it decodes.
        expect(body.querySelector<HTMLElement>(".mj_ImageFrame_sized")!.style.aspectRatio).toBe("800 / 400");

        // The leftovers trail the body: the image as a thumbnail, the log as its chip.
        const trailing = view.querySelector(".mj_TrackerItemBody + .mj_TrackerAttachments")!;
        expect(trailing.querySelector<HTMLImageElement>(".mj_TrackerThumb img")!.getAttribute("src")).toBe(
            "blob:test/bb22",
        );
        expect(trailing.querySelector(".mj_TrackerAttachmentChip")?.textContent).toContain("build.log");
        expect(client.mediaUrl).not.toHaveBeenCalledWith("cc33");
    });

    it("shows the item's body attachments when the body is empty", async () => {
        const client = fakeClient();
        const view = await mount(
            <ItemDetail
                item={trackerItem({ body: "", attachments: [shot, log] })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );
        expect(view.querySelectorAll(".mj_TrackerThumb img")).toHaveLength(1);
        expect(view.querySelector(".mj_TrackerAttachmentChip")?.textContent).toContain("build.log");
    });

    it("renders an unresolved ref as its caption and never fetches it", async () => {
        const client = fakeClient();
        const view = await mount(
            <ItemDetail
                item={trackerItem({ body: "See ![the chart](attachment:zz99) here", attachments: [] })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );
        expect(view.querySelector(".mj_TrackerItemBody")?.textContent).toBe("See the chart here");
        expect(client.mediaUrl).not.toHaveBeenCalled();
    });

    it("places a comment's own image inline and resolves refs only against that comment", async () => {
        const client = fakeClient();
        const view = await mount(
            <ItemDetail
                item={trackerItem({ attachments: [extra] })}
                comments={[
                    trackerComment({
                        id: "k1",
                        body: "Here: ![shot](attachment:aa11) and ![not mine](attachment:bb22)",
                        attachments: [shot],
                    }),
                ]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );
        const card = view.querySelector(".mj_TrackerComment")!;
        expect(card.querySelector<HTMLImageElement>("figure img")!.getAttribute("src")).toBe("blob:test/aa11");
        expect(card.textContent).toContain("and not mine");
        expect(card.querySelectorAll("img")).toHaveLength(1);
    });

    it("opens the lightbox at the clicked image", async () => {
        const client = fakeClient();
        const view = await mount(
            <ItemDetail
                item={trackerItem({ body: "![one](attachment:aa11)", attachments: [shot, extra] })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );
        await act(async () => {
            view.querySelector<HTMLElement>(".mj_TrackerThumb")!.click();
        });
        const dialog = document.body.querySelector(".mj_MediaViewer_scrim")!;
        expect(dialog).not.toBeNull();
        expect(dialog.querySelector(".mj_MediaViewer_count")?.textContent).toBe("2 / 2");
        expect(dialog.querySelector(".mj_MediaViewer_name")?.textContent).toBe("extra.jpg");

        await act(async () => {
            dialog.querySelector<HTMLButtonElement>(".mj_MediaViewer_close")!.click();
        });
        expect(document.body.querySelector(".mj_MediaViewer_scrim")).toBeNull();
    });

    it("captions each image with its name and size, the name split so the extension stays", async () => {
        const client = fakeClient();
        const long: TrackerAttachment = {
            blob_ref: "dd44",
            mime: "image/png",
            name: "divider_4867x3071.png",
            size: 40_789_000,
        };
        const view = await mount(
            <ItemDetail
                item={trackerItem({ body: "![The login page](attachment:aa11)", attachments: [shot, long] })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );

        const inline = view.querySelector(".mj_TrackerImage .mj_TrackerImageName")!;
        expect(inline.textContent).toBe("login.png · 2 KB");
        expect(inline.getAttribute("title")).toBe("login.png · 2 KB");

        const thumb = view.querySelector(".mj_TrackerThumbTile .mj_TrackerImageName")!;
        expect(thumb.classList).toContain("mj_TrackerImageName_stacked");
        expect(thumb.querySelector(".mj_TrackerImageName_head")?.textContent).toBe("divider_4867x");
        expect(thumb.querySelector(".mj_TrackerImageName_tail")?.textContent).toBe("3071.png");
        expect(thumb.querySelector(".mj_TrackerImageName_size")?.textContent).toBe("38.9 MB");
        expect(thumb.getAttribute("title")).toBe("divider_4867x3071.png · 38.9 MB");
    });

    it("captions an unnamed image with its size alone", async () => {
        const client = fakeClient();
        const view = await mount(
            <ItemDetail
                item={trackerItem({ body: "", attachments: [{ ...extra, name: "" }] })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );
        expect(view.querySelector(".mj_TrackerImageName")?.textContent).toBe("4 KB");
    });

    it("leaves out a missing size rather than showing 0 B", async () => {
        const client = fakeClient();
        const view = await mount(
            <ItemDetail
                item={trackerItem({ body: "", attachments: [{ ...extra, size: 0 }] })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );
        const line = view.querySelector(".mj_TrackerImageName")!;
        expect(line.textContent).toBe("extra.jpg");
        expect(line.getAttribute("title")).toBe("extra.jpg");
    });

    it("falls back to the chip when an image fails to load", async () => {
        const client = fakeClient();
        client.mediaUrl.mockRejectedValue(new Error("nope"));
        const view = await mount(
            <ItemDetail
                item={trackerItem({ body: "![one](attachment:aa11)", attachments: [shot] })}
                comments={[]}
                client={client as unknown as MatronJournalClient}
                onBack={jest.fn()}
            />,
        );
        expect(view.querySelector(".mj_TrackerImage_failed")?.textContent).toContain("login.png");
    });
});
