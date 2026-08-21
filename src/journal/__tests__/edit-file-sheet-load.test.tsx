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
import { type ReadFileOutcome } from "../read-file";
import { type DeviceDTO } from "../types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const AGENT: DeviceDTO = { device_id: 7, kind: "agent", name: "box", connected: true, is_self: false };
const SHA = "a".repeat(64);

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

function setValue(container: HTMLElement, id: string, value: string): void {
    const el = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    if (!el) throw new Error(`missing #${id}`);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickButton(container: HTMLElement, label: string): void {
    const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.startsWith(label));
    if (!btn) throw new Error(`missing button "${label}"`);
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("EditFileSheet — load-then-edit (read_file)", () => {
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

    function makeClient(
        readOutcome: ReadFileOutcome,
        editOutcome: EditFileOutcome = { kind: "saved", path: "/box/app/config.ts", bytes: 12, mode: "content" },
    ): { client: MatronJournalClient; readFile: jest.Mock; editFile: jest.Mock } {
        const client = new MatronJournalClient();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT]);
        const readFile = jest.fn().mockResolvedValue(readOutcome);
        const editFile = jest.fn().mockResolvedValue(editOutcome);
        (client as unknown as { readFile: unknown }).readFile = readFile;
        (client as unknown as { editFile: unknown }).editFile = editFile;
        return { client, readFile, editFile };
    }

    it("Load calls readFile with the untrimmed path and fills content + checksum", async () => {
        const { client, readFile } = makeClient({
            kind: "loaded",
            path: "/box/app/config.ts",
            content: "PORT=3000\n",
            sha256: SHA,
            bytes: 10,
            mode: 0o644,
        });
        const { container, root } = await mountSheet(client);
        mounted.push(root);

        await act(async () => {
            // Trailing space is a distinct legal Linux path — must survive verbatim.
            setValue(container, "mj-edit-file-path", "/box/app/config.ts ");
        });
        await act(async () => {
            clickButton(container, "Load current contents");
        });
        await flush();

        expect(readFile).toHaveBeenCalledWith(7, { path: "/box/app/config.ts " });
        // Switched to whole-file mode, seeded the textarea + the sha field.
        const contentEl = container.querySelector<HTMLTextAreaElement>("#mj-edit-file-content");
        expect(contentEl?.value).toBe("PORT=3000\n");
        const shaEl = container.querySelector<HTMLInputElement>("#mj-edit-file-sha");
        expect(shaEl?.value).toBe(SHA);
        expect(container.textContent).toContain("Loaded 10 bytes");
    });

    it("the subsequent Save sends the loaded content WITH the auto-filled expected_sha256 (CAS on by default)", async () => {
        const { client, editFile } = makeClient({
            kind: "loaded",
            path: "/box/app/config.ts",
            content: "PORT=3000\n",
            sha256: SHA,
            bytes: 10,
        });
        const { container, root } = await mountSheet(client);
        mounted.push(root);

        await act(async () => {
            setValue(container, "mj-edit-file-path", "/box/app/config.ts");
        });
        await act(async () => {
            clickButton(container, "Load current contents");
        });
        await flush();
        // Operator tweaks the loaded content, then saves.
        await act(async () => {
            setValue(container, "mj-edit-file-content", "PORT=4000\n");
        });
        await act(async () => {
            clickButton(container, "Save edit");
        });
        await flush();

        expect(editFile).toHaveBeenCalledWith(7, {
            path: "/box/app/config.ts",
            edit: { mode: "content", content: "PORT=4000\n" },
            expectedSha256: SHA,
        });
        expect(container.textContent).toContain("Saved 12 bytes");
    });

    it("retargeting the path after a load clears the auto-filled checksum (sha is bound to the loaded file)", async () => {
        const { client } = makeClient({
            kind: "loaded",
            path: "/box/a.txt",
            content: "a",
            sha256: SHA,
            bytes: 1,
        });
        const { container, root } = await mountSheet(client);
        mounted.push(root);

        await act(async () => {
            setValue(container, "mj-edit-file-path", "/box/a.txt");
        });
        await act(async () => {
            clickButton(container, "Load current contents");
        });
        await flush();
        expect(container.querySelector<HTMLInputElement>("#mj-edit-file-sha")?.value).toBe(SHA);

        await act(async () => {
            setValue(container, "mj-edit-file-path", "/box/b.txt");
        });
        await flush();
        expect(container.querySelector<HTMLInputElement>("#mj-edit-file-sha")?.value).toBe("");
        expect(container.textContent).not.toContain("Loaded 1 byte");
    });

    it("renders a clear, non-crashing message when the file can't be loaded (not-found)", async () => {
        const { client, editFile } = makeClient({ kind: "not-found" });
        const { container, root } = await mountSheet(client);
        mounted.push(root);

        await act(async () => {
            setValue(container, "mj-edit-file-path", "/box/ghost.txt");
        });
        await act(async () => {
            clickButton(container, "Load current contents");
        });
        await flush();

        expect(container.textContent).toContain("may not exist");
        // Form is still usable (manual authoring path preserved); no CAS armed.
        expect(container.querySelector("#mj-edit-file-path")).not.toBeNull();
        expect(container.querySelector<HTMLInputElement>("#mj-edit-file-sha")?.value).toBe("");
        expect(editFile).not.toHaveBeenCalled();
    });

    it("surfaces a path-rejection on load without crashing", async () => {
        const { client } = makeClient({ kind: "path-rejected", reason: "sensitive" });
        const { container, root } = await mountSheet(client);
        mounted.push(root);

        await act(async () => {
            setValue(container, "mj-edit-file-path", "/box/.env");
        });
        await act(async () => {
            clickButton(container, "Load current contents");
        });
        await flush();

        expect(container.textContent).toContain("sensitive path");
    });

    it("refuses an oversize file on load with a reason", async () => {
        const { client } = makeClient({ kind: "too-large" });
        const { container, root } = await mountSheet(client);
        mounted.push(root);

        await act(async () => {
            setValue(container, "mj-edit-file-path", "/box/big.bin");
        });
        await act(async () => {
            clickButton(container, "Load current contents");
        });
        await flush();

        expect(container.textContent).toContain("too large to load");
    });

    it("blocks Load with a validation message when the path is blank (no RPC)", async () => {
        const { client, readFile } = makeClient({ kind: "not-found" });
        const { container, root } = await mountSheet(client);
        mounted.push(root);

        await act(async () => {
            clickButton(container, "Load current contents");
        });
        await flush();

        expect(readFile).not.toHaveBeenCalled();
        expect(container.textContent).toContain("path of the file to load");
    });
});
