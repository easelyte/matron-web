/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MatronJournalClient } from "../../../src/journal/client";
import { MatronApp, NewSessionSheet } from "../../../src/journal/components";
import { NewSessionSheet as OneTapNewSessionSheet } from "../../../src/journal/new-session-ui";
import type {
    BoxStatus,
    ClientState,
    DeviceDTO,
    NewSessionOffer,
    RecentFolder,
    ServerFrame,
    Session,
} from "../../../src/journal/types";

jest.mock("../../../res/matron-logo-simple.svg", () => "matron-logo.svg");

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "token",
    deviceId: 1,
    userId: 2,
    username: "alice",
};

const AGENT_A: DeviceDTO = {
    device_id: 10,
    kind: "agent",
    name: "Box A",
    connected: true,
    is_self: false,
};

const AGENT_B: DeviceDTO = {
    device_id: 11,
    kind: "agent",
    name: "Box B",
    connected: true,
    is_self: false,
};

interface ClientInternals {
    state: ClientState;
    handleFrame(frame: ServerFrame): Promise<void>;
}

function internals(client: MatronJournalClient): ClientInternals {
    return client as unknown as ClientInternals;
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function textButton(container: HTMLElement, text: string): HTMLButtonElement {
    const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.trim() === text,
    );
    if (!match) throw new Error(`Missing button: ${text}`);
    return match;
}

function folderButton(container: HTMLElement, path: string): HTMLButtonElement {
    const match = [...container.querySelectorAll<HTMLButtonElement>(".mj_NewSessionSheet_folder")].find(
        (candidate) => candidate.querySelector(".mj_NewSessionSheet_folderPath")?.textContent === path,
    );
    if (!match) throw new Error(`Missing folder: ${path}`);
    return match;
}

function offer(folders: RecentFolder[], extra: Partial<NewSessionOffer> = {}): NewSessionOffer {
    return {
        folders,
        agentOptions: [],
        defaultAgent: null,
        modelOptions: [],
        defaultModel: null,
        effortOptions: [],
        defaultEffort: null,
        ...extra,
    };
}

async function render(element: React.ReactElement): Promise<{
    container: HTMLDivElement;
    root: Root;
}> {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(element));
    return { container, root };
}

describe("NewSessionSheet", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("runs agent to folder to start and selects the created conversation", async () => {
        const client = new MatronJournalClient();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, AGENT_B]);
        jest.spyOn(client, "newSessionOffer").mockResolvedValue(offer([{ path: "/srv/project", last_used: 1 }]));
        const start = jest.spyOn(client, "startSessionRpc").mockResolvedValue({
            kind: "created",
            convoId: "created-1",
        });
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        const close = jest.fn();

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: close }));
        await act(async () => textButton(rendered!.container, "Box AConnected").click());
        await act(async () => folderButton(rendered!.container, "/srv/project").click());

        expect(start).toHaveBeenCalledWith(AGENT_A.device_id, "/srv/project", false, {});
        expect(close).toHaveBeenCalledTimes(1);
        expect(select).toHaveBeenCalledWith("created-1", { fromRpcCreate: true });
    });

    describe("agent, model and effort", () => {
        const CLAUDE = { value: "claude", label: "Claude" };
        const CODEX = { value: "codex", label: "Codex" };
        const FULL_OFFER: Partial<NewSessionOffer> = {
            agentOptions: [CLAUDE, CODEX],
            defaultAgent: "claude",
            modelOptions: [
                { value: "opus", label: "Opus" },
                { value: "sonnet", label: "Sonnet" },
            ],
            defaultModel: "opus",
            effortOptions: [
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
            ],
            defaultEffort: "high",
        };

        async function openOn(
            extra: Partial<NewSessionOffer>,
            folders: RecentFolder[] = [],
        ): Promise<{ client: MatronJournalClient; start: jest.SpyInstance }> {
            const client = new MatronJournalClient();
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
            jest.spyOn(client, "newSessionOffer").mockResolvedValue(offer(folders, extra));
            const start = jest.spyOn(client, "startSessionRpc").mockResolvedValue({ kind: "uncertain" });
            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
            return { client, start };
        }

        function select(id: string): HTMLSelectElement | null {
            return rendered!.container.querySelector<HTMLSelectElement>(`#${id}`);
        }

        async function choose(id: string, value: string): Promise<void> {
            const element = select(id)!;
            await act(async () => {
                element.value = value;
                element.dispatchEvent(new Event("change", { bubbles: true }));
            });
        }

        function agentButton(label: string): HTMLButtonElement {
            const group = rendered!.container.querySelector('[role="group"][aria-label="Agent"]');
            const match = [...(group?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
                (candidate) => candidate.textContent === label,
            );
            if (!match) throw new Error(`Missing agent: ${label}`);
            return match;
        }

        it("hides every picker for a box that offers none", async () => {
            const { start } = await openOn({});

            expect(rendered!.container.querySelector('[aria-label="Agent"]')).toBeNull();
            expect(select("mj-new-session-model")).toBeNull();
            expect(select("mj-new-session-effort")).toBeNull();
            await act(async () => textButton(rendered!.container, "Start").click());
            expect(start).toHaveBeenCalledWith(AGENT_A.device_id, "", false, {});
        });

        it("names the box defaults on the Default rows and sends only the agent when nothing is picked", async () => {
            const { start } = await openOn(FULL_OFFER);

            expect(agentButton("Claude").getAttribute("aria-pressed")).toBe("true");
            expect(select("mj-new-session-model")!.options[0].textContent).toBe("Default (Opus)");
            expect(select("mj-new-session-effort")!.options[0].textContent).toBe("Default (High)");
            await act(async () => textButton(rendered!.container, "Start").click());
            expect(start).toHaveBeenCalledWith(AGENT_A.device_id, "", false, { agent: "claude" });
        });

        it("sends the picked model and effort", async () => {
            const { start } = await openOn(FULL_OFFER, [{ path: "/srv/project", last_used: null }]);

            await choose("mj-new-session-model", "sonnet");
            await choose("mj-new-session-effort", "medium");
            await act(async () => folderButton(rendered!.container, "/srv/project").click());

            expect(start).toHaveBeenCalledWith(AGENT_A.device_id, "/srv/project", false, {
                agent: "claude",
                model: "sonnet",
                effort: "medium",
            });
        });

        it("hides model and effort for Codex and leaves them off the start", async () => {
            const { start } = await openOn(FULL_OFFER);

            await choose("mj-new-session-model", "sonnet");
            await choose("mj-new-session-effort", "medium");
            await act(async () => agentButton("Codex").click());

            expect(agentButton("Codex").getAttribute("aria-pressed")).toBe("true");
            expect(select("mj-new-session-model")).toBeNull();
            expect(select("mj-new-session-effort")).toBeNull();
            await act(async () => textButton(rendered!.container, "Start").click());
            expect(start).toHaveBeenCalledWith(AGENT_A.device_id, "", false, { agent: "codex" });
        });

        it("opens on a Codex-default box with Codex selected and no Claude pickers", async () => {
            await openOn({ agentOptions: [CLAUDE, CODEX], defaultAgent: "codex" });

            expect(agentButton("Codex").getAttribute("aria-pressed")).toBe("true");
            expect(select("mj-new-session-model")).toBeNull();
        });

        it("shows no switch for a single agent but still names it", async () => {
            const { start } = await openOn({ agentOptions: [CLAUDE], effortOptions: FULL_OFFER.effortOptions });

            expect(rendered!.container.querySelector('[aria-label="Agent"]')).toBeNull();
            expect(select("mj-new-session-effort")!.options[0].textContent).toBe("Default");
            await act(async () => textButton(rendered!.container, "Start").click());
            expect(start).toHaveBeenCalledWith(AGENT_A.device_id, "", false, { agent: "claude" });
        });

        it("keeps the picks for Retry and can go back to change them", async () => {
            const { start } = await openOn(FULL_OFFER);
            start.mockResolvedValue({ kind: "error", message: "That box doesn't offer that model — pick another." });

            await choose("mj-new-session-model", "sonnet");
            await act(async () => textButton(rendered!.container, "Start").click());
            await act(async () => textButton(rendered!.container, "Retry").click());
            expect(start).toHaveBeenLastCalledWith(AGENT_A.device_id, "", false, { agent: "claude", model: "sonnet" });

            await act(async () => textButton(rendered!.container, "Change options").click());
            expect(select("mj-new-session-model")!.value).toBe("sonnet");
            await choose("mj-new-session-model", "");
            await act(async () => textButton(rendered!.container, "Start").click());
            expect(start).toHaveBeenLastCalledWith(AGENT_A.device_id, "", false, { agent: "claude" });
        });

        it("drops a pick the next box does not offer", async () => {
            const client = new MatronJournalClient();
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, AGENT_B]);
            jest.spyOn(client, "newSessionOffer")
                .mockResolvedValueOnce(offer([], FULL_OFFER))
                .mockResolvedValueOnce(offer([], { modelOptions: [{ value: "haiku", label: "Haiku" }] }));
            const start = jest.spyOn(client, "startSessionRpc").mockResolvedValue({ kind: "uncertain" });
            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));

            await act(async () => textButton(rendered!.container, "Box AConnected").click());
            await choose("mj-new-session-model", "sonnet");
            await act(async () => textButton(rendered!.container, "Back").click());
            await act(async () => textButton(rendered!.container, "Box BConnected").click());

            expect(select("mj-new-session-model")!.value).toBe("");
            await act(async () => textButton(rendered!.container, "Start").click());
            expect(start).toHaveBeenCalledWith(AGENT_B.device_id, "", false, {});
        });
    });

    it("captions each recent folder with when it was last used", async () => {
        const client = new MatronJournalClient();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        jest.spyOn(client, "newSessionOffer").mockResolvedValue(
            offer([
                { path: "/srv/recent", last_used: Date.now() - 2 * 60 * 60_000 },
                { path: "/srv/fresh", last_used: null },
            ]),
        );

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));

        const caption = (path: string): string | null | undefined =>
            folderButton(rendered!.container, path).querySelector(".mj_NewSessionSheet_folderUsed")?.textContent;
        expect(caption("/srv/recent")).toBe("2h ago");
        expect(caption("/srv/fresh")).toBe("Never used");
    });

    it("auto-skips a sole connected agent and hides Back", async () => {
        const client = new MatronJournalClient();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        jest.spyOn(client, "newSessionOffer").mockResolvedValue(offer([]));

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));

        expect(rendered.container.textContent).toContain("Start on Box A");
        expect([...rendered.container.querySelectorAll("button")].some((item) => item.textContent === "Back")).toBe(
            false,
        );
    });

    it("shows agents-error and Retry re-runs the roster request", async () => {
        const client = new MatronJournalClient();
        const listAgents = jest
            .spyOn(client, "listAgents")
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce([AGENT_A, AGENT_B]);

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
        expect(rendered.container.textContent).toContain("Couldn't load agents.");

        await act(async () => textButton(rendered!.container, "Retry").click());

        expect(listAgents).toHaveBeenCalledTimes(2);
        expect(rendered.container.textContent).toContain("Box A");
    });

    it("does not let a late recent-folders reply replace the starting state", async () => {
        const client = new MatronJournalClient();
        const folders = deferred<NewSessionOffer>();
        const starting = deferred<{ kind: "uncertain" }>();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        jest.spyOn(client, "newSessionOffer").mockReturnValue(folders.promise);
        jest.spyOn(client, "startSessionRpc").mockReturnValue(starting.promise);

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
        await act(async () => textButton(rendered!.container, "Start").click());
        expect(rendered.container.textContent).toContain("Starting session…");

        await act(async () => folders.resolve(offer([])));

        expect(rendered.container.textContent).toContain("Starting session…");
        expect(rendered.container.textContent).not.toContain("Folder path");
        await act(async () => starting.resolve({ kind: "uncertain" }));
    });

    it("ignores an out-of-order folder reply after re-entering the same agent", async () => {
        const client = new MatronJournalClient();
        const first = deferred<NewSessionOffer>();
        const second = deferred<NewSessionOffer>();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, AGENT_B]);
        jest.spyOn(client, "newSessionOffer").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
        await act(async () => textButton(rendered!.container, "Box AConnected").click());
        await act(async () => textButton(rendered!.container, "Back").click());
        await act(async () => textButton(rendered!.container, "Box AConnected").click());
        await act(async () => second.resolve(offer([{ path: "/new", last_used: 2 }])));
        await act(async () => first.resolve(offer([{ path: "/stale", last_used: 1 }])));

        expect(rendered.container.textContent).toContain("/new");
        expect(rendered.container.textContent).not.toContain("/stale");
    });

    it("suppresses navigation when dismissed while start is pending", async () => {
        const client = new MatronJournalClient();
        const start = deferred<{ kind: "created"; convoId: string }>();
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        jest.spyOn(client, "newSessionOffer").mockResolvedValue(offer([]));
        jest.spyOn(client, "startSessionRpc").mockReturnValue(start.promise);
        const select = jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        const close = jest.fn();

        rendered = await render(React.createElement(NewSessionSheet, { client, onClose: close }));
        await act(async () => textButton(rendered!.container, "Start").click());
        await act(async () =>
            rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
        );
        await act(async () => start.resolve({ kind: "created", convoId: "created-late" }));

        expect(close).toHaveBeenCalledTimes(1);
        expect(select).not.toHaveBeenCalled();
    });

    // An offline box is a sleeping one: its row carries a Wake button that boots it from the list.
    describe("waking a box from its row", () => {
        const ASLEEP_B: DeviceDTO = { ...AGENT_B, connected: false, last_seen_at: 1_700_000_000 };
        const ASLEEP_C: DeviceDTO = {
            device_id: 12,
            kind: "agent",
            name: "Box C",
            connected: false,
            is_self: false,
        };

        function row(container: HTMLElement, name: string): HTMLElement {
            const match = [...container.querySelectorAll<HTMLElement>('[role="listitem"]')].find((item) =>
                item.textContent?.startsWith(name),
            );
            if (!match) throw new Error(`Missing row: ${name}`);
            return match;
        }

        function wakeButton(container: HTMLElement, name: string): HTMLButtonElement | null {
            return container.querySelector<HTMLButtonElement>(`button[aria-label="Wake ${name}"]`);
        }

        afterEach(() => {
            jest.useRealTimers();
        });

        it("shows the list, with Wake on offline rows only, when one box is up among sleeping ones", async () => {
            const client = new MatronJournalClient();
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, ASLEEP_B]);

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));

            expect(wakeButton(rendered.container, "Box A")).toBeNull();
            expect(wakeButton(rendered.container, "Box B")).not.toBeNull();
            expect(row(rendered.container, "Box B").querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
        });

        it("re-asks a booting box until it answers, then the row is connected and opens", async () => {
            jest.useFakeTimers();
            const client = new MatronJournalClient();
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, ASLEEP_B]);
            const probe = jest
                .spyOn(client, "probeAgent")
                .mockResolvedValueOnce("booting")
                .mockResolvedValueOnce("booting")
                .mockResolvedValueOnce("up");
            jest.spyOn(client, "newSessionOffer").mockResolvedValue(offer([]));

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
            await act(async () => wakeButton(rendered!.container, "Box B")!.click());

            expect(row(rendered.container, "Box B").textContent).toBe("Box BWaking…");
            expect(wakeButton(rendered.container, "Box B")).toBeNull();
            expect(probe).toHaveBeenCalledTimes(1);

            await act(async () => jest.advanceTimersByTimeAsync(3_000));
            expect(probe).toHaveBeenCalledTimes(2);
            await act(async () => jest.advanceTimersByTimeAsync(3_000));

            expect(probe).toHaveBeenCalledTimes(3);
            expect(row(rendered.container, "Box B").textContent).toBe("Box BConnected");
            // Rows keep their order.
            expect(
                [...rendered.container.querySelectorAll('[role="listitem"] strong')].map((name) => name.textContent),
            ).toEqual(["Box A", "Box B"]);

            await act(async () => textButton(rendered!.container, "Box BConnected").click());
            expect(rendered.container.textContent).toContain("Start on Box B");
        });

        it("wakes several boxes at once, each on its own loop", async () => {
            const client = new MatronJournalClient();
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, ASLEEP_B, ASLEEP_C]);
            const answers = new Map([
                [ASLEEP_B.device_id, deferred<"up">()],
                [ASLEEP_C.device_id, deferred<"up">()],
            ]);
            const probe = jest.spyOn(client, "probeAgent").mockImplementation((id) => answers.get(id)!.promise);

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
            await act(async () => wakeButton(rendered!.container, "Box B")!.click());
            await act(async () => wakeButton(rendered!.container, "Box C")!.click());

            expect(probe.mock.calls.map(([id]) => id)).toEqual([ASLEEP_B.device_id, ASLEEP_C.device_id]);
            expect(row(rendered.container, "Box B").textContent).toBe("Box BWaking…");
            expect(row(rendered.container, "Box C").textContent).toBe("Box CWaking…");

            await act(async () => answers.get(ASLEEP_C.device_id)!.resolve("up"));

            expect(row(rendered.container, "Box B").textContent).toBe("Box BWaking…");
            expect(row(rendered.container, "Box C").textContent).toBe("Box CConnected");
        });

        it("says so when the box never answers, and offers Wake again", async () => {
            jest.useFakeTimers();
            const client = new MatronJournalClient();
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, ASLEEP_B]);
            const probe = jest.spyOn(client, "probeAgent").mockResolvedValue("booting");

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
            await act(async () => wakeButton(rendered!.container, "Box B")!.click());
            await act(async () => jest.advanceTimersByTimeAsync(121_000));

            // Forty asks, three seconds apart, then no more.
            expect(probe).toHaveBeenCalledTimes(40);
            await act(async () => jest.advanceTimersByTimeAsync(30_000));
            expect(probe).toHaveBeenCalledTimes(40);
            expect(row(rendered.container, "Box B").textContent).toBe("Box BDidn't wake — try again" + "Wake");

            probe.mockResolvedValue("up");
            await act(async () => wakeButton(rendered!.container, "Box B")!.click());
            expect(row(rendered.container, "Box B").textContent).toBe("Box BConnected");
        });

        it("fails at once when the ask cannot reach the journal", async () => {
            const client = new MatronJournalClient();
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, ASLEEP_B]);
            const probe = jest.spyOn(client, "probeAgent").mockResolvedValue("failed");

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
            await act(async () => wakeButton(rendered!.container, "Box B")!.click());

            expect(probe).toHaveBeenCalledTimes(1);
            expect(row(rendered.container, "Box B").textContent).toContain("Didn't wake — try again");
        });

        it("keeps waking behind another box's folder step, and Back shows the box awake", async () => {
            const client = new MatronJournalClient();
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, ASLEEP_B]);
            const answer = deferred<"up">();
            jest.spyOn(client, "probeAgent").mockReturnValue(answer.promise);
            jest.spyOn(client, "newSessionOffer").mockResolvedValue(offer([]));

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
            await act(async () => wakeButton(rendered!.container, "Box B")!.click());
            await act(async () => textButton(rendered!.container, "Box AConnected").click());
            await act(async () => answer.resolve("up"));

            expect(rendered.container.textContent).toContain("Start on Box A");
            await act(async () => textButton(rendered!.container, "Back").click());
            expect(row(rendered.container, "Box B").textContent).toBe("Box BConnected");
        });

        it("stops asking once the sheet is closed", async () => {
            jest.useFakeTimers();
            const client = new MatronJournalClient();
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, ASLEEP_B]);
            const probe = jest.spyOn(client, "probeAgent").mockResolvedValue("booting");

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
            await act(async () => wakeButton(rendered!.container, "Box B")!.click());
            await act(async () =>
                rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(),
            );
            await act(async () => jest.advanceTimersByTimeAsync(30_000));

            expect(probe).toHaveBeenCalledTimes(1);
        });
    });

    // Box usage (protocol.md "Box status"): the sheet renders each box's last capacity report
    // from client state — limits with reset times, live sessions, disk, and an "as of" caption.
    describe("box usage", () => {
        function statusFor(now: number): BoxStatus {
            return {
                reported_at: now - 5 * 60_000,
                activity: { live_sessions: 5, last_hour: [] },
                limits: {
                    as_of: now - 5 * 60_000,
                    lines: [
                        {
                            id: "session",
                            label: "Session",
                            percent: 13,
                            resets: "Sep 28 at 1:10am (Europe/London)",
                            resets_at: new Date(now + 30.5 * 60_000).toISOString(),
                        },
                        { id: "week_all", label: "Week (all models)", percent: 22 },
                        { id: "week_fable", label: "Week (Fable)", percent: 24, resets: "Oct 1 at 1am" },
                    ],
                },
                disk: { free_bytes: 56_908_316_672, total_bytes: 1_979_120_929_996 },
                account: { email: "alice@example.com" },
            };
        }

        function withStatuses(client: MatronJournalClient, boxStatuses: Record<number, BoxStatus>): void {
            internals(client).state = { ...client.getSnapshot(), boxStatuses };
        }

        function listItem(container: HTMLElement, name: string): HTMLElement {
            const match = [...container.querySelectorAll<HTMLElement>('[role="listitem"]')].find((item) =>
                item.textContent?.startsWith(name),
            );
            if (!match) throw new Error(`Missing list item: ${name}`);
            return match;
        }

        it("counts down to a reset more than six hours off", async () => {
            const client = new MatronJournalClient();
            const now = Date.now();
            const status = statusFor(now);
            status.limits!.lines[1] = {
                id: "week_all",
                label: "Week (all models)",
                percent: 22,
                resets_at: new Date(now + 30.5 * 60 * 60_000).toISOString(),
            };
            withStatuses(client, { [AGENT_A.device_id]: status });
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, AGENT_B]);

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));

            const lines = [...listItem(rendered.container, "Box A").querySelectorAll(".mj_NewSessionSheet_usageLine")];
            expect(lines[0].textContent).toBe("Session 13% · resets 30m");
            expect(lines[1].textContent).toMatch(/^Week \(all models\) 22% · resets \w{3} \d{1,2}(am|pm) · in 30h$/);
        });

        it("renders limits, reset times, live sessions, disk and an as-of caption under a box", async () => {
            const client = new MatronJournalClient();
            withStatuses(client, { [AGENT_A.device_id]: statusFor(Date.now()) });
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, AGENT_B]);

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));

            const boxA = listItem(rendered.container, "Box A");
            const lines = [...boxA.querySelectorAll(".mj_NewSessionSheet_usageLine")].map((line) => line.textContent);
            expect(lines).toEqual([
                "Session 13% · resets 30m",
                "Week (all models) 22%",
                "Week (Fable) 24% · resets Oct 1 at 1am",
                "5 live sessions",
                "53G free of 1.8T (3% free)",
            ]);
            expect(boxA.querySelector(".mj_NewSessionSheet_usageAsOf")?.textContent).toBe("as of 5m ago");
        });

        it("shows nothing extra for a box with no status", async () => {
            const client = new MatronJournalClient();
            withStatuses(client, { [AGENT_A.device_id]: statusFor(Date.now()) });
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, AGENT_B]);

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));

            const boxB = listItem(rendered.container, "Box B");
            expect(boxB.querySelector(".mj_NewSessionSheet_usage")).toBeNull();
            expect(boxB.textContent).toBe("Box BConnected");
        });

        it("renders only the blocks a status carries", async () => {
            const client = new MatronJournalClient();
            withStatuses(client, {
                [AGENT_A.device_id]: {
                    reported_at: Date.now() - 3 * 60 * 60_000,
                    activity: { live_sessions: 1, last_hour: [] },
                },
            });
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, AGENT_B]);

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));

            const boxA = listItem(rendered.container, "Box A");
            expect([...boxA.querySelectorAll(".mj_NewSessionSheet_usageLine")].map((line) => line.textContent)).toEqual(
                ["1 live session"],
            );
            expect(boxA.querySelector(".mj_NewSessionSheet_usageAsOf")?.textContent).toBe("as of 3h ago");
        });

        it("updates the lines and the as-of caption when a live box_status frame lands", async () => {
            const client = new MatronJournalClient();
            withStatuses(client, { [AGENT_A.device_id]: statusFor(Date.now()) });
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A, AGENT_B]);

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));
            await act(async () =>
                internals(client).handleFrame({
                    kind: "box_status",
                    device_id: AGENT_A.device_id,
                    reported_at: Date.now(),
                    limits: { as_of: Date.now(), lines: [{ id: "session", label: "Session", percent: 14 }] },
                } as unknown as ServerFrame),
            );

            const boxA = listItem(rendered.container, "Box A");
            expect([...boxA.querySelectorAll(".mj_NewSessionSheet_usageLine")].map((line) => line.textContent)).toEqual(
                ["Session 14%"],
            );
            expect(boxA.querySelector(".mj_NewSessionSheet_usageAsOf")?.textContent).toBe("as of just now");
        });

        it("shows the chosen box's usage on the folder step too", async () => {
            const client = new MatronJournalClient();
            withStatuses(client, { [AGENT_A.device_id]: statusFor(Date.now()) });
            jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
            jest.spyOn(client, "newSessionOffer").mockResolvedValue(offer([]));

            rendered = await render(React.createElement(NewSessionSheet, { client, onClose: jest.fn() }));

            expect(rendered.container.textContent).toContain("Start on Box A");
            expect(rendered.container.querySelector(".mj_NewSessionSheet_usage")).not.toBeNull();
            expect(rendered.container.textContent).toContain("Session 13% · resets 30m");
            expect(rendered.container.textContent).toContain("as of 5m ago");
        });
    });
});

const OPTIONS = {
    folders: [
        { path: "/srv/project", last_used: 2 },
        { path: "/home/user/workspace", last_used: 1 },
    ],
    models: [
        { value: "opus", label: "Opus 4.5" },
        { value: "sonnet", label: "Sonnet 4.5" },
    ],
    defaultModel: "opus",
    agents: ["claude", "codex"] as Array<"claude" | "codex">,
    defaultAgent: "claude" as const,
};

const byText = (container: HTMLElement, selector: string, text: string): HTMLElement =>
    [...container.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent?.trim() === text)!;

describe("New session options sheet", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => localStorage.clear());

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    async function openSheet(client: MatronJournalClient, onClose = jest.fn()): Promise<HTMLElement> {
        jest.spyOn(client, "listAgents").mockResolvedValue([AGENT_A]);
        jest.spyOn(client, "sessionOptions").mockResolvedValue(OPTIONS);
        rendered = await render(React.createElement(OneTapNewSessionSheet, { client, onClose }));
        return rendered.container.querySelector<HTMLElement>('[role="dialog"]')!;
    }

    it("lays out folder · agent · model · browser · first task · remember · box, focused on the folder", async () => {
        const dialog = await openSheet(new MatronJournalClient());
        const labels = [...dialog.querySelectorAll(".mj_FieldLabel, .mj_SwitchLabel, .mj_CheckRow")].map((node) =>
            node.textContent?.trim(),
        );
        expect(labels).toEqual([
            "Folder",
            "Agent",
            "Model",
            "Browser tools",
            "First task (optional)",
            "Remember as my defaults",
        ]);
        expect(dialog.querySelector(".mj_BoxCaption")?.textContent).toBe("On Box A");
        const radios = [...dialog.querySelectorAll('.mj_FolderList [role="radio"]')].map((node) => node.textContent);
        expect(radios).toEqual(["/srv/project", "/home/user/workspace", "Other folder…"]);
        expect(document.activeElement?.textContent).toBe("/srv/project");
        const model = dialog.querySelector<HTMLSelectElement>("select")!;
        expect(model.value).toBe("opus");
        expect(model.selectedOptions[0].textContent).toBe("Opus 4.5 (box default)");
    });

    it("disables the model and browser tools for Codex", async () => {
        const dialog = await openSheet(new MatronJournalClient());
        await act(async () => byText(dialog, '.mj_Segmented [role="radio"]', "Codex").click());
        expect(dialog.querySelector<HTMLSelectElement>("select")!.disabled).toBe(true);
        expect(dialog.textContent).toContain("Codex picks its own model");
        expect(dialog.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
        expect(dialog.textContent).toContain("Not available for Codex sessions");
    });

    it("starts with the picks, sends the first task as a message and remembers the defaults", async () => {
        const client = new MatronJournalClient();
        const start = jest.spyOn(client, "startSessionRpc").mockResolvedValue({ kind: "created", convoId: "new" });
        jest.spyOn(client, "selectConversation").mockResolvedValue(undefined);
        const send = jest.spyOn(client, "sendMessage").mockResolvedValue(true);
        // The new conversation is known to the client, so the first task goes out at once.
        jest.spyOn(client, "getSnapshot").mockReturnValue({
            ...new MatronJournalClient().getSnapshot(),
            conversations: [{ id: "new" } as never],
        });
        const onClose = jest.fn();
        const dialog = await openSheet(client, onClose);
        await act(async () => byText(dialog, '.mj_FolderList [role="radio"]', "/home/user/workspace").click());
        await act(async () => {
            const select = dialog.querySelector<HTMLSelectElement>("select")!;
            select.value = "sonnet";
            select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await act(async () => dialog.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
        await act(async () => {
            const task = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
            setter.call(task, "Fix the flaky test.");
            task.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => dialog.querySelector<HTMLInputElement>('.mj_CheckRow input[type="checkbox"]')!.click());
        await act(async () => byText(dialog, "button", "Start session").click());
        expect(start).toHaveBeenCalledWith(10, "/home/user/workspace", true, {
            model: "sonnet",
            agent: "claude",
            idempotencyKey: expect.any(String),
        });
        expect(onClose).toHaveBeenCalled();
        await act(async () => undefined);
        expect(send).toHaveBeenCalledWith("Fix the flaky test.", "new");
        expect(localStorage.getItem("matron.newSessionBox")).toBe("10");
        expect(JSON.parse(localStorage.getItem("matron.newSessionDefaults.10")!)).toEqual({
            folder: "/home/user/workspace",
            model: "sonnet",
            agent: "claude",
        });
    });

    it("shows the bridge's bad-folder error on the Other folder field", async () => {
        const client = new MatronJournalClient();
        jest.spyOn(client, "startSessionRpc").mockResolvedValue({
            kind: "error",
            code: "bad_workdir",
            message: "That folder doesn’t exist on the box.",
        });
        const dialog = await openSheet(client);
        await act(async () => byText(dialog, '.mj_FolderList [role="radio"]', "Other folder…").click());
        const input = dialog.querySelector<HTMLInputElement>(".mj_TextInput")!;
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
            setter.call(input, "/opt/matron-wbe");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => byText(dialog, "button", "Start session").click());
        const error = dialog.querySelector('.mj_FieldError[role="alert"]')!;
        expect(error.textContent).toBe("That folder doesn’t exist on the box.");
        expect(input.getAttribute("aria-describedby")).toBe(error.id);
        expect(input.getAttribute("aria-invalid")).toBe("true");
    });
});

// Box usage (ported from upstream's sheet): the v6 sheet renders the chosen box's last capacity
// report — limits with reset times, live sessions, disk, and an "as of" caption — from the
// roster's `status` or a newer live `box_status` frame.
describe("New session sheet box usage", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    beforeAll(() => {
        (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => localStorage.clear());

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    function statusFor(now: number): BoxStatus {
        return {
            reported_at: now - 5 * 60_000,
            activity: { live_sessions: 5, last_hour: [] },
            limits: {
                as_of: now - 5 * 60_000,
                lines: [
                    {
                        id: "session",
                        label: "Session",
                        percent: 13,
                        resets: "Sep 28 at 1:10am (Europe/London)",
                        resets_at: new Date(now + 30.5 * 60_000).toISOString(),
                    },
                    { id: "week_all", label: "Week (all models)", percent: 22 },
                    { id: "week_fable", label: "Week (Fable)", percent: 24, resets: "Oct 1 at 1am" },
                ],
            },
            disk: { free_bytes: 56_908_316_672, total_bytes: 1_979_120_929_996 },
            account: { email: "dan@example.com" },
        };
    }

    async function openSheet(client: MatronJournalClient, agent: DeviceDTO): Promise<HTMLElement> {
        jest.spyOn(client, "listAgents").mockResolvedValue([agent]);
        jest.spyOn(client, "sessionOptions").mockResolvedValue(OPTIONS);
        rendered = await render(React.createElement(OneTapNewSessionSheet, { client, onClose: jest.fn() }));
        return rendered.container.querySelector<HTMLElement>('[role="dialog"]')!;
    }

    const usageLines = (dialog: HTMLElement): Array<string | null> =>
        [...dialog.querySelectorAll(".mj_NewSessionSheet_usageLine")].map((line) => line.textContent);

    it("renders limits, reset times, live sessions, disk and an as-of caption under the box", async () => {
        const dialog = await openSheet(new MatronJournalClient(), { ...AGENT_A, status: statusFor(Date.now()) });
        expect(usageLines(dialog)).toEqual([
            "Session 13% · resets 30m",
            "Week (all models) 22%",
            "Week (Fable) 24% · resets Oct 1 at 1am",
            "5 live sessions",
            "53G free of 1.8T (3% free)",
        ]);
        expect(dialog.querySelector(".mj_NewSessionSheet_usageAsOf")?.textContent).toBe("as of 5m ago");
    });

    it("shows nothing extra for a box with no status", async () => {
        const dialog = await openSheet(new MatronJournalClient(), AGENT_A);
        expect(dialog.querySelector(".mj_NewSessionSheet_usage")).toBeNull();
    });

    it("renders only the blocks a status carries", async () => {
        const dialog = await openSheet(new MatronJournalClient(), {
            ...AGENT_A,
            status: { reported_at: Date.now() - 3 * 60 * 60_000, activity: { live_sessions: 1, last_hour: [] } },
        });
        expect(usageLines(dialog)).toEqual(["1 live session"]);
        expect(dialog.querySelector(".mj_NewSessionSheet_usageAsOf")?.textContent).toBe("as of 3h ago");
    });

    it("updates the lines and the as-of caption when a live box_status frame lands", async () => {
        const client = new MatronJournalClient();
        const dialog = await openSheet(client, { ...AGENT_A, status: statusFor(Date.now()) });
        await act(async () =>
            internals(client).handleFrame({
                kind: "box_status",
                device_id: AGENT_A.device_id,
                reported_at: Date.now(),
                limits: { as_of: Date.now(), lines: [{ id: "session", label: "Session", percent: 14 }] },
            } as unknown as ServerFrame),
        );
        expect(usageLines(dialog)).toEqual(["Session 14%"]);
        expect(dialog.querySelector(".mj_NewSessionSheet_usageAsOf")?.textContent).toBe("as of just now");
    });
});

describe("New session overlay exclusivity", () => {
    let rendered: { container: HTMLDivElement; root: Root } | undefined;

    afterEach(async () => {
        if (rendered) {
            await act(async () => rendered?.root.unmount());
            rendered.container.remove();
            rendered = undefined;
        }
        jest.restoreAllMocks();
    });

    it("opening Settings closes NewSessionSheet and opening the sheet closes Settings", async () => {
        const client = new MatronJournalClient();
        internals(client).state = {
            ...client.getSnapshot(),
            phase: "signed-in",
            session: SESSION,
            connection: "online",
        };
        jest.spyOn(client, "listAgents").mockReturnValue(new Promise(() => undefined));
        rendered = await render(React.createElement(MatronApp, { client }));

        await act(async () =>
            rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="New session"]')!.click(),
        );
        expect(rendered.container.querySelector(".mj_NewSessionSheet")).not.toBeNull();

        await act(async () => rendered!.container.querySelector<HTMLButtonElement>(".mj_NavRail_settings")!.click());
        expect(rendered.container.querySelector(".mj_NewSessionSheet")).toBeNull();
        expect(rendered.container.querySelector(".mj_SettingsSheet")).not.toBeNull();

        await act(async () =>
            rendered!.container.querySelector<HTMLButtonElement>('button[aria-label="New session"]')!.click(),
        );
        expect(rendered.container.querySelector(".mj_SettingsSheet")).toBeNull();
        expect(rendered.container.querySelector(".mj_NewSessionSheet")).not.toBeNull();
    });
});
