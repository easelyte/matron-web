/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * The Projects home's filter field, the same rules as the Apple apps' ProjectsHomeFilter: every
 * typed word must be found, in any order, ignoring case and accents. A project is kept by its
 * title or #num, or by the title or short name of any of its missions (closed ones too); a
 * mission row by its own title, name or #num.
 */

import type { Mission, Project } from "../types";

function fold(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
}

export function filterTerms(query: string): string[] {
    return fold(query).split(/\s+/).filter(Boolean);
}

/** Every term is in at least one of `texts`. */
function matches(terms: string[], texts: string[]): boolean {
    const folded = texts.map(fold);
    return terms.every((term) => folded.some((text) => text.includes(term)));
}

/** A project's missions' titles and short names, open missions first, then by number. */
export function missionTitles(project: Project, missions: Mission[]): string[] {
    return missions
        .filter((mission) => mission.project_id === project.id)
        .sort((a, b) => (a.state !== b.state ? (a.state === "open" ? -1 : 1) : a.num - b.num))
        .flatMap((mission) => [mission.title, mission.name ?? ""])
        .filter(Boolean);
}

export function missionMatches(terms: string[], mission: Mission): boolean {
    return matches(terms, [mission.title, mission.name ?? "", `#${mission.num}`]);
}

export interface FilteredProject {
    project: Project;
    /** Why it is kept when its own title doesn't say: the mission title that matched. */
    matchedMission?: string;
}

/** The projects `terms` name, those named by their own title first. No terms keeps them all. */
export function filterProjects(terms: string[], projects: Project[], missions: Mission[]): FilteredProject[] {
    if (terms.length === 0) return projects.map((project) => ({ project }));
    const byTitle: FilteredProject[] = [];
    const byMission: FilteredProject[] = [];
    for (const project of projects) {
        const own = [project.title, `#${project.num}`];
        if (matches(terms, own)) {
            byTitle.push({ project });
            continue;
        }
        const titles = missionTitles(project, missions);
        if (!matches(terms, [...own, ...titles])) continue;
        // The whole query in one mission, else the mission with a word the project's own title lacks.
        const foldedOwn = own.map(fold);
        const missing = terms.filter((term) => !foldedOwn.some((text) => text.includes(term)));
        const matchedMission =
            titles.find((title) => matches(terms, [title])) ??
            titles.find((title) => missing.some((term) => fold(title).includes(term)));
        byMission.push({ project, matchedMission });
    }
    return [...byTitle, ...byMission];
}
