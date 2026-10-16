/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Filing, after the Mac's: "New project" (NewProjectSheet), "Move to project…" (MoveToProjectMenu)
 * and "Merge into…" with its confirmation (MacProjectPageTopBar). Sheets and menus only: the
 * writes are the host's, through the client.
 */

import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useRowContextMenu } from "../context-menu";
import { CheckIcon } from "../icons";
import { SheetHead, useSheetLifecycle } from "../PinDialogs";
import type { Project } from "../types";

/** The journal's cap on a project title, counted as the Mac counts it (UTF-16 code units). */
export const PROJECT_TITLE_LIMIT = 200;

/** The open projects a mission can move to (every open one; its own is shown ticked). */
export function moveTargets(projects: readonly Project[] | undefined): Project[] {
    return (projects ?? []).filter((project) => project.state === "open");
}

/** "Merge into…" choices: the open projects other than this one, and none when it is closed. */
export function mergeTargets(project: Project, projects: readonly Project[] | undefined): Project[] {
    if (project.state !== "open") return [];
    return (projects ?? []).filter((other) => other.state === "open" && other.id !== project.id);
}

/** A title and an optional line on what it is for. Stays open with the error when the create fails. */
export function NewProjectSheet({
    onCreate,
    onClose,
}: {
    /** Resolves to why it failed, or null once the project exists. */
    onCreate: (title: string, body: string) => Promise<string | null>;
    onClose: () => void;
}): React.ReactElement {
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const mountedRef = useSheetLifecycle(() => {
        if (!creating) onClose();
    });
    const trimmed = title.trim();
    const tooLong = trimmed.length > PROJECT_TITLE_LIMIT;

    const create = async (): Promise<void> => {
        if (!trimmed || tooLong || creating) return;
        setCreating(true);
        setError(null);
        const failure = await onCreate(trimmed, body);
        if (!mountedRef.current) return;
        setCreating(false);
        if (failure) setError(failure);
        else onClose();
    };

    return createPortal(
        <div className="mj_UploadConfirm_scrim" role="dialog" aria-modal="true" aria-labelledby="mj-new-project-title">
            <form
                className="mj_UploadConfirm mj_NewSessionSheet mj_ProjectSheet"
                onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                }}
            >
                <SheetHead id="mj-new-project-title" title="New project" onClose={onClose} />
                <div>
                    <label htmlFor="mj-new-project-name">Title</label>
                    <input
                        id="mj-new-project-name"
                        type="text"
                        value={title}
                        autoFocus
                        autoComplete="off"
                        disabled={creating}
                        onChange={(event) => setTitle(event.target.value)}
                    />
                    {tooLong ? (
                        <p className="mj_ProjectSheet_note">Keep the title to 200 characters or fewer.</p>
                    ) : null}
                </div>
                <div>
                    <label htmlFor="mj-new-project-body">What is it for? (optional)</label>
                    <textarea
                        id="mj-new-project-body"
                        rows={3}
                        value={body}
                        disabled={creating}
                        onChange={(event) => setBody(event.target.value)}
                    />
                </div>
                {error ? (
                    <p className="mj_UploadConfirm_error" role="alert">
                        {error}
                    </p>
                ) : null}
                <div className="mj_UploadConfirm_actions">
                    <button type="button" disabled={creating} onClick={onClose}>
                        Cancel
                    </button>
                    <button type="submit" className="mj_UploadConfirm_send" disabled={creating || !trimmed || tooLong}>
                        {creating ? "Creating…" : "Create"}
                    </button>
                </div>
            </form>
        </div>,
        document.body,
    );
}

/**
 * "Move to project…": every open project, the mission's own ticked and not choosable. No "Not in
 * a project": every mission has a project, and the journal refuses taking one out. A refusal shows
 * in the sheet, which stays open over the pane.
 */
export function MoveToProjectSheet({
    missionLabel,
    currentProjectId,
    targets,
    onMove,
    onClose,
}: {
    missionLabel: string;
    currentProjectId: string | null | undefined;
    targets: readonly Project[];
    /** Resolves to why it did not move, or null once moved. */
    onMove: (projectId: string) => Promise<string | null>;
    onClose: () => void;
}): React.ReactElement {
    const [moving, setMoving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const mountedRef = useSheetLifecycle(onClose);

    const move = async (projectId: string): Promise<void> => {
        if (moving) return;
        setMoving(true);
        setError(null);
        const failure = await onMove(projectId);
        if (!mountedRef.current) return;
        setMoving(false);
        if (failure) setError(failure);
        else onClose();
    };

    return createPortal(
        <div className="mj_UploadConfirm_scrim" role="dialog" aria-modal="true" aria-labelledby="mj-move-project-title">
            <div className="mj_UploadConfirm mj_NewSessionSheet mj_ProjectSheet">
                <SheetHead id="mj-move-project-title" title="Move to project" onClose={onClose} />
                <p>File {missionLabel} in another project.</p>
                <div role="list" aria-label="Projects" className="mj_PinSheet_list">
                    {targets.map((project) => {
                        const current = project.id === currentProjectId;
                        return (
                            <button
                                key={project.id}
                                type="button"
                                role="listitem"
                                className="mj_ProjectSheet_target"
                                aria-current={current ? "true" : undefined}
                                disabled={moving || current}
                                onClick={() => void move(project.id)}
                            >
                                <span className="mj_ProjectSheet_targetTitle">{project.title}</span>
                                {current ? <CheckIcon width={14} height={14} /> : null}
                            </button>
                        );
                    })}
                </div>
                {error ? (
                    <p className="mj_UploadConfirm_error" role="alert">
                        {error}
                    </p>
                ) : null}
                <div className="mj_UploadConfirm_actions">
                    <button type="button" onClick={onClose}>
                        Cancel
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

/**
 * "Merge into…": pick the project, then confirm. Its missions move there and this project closes,
 * so the confirmation names both ends, as the Mac's does. A refusal goes back to the choice with
 * the reason shown in the sheet.
 */
export function MergeProjectSheet({
    project,
    targets,
    onMerge,
    onClose,
}: {
    project: Project;
    targets: readonly Project[];
    /** Resolves to why it did not merge, or null once merged. */
    onMerge: (intoId: string) => Promise<string | null>;
    onClose: () => void;
}): React.ReactElement {
    const [chosenId, setChosenId] = useState<string | null>(null);
    const [merging, setMerging] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The confirmation reads the target from the live list: one that closed or was merged away
    // meanwhile drops out of it, and the sheet goes back to the choice instead of naming it.
    const chosen = chosenId == null ? null : (targets.find((target) => target.id === chosenId) ?? null);
    const mountedRef = useSheetLifecycle(() => {
        if (!merging) onClose();
    });

    const merge = async (): Promise<void> => {
        if (!chosen || merging) return;
        setMerging(true);
        setError(null);
        const failure = await onMerge(chosen.id);
        if (!mountedRef.current) return;
        setMerging(false);
        if (!failure) {
            onClose();
            return;
        }
        setError(failure);
        setChosenId(null);
    };

    const errorNote = error ? (
        <p className="mj_UploadConfirm_error" role="alert">
            {error}
        </p>
    ) : null;

    return createPortal(
        <div
            className="mj_UploadConfirm_scrim"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mj-merge-project-title"
        >
            <div className="mj_UploadConfirm mj_NewSessionSheet mj_ProjectSheet">
                {chosen ? (
                    <>
                        <SheetHead
                            id="mj-merge-project-title"
                            title={`Merge “${project.title}” into “${chosen.title}”?`}
                            onClose={onClose}
                        />
                        <p>Its missions move there and this project closes.</p>
                        <div className="mj_UploadConfirm_actions">
                            <button type="button" autoFocus disabled={merging} onClick={() => setChosenId(null)}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="mj_UploadConfirm_send mj_ProjectSheet_danger"
                                disabled={merging}
                                onClick={() => void merge()}
                            >
                                {merging ? "Merging…" : "Merge"}
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        <SheetHead id="mj-merge-project-title" title="Merge into…" onClose={onClose} />
                        <p>Choose the project “{project.title}” goes into.</p>
                        <div role="list" aria-label="Projects" className="mj_PinSheet_list">
                            {targets.map((target) => (
                                <button
                                    key={target.id}
                                    type="button"
                                    role="listitem"
                                    className="mj_ProjectSheet_target"
                                    onClick={() => {
                                        setError(null);
                                        setChosenId(target.id);
                                    }}
                                >
                                    <span className="mj_ProjectSheet_targetTitle">{target.title}</span>
                                </button>
                            ))}
                        </div>
                        {errorNote}
                        <div className="mj_UploadConfirm_actions">
                            <button type="button" onClick={onClose}>
                                Cancel
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>,
        document.body,
    );
}

type MoveRow = { id: string; num: number; project_id?: string | null };

/**
 * The right-click move flow for a list of mission rows (the Mac's row context menu), on the
 * app's shared row menu: right-click, the context-menu key or a long press opens one "Move to
 * project…" entry, and Escape hands focus back to the row. `rowProps(mission)` goes on each row;
 * the returned `layer` renders the menu and the sheet. `scope` names the list (the project page's
 * project): a sheet opened under another scope is not shown, so a page swapped in place never
 * offers to move a mission from the project that went away. Without `onMove` rows get no menu.
 */
export function useRowMove(
    projects: readonly Project[] | undefined,
    onMove: ((missionId: string, projectId: string) => Promise<string | null>) | undefined,
    scope: string | null = null,
): {
    rowProps: (mission: MoveRow) => Record<string, unknown>;
    layer: React.ReactNode;
} {
    const menu = useRowContextMenu<MoveRow>();
    const rows = useRef(new Map<string, HTMLElement>());
    const [sheet, setSheet] = useState<{ mission: MoveRow; scope: string | null } | null>(null);
    const targets = moveTargets(projects);
    if (!onMove) return { rowProps: () => ({}), layer: null };
    const rowProps = (mission: MoveRow): Record<string, unknown> => ({
        ref: (node: HTMLElement | null) => {
            if (node) rows.current.set(mission.id, node);
            else rows.current.delete(mission.id);
        },
        ...menu.rowHandlers(mission, () => rows.current.get(mission.id) ?? null),
    });
    const target = menu.state?.target;
    const layer = (
        <>
            {menu.state && target
                ? createPortal(
                      <div
                          ref={menu.menuRef}
                          className="mj_TrackerMenu_list mj_RowMoveMenu"
                          role="menu"
                          style={{ left: menu.state.left, top: menu.state.top }}
                          onKeyDown={menu.menuKeyDown}
                      >
                          <button
                              type="button"
                              role="menuitem"
                              className="mj_TrackerMenu_item"
                              disabled={!targets.some((project) => project.id !== target.project_id)}
                              onClick={() => {
                                  menu.close();
                                  setSheet({ mission: target, scope });
                              }}
                          >
                              Move to project…
                          </button>
                      </div>,
                      document.body,
                  )
                : null}
            {sheet && sheet.scope === scope ? (
                <MoveToProjectSheet
                    missionLabel={`#${sheet.mission.num}`}
                    currentProjectId={sheet.mission.project_id}
                    targets={targets}
                    onMove={(projectId) => onMove(sheet.mission.id, projectId)}
                    onClose={() => setSheet(null)}
                />
            ) : null}
        </>
    );
    return { rowProps, layer };
}
