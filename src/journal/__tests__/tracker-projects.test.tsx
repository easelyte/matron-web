/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { ProjectPage } from "../tracker/ProjectPage";
import { ProjectsDashboard } from "../tracker/ProjectsDashboard";
import { trackerMission, trackerProject, trackerProjectDetail, trackerProjectDetailWithFeed } from "./tracker-fixtures";

async function mount(element: React.ReactElement): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => createRoot(container).render(element));
    return container;
}

beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
    document.body.innerHTML = "";
});

describe("ProjectsDashboard", () => {
    it("renders one card per open project with title, needs-you pill, status and footer", async () => {
        const onOpen = jest.fn();
        const container = await mount(
            <ProjectsDashboard
                projects={[
                    trackerProject(),
                    trackerProject({ id: "pj_2", num: 2, title: "Closed one", state: "closed" }),
                ]}
                onOpenProject={onOpen}
            />,
        );
        const cards = container.querySelectorAll<HTMLButtonElement>(".mj_ProjectCard");
        expect(cards).toHaveLength(1);
        expect(cards[0].querySelector(".mj_ProjectCard_title")?.textContent).toBe("Web/Mac design unification");
        expect(cards[0].querySelector(".mj_NeedsYouPill")?.textContent).toBe("Needs you · 2");
        expect(cards[0].querySelector(".mj_ProjectCard_status")?.textContent).toContain("Phase 2 running");
        expect(cards[0].querySelector(".mj_ProjectCard_footer")?.textContent).toMatch(/^2 open missions · /);
        await act(async () => cards[0].click());
        expect(onOpen).toHaveBeenCalledWith(2645);
    });

    it("says so when a project has no status, and offers the closed ones behind a toggle", async () => {
        const container = await mount(
            <ProjectsDashboard
                projects={[
                    trackerProject({ status: null, needs_you: 0 }),
                    trackerProject({ id: "pj_2", num: 2, title: "Closed one", state: "closed" }),
                ]}
                onOpenProject={jest.fn()}
            />,
        );
        expect(container.querySelector(".mj_ProjectCard_status")?.textContent).toBe("No status yet");
        expect(container.querySelector(".mj_NeedsYouPill")).toBeNull();
        const toggle = container.querySelector<HTMLButtonElement>(".mj_ProjectsClosedToggle")!;
        expect(toggle.textContent).toBe("Closed (1)");
        await act(async () => toggle.click());
        expect(container.querySelectorAll(".mj_ProjectCard")).toHaveLength(2);
    });

    it("lists open missions that are in no project below the cards", async () => {
        const onOpenMission = jest.fn();
        const container = await mount(
            <ProjectsDashboard
                projects={[trackerProject()]}
                unfiled={[
                    trackerMission({ num: 12, title: "Loose mission", project_id: null, activity: "idle" }),
                    trackerMission({ id: "ms_9", num: 9, title: "Filed", project_id: "pj_1" }),
                    trackerMission({ id: "ms_8", num: 8, title: "Closed loose", state: "closed", project_id: null }),
                ]}
                onOpenProject={jest.fn()}
                onOpenMission={onOpenMission}
            />,
        );
        const rows = container.querySelectorAll<HTMLButtonElement>(".mj_ProjectsUnfiled .mj_ProjectMission");
        expect(container.querySelector(".mj_ProjectsUnfiled .mj_ProjectSection_title")?.textContent).toBe(
            "Not in a project",
        );
        expect(rows).toHaveLength(1);
        await act(async () => rows[0].click());
        expect(onOpenMission).toHaveBeenCalledWith(12);
    });

    it("gives an unfiled waiting mission the waiting dot, as the project page does", async () => {
        const container = await mount(
            <ProjectsDashboard
                projects={[]}
                unfiled={[trackerMission({ num: 12, project_id: null, activity: "waiting", needs_you: 0 })]}
                onOpenProject={jest.fn()}
            />,
        );
        expect(container.querySelector(".mj_ProjectsUnfiled .mj_ProjectMission_dot_waiting")).not.toBeNull();
    });

    it("names each card by its content, not a replacement label", async () => {
        const container = await mount(<ProjectsDashboard projects={[trackerProject()]} onOpenProject={jest.fn()} />);
        expect(container.querySelector(".mj_ProjectCard")?.hasAttribute("aria-label")).toBe(false);
    });

    describe("filter field", () => {
        async function type(container: HTMLElement, value: string): Promise<void> {
            const input = container.querySelector<HTMLInputElement>(".mj_ProjectsFilter_field input")!;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
            await act(async () => {
                setter.call(input, value);
                input.dispatchEvent(new Event("input", { bubbles: true }));
            });
        }
        const titles = (container: HTMLElement): string[] =>
            [...container.querySelectorAll(".mj_ProjectCard_title")].map((node) => node.textContent ?? "");
        const dashboard = (
            <ProjectsDashboard
                projects={[
                    trackerProject({ id: "pj_1", num: 1, title: "Docs site launch" }),
                    trackerProject({ id: "pj_2", num: 2, title: "Print pipeline" }),
                    trackerProject({ id: "pj_3", num: 3, title: "Cover designer" }),
                    trackerProject({ id: "pj_4", num: 4, title: "Old cover tool", state: "closed" }),
                ]}
                unfiled={[
                    trackerMission({
                        id: "ms_11",
                        num: 11,
                        title: "Spine width",
                        name: "Cóver spine",
                        project_id: "pj_2",
                    }),
                    trackerMission({
                        id: "ms_12",
                        num: 12,
                        title: "Cover photo upload",
                        project_id: null,
                        activity: "idle",
                    }),
                    trackerMission({
                        id: "ms_13",
                        num: 13,
                        title: "Tidy the icons",
                        project_id: null,
                        activity: "idle",
                    }),
                ]}
                onOpenProject={jest.fn()}
            />
        );

        it("narrows to projects named by their title or by a mission, title matches first", async () => {
            const container = await mount(dashboard);
            expect(titles(container)).toEqual(["Docs site launch", "Print pipeline", "Cover designer"]);
            await type(container, "COVER");
            expect(titles(container)).toEqual(["Cover designer", "Print pipeline", "Old cover tool"]);
            expect(container.querySelector(".mj_ProjectCard_match")?.textContent).toBe("Mission: Cóver spine");
            expect(container.querySelector(".mj_ProjectsFilter_count")?.textContent).toBe("2 of 3");
            expect(container.querySelectorAll(".mj_ProjectsUnfiled .mj_ProjectMission")).toHaveLength(1);
            expect(container.querySelector(".mj_ProjectsClosedToggle")).toBeNull();
        });

        it("needs every word, in any order", async () => {
            const container = await mount(dashboard);
            await type(container, "spine print");
            expect(titles(container)).toEqual(["Print pipeline"]);
            await type(container, "cover zebra");
            expect(titles(container)).toEqual([]);
            expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe(
                "No projects match “cover zebra”",
            );
        });

        it("names the mission that supplied the word the title lacks", async () => {
            const container = await mount(
                <ProjectsDashboard
                    projects={[trackerProject({ id: "pj_2", num: 2, title: "Print pipeline" })]}
                    unfiled={[
                        trackerMission({ id: "ms_10", num: 10, title: "Print queue", project_id: "pj_2" }),
                        trackerMission({ id: "ms_11", num: 11, title: "Spine width on the cover", project_id: "pj_2" }),
                    ]}
                    onOpenProject={jest.fn()}
                />,
            );
            await type(container, "print cover");
            expect(container.querySelector(".mj_ProjectCard_match")?.textContent).toBe(
                "Mission: Spine width on the cover",
            );
        });

        it("brings the whole page back when cleared", async () => {
            const container = await mount(dashboard);
            await type(container, "cover");
            await type(container, "");
            expect(titles(container)).toEqual(["Docs site launch", "Print pipeline", "Cover designer"]);
            expect(container.querySelector(".mj_ProjectsClosedToggle")?.textContent).toBe("Closed (1)");
            expect(container.querySelectorAll(".mj_ProjectsUnfiled .mj_ProjectMission")).toHaveLength(2);
        });
    });

    it("shows an empty state", async () => {
        const container = await mount(<ProjectsDashboard projects={[]} onOpenProject={jest.fn()} />);
        expect(container.querySelector(".mj_TrackerEmpty_title")?.textContent).toBe("No projects yet");
    });
});

describe("ProjectPage", () => {
    it("leads with the status and pulse, then needs you, latest, missions and the folds", async () => {
        const onOpenMission = jest.fn();
        const onOpenItem = jest.fn();
        const container = await mount(
            <ProjectPage
                detail={trackerProjectDetail()}
                onBack={jest.fn()}
                onOpenMission={onOpenMission}
                onOpenItem={onOpenItem}
            />,
        );
        expect(container.querySelector(".mj_ProjectPage_title")?.textContent).toBe("Web/Mac design unification");
        expect(container.querySelector(".mj_ProjectPulse")?.textContent).toMatch(
            /^1 running1 waiting1 closed2 sessions on 2 boxes · last activity /,
        );
        expect(container.querySelector(".mj_ProjectPage_statusLabel")?.textContent).toBe("Status");
        expect(container.querySelector(".mj_ProjectPage_status")?.textContent).toContain("Phase 2 running");
        const titles = [...container.querySelectorAll(".mj_ProjectSection_title")].map((el) => el.textContent);
        expect(titles).toEqual(["Needs you", "Latest", "Missions", "Sessions on it now", "About this project"]);
        // Without the roll-up the feed is the latest milestone and the question for you.
        const feed = [...container.querySelectorAll(".mj_ProjectLatest .mj_ProjectActivity_title")].map(
            (el) => el.textContent,
        );
        expect(feed).toEqual(["Token PR merged", "Merge unify step 2?"]);
        expect(container.querySelector(".mj_ProjectLatest_more")).toBeNull();
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_ProjectNeedsYou_row")!.click());
        expect(onOpenItem).toHaveBeenCalledWith(3939);
        const missionRows = container.querySelectorAll<HTMLButtonElement>(".mj_ProjectMission");
        expect(missionRows).toHaveLength(2);
        expect(missionRows[0].querySelector(".mj_ProjectMission_dot_running")).not.toBeNull();
        await act(async () => missionRows[1].click());
        expect(onOpenMission).toHaveBeenCalledWith(1594);
        // The folds are closed until opened; their content is still in the page.
        const folds = container.querySelectorAll<HTMLDetailsElement>(".mj_ProjectFold");
        expect([...folds].every((fold) => !fold.open)).toBe(true);
        expect(container.querySelector(".mj_ProjectSessions")?.textContent).toContain("build-box 1");
        expect(container.querySelector(".mj_ProjectFold_about")?.textContent).toContain(
            "Audit, then the Mac app leads.",
        );
    });

    it("merges the roll-up into Latest and offers Show more while pages are left", async () => {
        const onLoadMore = jest.fn();
        const onOpenItem = jest.fn();
        const container = await mount(
            <ProjectPage
                detail={trackerProjectDetailWithFeed()}
                onBack={jest.fn()}
                onOpenMission={jest.fn()}
                onOpenItem={onOpenItem}
                onLoadMore={onLoadMore}
            />,
        );
        const rows = [...container.querySelectorAll(".mj_ProjectLatest .mj_ProjectActivity_row")];
        const titles = rows.map((row) => row.querySelector(".mj_ProjectActivity_title")?.textContent);
        expect(titles).toEqual([
            "Token PR merged",
            "Ship the sign-in change with the tokens?",
            "Sign-in, dark.png",
            "Alice: tokens first, then sign-in",
        ]);
        expect(rows[1].querySelector(".mj_ProjectActivity_note")?.textContent).toBe("Answered: “Yes, both together.”");
        expect(rows[3].querySelector(".mj_ProjectActivity_note")?.textContent).toBe("Your input");
        // The fixture's times are relative to the clock, so only the grouping itself is asserted.
        expect(container.querySelectorAll(".mj_ProjectDay_label").length).toBeGreaterThanOrEqual(1);
        await act(async () => (rows[1] as HTMLButtonElement).click());
        expect(onOpenItem).toHaveBeenCalledWith(41);
        // Every loaded row shows, so Show more asks for the next pages.
        await act(async () => container.querySelector<HTMLButtonElement>(".mj_ProjectLatest_more")!.click());
        expect(onLoadMore).toHaveBeenCalledTimes(1);
        const titlesAll = [...container.querySelectorAll(".mj_ProjectSection_title")].map((el) => el.textContent);
        expect(titlesAll).toEqual([
            "Needs you",
            "Latest",
            "Missions",
            "Decisions",
            "Files and images",
            "Sessions on it now",
            "About this project",
        ]);
        expect(container.querySelector(".mj_ProjectFold_decisions .mj_ProjectActivity_struck")?.textContent).toBe(
            "Keep the old sign-in page",
        );
        expect(container.querySelector(".mj_ProjectFold_decisions .mj_ProjectActivity_glyph_reversed")).not.toBeNull();
    });

    it("omits the needs-you card when nothing waits on you, and leads with the description when there is no status", async () => {
        const detail = trackerProjectDetail({ needs_you: [] });
        detail.project = { ...detail.project, status: null };
        const container = await mount(
            <ProjectPage detail={detail} onBack={jest.fn()} onOpenMission={jest.fn()} onOpenItem={jest.fn()} />,
        );
        expect(container.querySelector(".mj_ProjectNeedsYou")).toBeNull();
        expect(container.querySelector(".mj_ProjectPage_statusLabel")?.textContent).toBe("About");
        expect(container.querySelector(".mj_ProjectPage_statusText")?.textContent).toBe(
            "Audit, then the Mac app leads.",
        );
        expect(container.querySelector(".mj_ProjectFold_about")).toBeNull();
    });
});

describe("Project filing", () => {
    const DAY = 86_400_000;
    const NOW = 100 * DAY;
    const press = async (element: Element | null | undefined): Promise<void> => {
        await act(async () => (element as HTMLElement).click());
    };
    const byText = (selector: string, text: string): HTMLElement | undefined =>
        Array.from(document.querySelectorAll<HTMLElement>(selector)).find((node) => node.textContent === text);
    const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        await act(async () => {
            Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
    };

    it("folds missions not in a project that have been quiet for over a week", async () => {
        const container = await mount(
            <ProjectsDashboard
                projects={[trackerProject()]}
                now={NOW}
                unfiled={[
                    trackerMission({ id: "ms_a", num: 21, title: "Active loose", project_id: null, activity: "idle" }),
                    trackerMission({ id: "ms_q", num: 22, title: "Quiet loose", project_id: null, activity: "quiet" }),
                    // Derived from the last activity when the journal sends no rollup: quiet from exactly 7 days.
                    trackerMission({
                        id: "ms_o",
                        num: 23,
                        title: "Old loose",
                        project_id: null,
                        last_activity_at: NOW - 7 * DAY,
                    }),
                    // Anything asking the user is never quiet.
                    trackerMission({
                        id: "ms_n",
                        num: 24,
                        title: "Asking loose",
                        project_id: null,
                        activity: "quiet",
                        needs_you: 1,
                    }),
                ]}
                onOpenProject={jest.fn()}
            />,
        );
        const titles = (): string[] =>
            Array.from(container.querySelectorAll(".mj_ProjectMission_title")).map((node) => node.textContent ?? "");
        expect(titles()).toEqual(["Active loose", "Asking loose"]);
        const toggle = container.querySelector<HTMLButtonElement>(".mj_ProjectsQuietToggle")!;
        expect(toggle.textContent).toContain("Quiet for over a week (2)");
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        await press(toggle);
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
        expect(titles()).toEqual(["Active loose", "Asking loose", "Old loose", "Quiet loose"]);
    });

    it("opens the quiet fold while the filter is on", async () => {
        const container = await mount(
            <ProjectsDashboard
                projects={[trackerProject()]}
                now={NOW}
                unfiled={[trackerMission({ num: 22, title: "Quiet loose", project_id: null, activity: "quiet" })]}
                onOpenProject={jest.fn()}
            />,
        );
        await type(container.querySelector<HTMLInputElement>(".mj_ProjectsFilter_field input")!, "quiet");
        expect(container.querySelector(".mj_ProjectMission_title")?.textContent).toBe("Quiet loose");
    });

    it("creates a project from the New project sheet", async () => {
        const onCreate = jest.fn().mockResolvedValue(null);
        const container = await mount(
            <ProjectsDashboard projects={[trackerProject()]} onOpenProject={jest.fn()} onCreateProject={onCreate} />,
        );
        await press(byText("button", "New project"));
        const sheet = document.querySelector('[role="dialog"]')!;
        expect(sheet.querySelector("h2")?.textContent).toBe("New project");
        const create = byText("button", "Create") as HTMLButtonElement;
        expect(create.disabled).toBe(true);
        await type(sheet.querySelector<HTMLInputElement>("#mj-new-project-name")!, "  Spring launch ");
        await type(sheet.querySelector<HTMLTextAreaElement>("#mj-new-project-body")!, "The site and the emails");
        await act(async () => sheet.querySelector("form")!.requestSubmit());
        expect(onCreate).toHaveBeenCalledWith("Spring launch", "The site and the emails");
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(container).toBeTruthy();
    });

    it("keeps the sheet open with the reason when the create fails", async () => {
        const onCreate = jest.fn().mockResolvedValue("offline");
        await mount(<ProjectsDashboard projects={[]} onOpenProject={jest.fn()} onCreateProject={onCreate} />);
        await press(byText("button", "New project"));
        const sheet = document.querySelector('[role="dialog"]')!;
        await type(sheet.querySelector<HTMLInputElement>("#mj-new-project-name")!, "Launch");
        await act(async () => sheet.querySelector("form")!.requestSubmit());
        expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("offline");
        expect(sheet.querySelector<HTMLInputElement>("#mj-new-project-name")!.value).toBe("Launch");
    });

    it("has no New project button when the host cannot create one", async () => {
        await mount(<ProjectsDashboard projects={[trackerProject()]} onOpenProject={jest.fn()} />);
        expect(byText("button", "New project")).toBeUndefined();
    });

    it("merges a project into another after a confirmation naming both", async () => {
        const onMerge = jest.fn().mockResolvedValue(null);
        const other = trackerProject({ id: "pj_2", num: 2, title: "Spring launch" });
        const closed = trackerProject({ id: "pj_3", num: 3, title: "Old", state: "closed" });
        await mount(
            <ProjectPage
                detail={trackerProjectDetail()}
                projects={[trackerProject(), other, closed]}
                onBack={jest.fn()}
                onOpenMission={jest.fn()}
                onOpenItem={jest.fn()}
                onMerge={onMerge}
            />,
        );
        await press(document.querySelector('[aria-label="Project actions"]'));
        await press(byText('[role="menuitem"]', "Merge into…"));
        const targets = Array.from(document.querySelectorAll('[role="dialog"] [role="listitem"]')).map(
            (node) => node.textContent,
        );
        expect(targets).toEqual(["Spring launch"]);
        await press(byText('[role="dialog"] [role="listitem"]', "Spring launch"));
        expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe(
            "Merge “Web/Mac design unification” into “Spring launch”?",
        );
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
            "Its missions move there and this project closes.",
        );
        expect(onMerge).not.toHaveBeenCalled();
        await press(byText('[role="dialog"] button', "Merge"));
        expect(onMerge).toHaveBeenCalledWith("pj_1", "pj_2");
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it("goes back to the choice when the chosen target closes before the merge is confirmed", async () => {
        const onMerge = jest.fn().mockResolvedValue(null);
        const other = trackerProject({ id: "pj_2", num: 2, title: "Spring launch" });
        const third = trackerProject({ id: "pj_3", num: 3, title: "Autumn launch" });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const page = (projects: ReturnType<typeof trackerProject>[]): React.ReactElement => (
            <ProjectPage
                detail={trackerProjectDetail()}
                projects={projects}
                onBack={jest.fn()}
                onOpenMission={jest.fn()}
                onOpenItem={jest.fn()}
                onMerge={onMerge}
            />
        );
        await act(async () => root.render(page([trackerProject(), other, third])));
        await press(document.querySelector('[aria-label="Project actions"]'));
        await press(byText('[role="menuitem"]', "Merge into…"));
        await press(byText('[role="dialog"] [role="listitem"]', "Spring launch"));
        expect(document.activeElement?.textContent).toBe("Cancel");

        // A refresh lands with the target closed: the confirmation no longer names it.
        await act(async () => root.render(page([trackerProject(), { ...other, state: "closed" }, third])));
        expect(byText('[role="dialog"] button', "Merge")).toBeUndefined();
        expect(
            Array.from(document.querySelectorAll('[role="dialog"] [role="listitem"]')).map((node) => node.textContent),
        ).toEqual(["Autumn launch"]);
        expect(onMerge).not.toHaveBeenCalled();
    });

    it("closes the merge sheet when the page swaps to another project", async () => {
        const onMerge = jest.fn().mockResolvedValue(null);
        const other = trackerProject({ id: "pj_2", num: 2, title: "Spring launch" });
        const third = trackerProject({ id: "pj_3", num: 3, title: "Autumn launch" });
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const page = (shown: ReturnType<typeof trackerProject>): React.ReactElement => (
            <ProjectPage
                detail={trackerProjectDetail({ project: shown })}
                projects={[trackerProject(), other, third]}
                onBack={jest.fn()}
                onOpenMission={jest.fn()}
                onOpenItem={jest.fn()}
                onMerge={onMerge}
            />
        );
        await act(async () => root.render(page(trackerProject())));
        await press(document.querySelector('[aria-label="Project actions"]'));
        await press(byText('[role="menuitem"]', "Merge into…"));
        await press(byText('[role="dialog"] [role="listitem"]', "Autumn launch"));

        // A merge made elsewhere: the reload follows to the survivor in place.
        await act(async () => root.render(page(other)));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(onMerge).not.toHaveBeenCalled();
    });

    it("offers no merge on a closed project, and a disabled one with nowhere to go", async () => {
        await mount(
            <ProjectPage
                detail={trackerProjectDetail({ project: trackerProject({ state: "closed" }) })}
                projects={[trackerProject({ state: "closed" })]}
                onBack={jest.fn()}
                onOpenMission={jest.fn()}
                onOpenItem={jest.fn()}
                onMerge={jest.fn()}
            />,
        );
        expect(document.querySelector('[aria-label="Project actions"]')).toBeNull();
        document.body.innerHTML = "";
        await mount(
            <ProjectPage
                detail={trackerProjectDetail()}
                projects={[trackerProject()]}
                onBack={jest.fn()}
                onOpenMission={jest.fn()}
                onOpenItem={jest.fn()}
                onMerge={jest.fn()}
            />,
        );
        await press(document.querySelector('[aria-label="Project actions"]'));
        expect((byText('[role="menuitem"]', "Merge into…") as HTMLButtonElement).disabled).toBe(true);
    });

    it("moves a mission from its row's right-click menu, its own project ticked", async () => {
        const onMove = jest.fn().mockResolvedValue(null);
        const container = await mount(
            <ProjectPage
                detail={trackerProjectDetail({
                    missions: [{ ...trackerMission({ num: 1706, title: "Unify", project_id: "pj_1" }) }],
                })}
                projects={[trackerProject(), trackerProject({ id: "pj_2", num: 2, title: "Spring launch" })]}
                onBack={jest.fn()}
                onOpenMission={jest.fn()}
                onOpenItem={jest.fn()}
                onMoveMission={onMove}
            />,
        );
        const row = container.querySelector(".mj_ProjectMission")!;
        await act(async () => {
            row.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
            );
        });
        await press(byText('[role="menuitem"]', "Move to project…"));
        const own = byText('[role="dialog"] [role="listitem"]', "Web/Mac design unification") as HTMLButtonElement;
        expect(own.disabled).toBe(true);
        expect(own.getAttribute("aria-current")).toBe("true");
        await press(byText('[role="dialog"] [role="listitem"]', "Spring launch"));
        expect(onMove).toHaveBeenCalledWith("ms_1", "pj_2");
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
    it("keeps a refused move's sheet open with the reason, and hands focus back to the row on Escape", async () => {
        const onMove = jest.fn().mockResolvedValue("That project is closed, so nothing can move into it.");
        const container = await mount(
            <ProjectPage
                detail={trackerProjectDetail({
                    missions: [{ ...trackerMission({ num: 1706, title: "Unify", project_id: "pj_1" }) }],
                })}
                projects={[trackerProject(), trackerProject({ id: "pj_2", num: 2, title: "Spring launch" })]}
                onBack={jest.fn()}
                onOpenMission={jest.fn()}
                onOpenItem={jest.fn()}
                onMoveMission={onMove}
            />,
        );
        const row = container.querySelector<HTMLElement>(".mj_ProjectMission")!;
        // The context-menu key: no pointer position, so the menu opens at the row.
        await act(async () => {
            row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        });
        const item = byText('[role="menuitem"]', "Move to project…")!;
        expect(document.activeElement).toBe(item);
        await act(async () => {
            item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(row);

        await act(async () => {
            row.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
            );
        });
        await press(byText('[role="menuitem"]', "Move to project…"));
        await press(byText('[role="dialog"] [role="listitem"]', "Spring launch"));
        expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
            "That project is closed, so nothing can move into it.",
        );
    });

    it("closes a row's move sheet when the page swaps to another project", async () => {
        const container = document.createElement("div");
        document.body.append(container);
        const root = createRoot(container);
        const other = trackerProject({ id: "pj_2", num: 2, title: "Spring launch" });
        const page = (shown: ReturnType<typeof trackerProject>): React.ReactElement => (
            <ProjectPage
                detail={trackerProjectDetail({
                    project: shown,
                    missions: [{ ...trackerMission({ num: 1706, title: "Unify", project_id: shown.id }) }],
                })}
                projects={[trackerProject(), other]}
                onBack={jest.fn()}
                onOpenMission={jest.fn()}
                onOpenItem={jest.fn()}
                onMoveMission={jest.fn()}
            />
        );
        await act(async () => root.render(page(trackerProject())));
        const row = container.querySelector(".mj_ProjectMission")!;
        await act(async () => {
            row.dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
            );
        });
        await press(byText('[role="menuitem"]', "Move to project…"));
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        await act(async () => root.render(page(other)));
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it("shows a refused merge in the sheet, back at the choice", async () => {
        const onMerge = jest.fn().mockResolvedValue("Only you or your Coordinator can merge projects.");
        await mount(
            <ProjectPage
                detail={trackerProjectDetail()}
                projects={[trackerProject(), trackerProject({ id: "pj_2", num: 2, title: "Spring launch" })]}
                onBack={jest.fn()}
                onOpenMission={jest.fn()}
                onOpenItem={jest.fn()}
                onMerge={onMerge}
            />,
        );
        await press(document.querySelector('[aria-label="Project actions"]'));
        await press(byText('[role="menuitem"]', "Merge into…"));
        await press(byText('[role="dialog"] [role="listitem"]', "Spring launch"));
        await press(byText('[role="dialog"] button', "Merge"));
        expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("Merge into…");
        expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
            "Only you or your Coordinator can merge projects.",
        );
    });
});
