/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../client";
import { EditFileSheet } from "../components";
import { type EditFileOutcome } from "../edit-file";
import { type DeviceDTO } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const AGENT: DeviceDTO = { device_id: 7, kind: "agent", name: "box", connected: true, is_self: false };

function flush(): Promise<void> {
    return act(async () => {
        await Promise.resolve();
    });
}

async function mountSheet(client: MatronJournalClient): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(<EditFileSheet client={client} onClose={() => undefined} />);
    });
    await flush(); // let listAgents resolve -> form step
    return { container, root };
}

describe("EditFileSheet", () => {
    const mounted: Root[] = [];

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        await act(async () => {
            for (const root of mounted.splice(0)) root.unmount();
        });
        document.body.innerHTML = "";
        jest.restoreAllMocks();
    });

    function makeClient(editOutcome: EditFileOutcome): { client: MatronJournalClient; editFile: jest.Mock } {
        const client = new MatronJournalClient();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT]);
        const editFile = jest.fn().mockResolvedValue(editOutcome);
        (client as unknown as { editFile: unknown }).editFile = editFile;
        return { client, editFile };
    }

    it("calls editFile with the exact replace-mode input incl the compare-and-swap checksum", async () => {
        const sha = "b".repeat(64);
        const { client, editFile } = makeClient({ kind: "saved", path: "/box/app/.env", bytes: 20, mode: "replace" });
        const { container, root } = await mountSheet(client);
        mounted.push(root);

        const setValue = (id: string, value: string): void => {
            const el = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
            if (!el) throw new Error(`missing #${id}`);
            const proto =
                el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            setter?.call(el, value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
        };

        await act(async () => {
            setValue("mj-edit-file-path", "/box/app/.env");
            setValue("mj-edit-file-old", "PORT=3000");
            setValue("mj-edit-file-new", "PORT=4000");
            setValue("mj-edit-file-sha", sha);
        });

        const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save edit");
        await act(async () => {
            save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flush();

        expect(editFile).toHaveBeenCalledWith(7, {
            path: "/box/app/.env",
            edit: { mode: "replace", oldString: "PORT=3000", newString: "PORT=4000" },
            expectedSha256: sha,
        });
        expect(container.textContent).toContain("Saved 20 bytes");
    });

    it("renders a clear, non-crashing message when the file changed under us (stale CAS)", async () => {
        const { client } = makeClient({ kind: "stale" });
        const { container, root } = await mountSheet(client);
        mounted.push(root);

        const setValue = (id: string, value: string): void => {
            const el = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
            const proto =
                el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
            el?.dispatchEvent(new Event("input", { bubbles: true }));
        };
        await act(async () => {
            setValue("mj-edit-file-path", "/box/app/.env");
            setValue("mj-edit-file-old", "a");
            setValue("mj-edit-file-new", "b");
        });
        const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save edit");
        await act(async () => {
            save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flush();

        expect(container.textContent).toContain("changed on the box");
        // The form is still mounted so the user's edit is preserved for retry.
        expect(container.querySelector("#mj-edit-file-old")).not.toBeNull();
    });

    it("surfaces a path rejection message from the RPC without crashing", async () => {
        const { client } = makeClient({ kind: "path-rejected", reason: "outside-scope" });
        const { container, root } = await mountSheet(client);
        mounted.push(root);

        const setValue = (id: string, value: string): void => {
            const el = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
            const proto =
                el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
            el?.dispatchEvent(new Event("input", { bubbles: true }));
        };
        await act(async () => {
            setValue("mj-edit-file-path", "/etc/passwd");
            setValue("mj-edit-file-old", "x");
        });
        const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save edit");
        await act(async () => {
            save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flush();

        expect(container.textContent).toContain("outside the folders");
    });

    it("blocks submit with a validation message when the checksum is malformed", async () => {
        const { client, editFile } = makeClient({ kind: "saved", path: "/p", bytes: 1, mode: "content" });
        const { container, root } = await mountSheet(client);
        mounted.push(root);

        const setValue = (id: string, value: string): void => {
            const el = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
            const proto =
                el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
            el?.dispatchEvent(new Event("input", { bubbles: true }));
        };
        await act(async () => {
            setValue("mj-edit-file-path", "/box/app/.env");
            setValue("mj-edit-file-old", "a");
            setValue("mj-edit-file-sha", "not-hex");
        });
        const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save edit");
        await act(async () => {
            save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flush();

        expect(editFile).not.toHaveBeenCalled();
        expect(container.textContent).toContain("64-character hex");
    });
});
