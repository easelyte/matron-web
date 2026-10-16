// "Go to number": jump to a tracker item, mission, milestone or project by its number. The four
// kinds share one per-user number space, so the journal is asked which kind a number names
// (client.lookupNumber) before anything opens. The same lookup puts an exact match at the top of
// the sidebar search when the query is just a number.

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { MatronJournalClient } from "./client";
import { SheetHead, useSheetLifecycle } from "./PinDialogs";
import type { NumberLookup, NumberLookupKind, NumberLookupOutcome } from "./types";

/** Keystrokes settle for this long before the search box asks the journal about a number. */
export const NUMBER_SEARCH_DEBOUNCE_MS = 200;

/** "412", "#412" or " # 412 " → 412; anything that is not just a positive number → null. */
export function parseTrackerNumber(text: string): number | null {
    const match = /^#?\s*([0-9]{1,15})$/.exec(text.trim());
    if (!match) return null;
    const num = Number(match[1]);
    return Number.isSafeInteger(num) && num > 0 ? num : null;
}

const KIND_LABEL: Record<NumberLookupKind, string> = {
    item: "Item",
    mission: "Mission",
    milestone: "Milestone",
    project: "Project",
};

/** True for the shortcut that opens the field: ⌘J on a Mac, Ctrl+J elsewhere. */
export function isGoToNumberShortcut(
    event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
    mac: boolean,
): boolean {
    if (event.altKey || event.shiftKey || event.key.toLowerCase() !== "j") return false;
    return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform);

/** The shortcut's name for a button tooltip. */
export const goToNumberShortcutLabel = (): string => (isMac() ? "⌘J" : "Ctrl+J");

/** Binds the shortcut for as long as the host is mounted; `enabled` false leaves the key alone. */
export function useGoToNumberShortcut(client: MatronJournalClient, enabled: boolean): void {
    useEffect(() => {
        if (!enabled) return undefined;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.defaultPrevented || !isGoToNumberShortcut(event, isMac())) return;
            event.preventDefault();
            client.openGoToNumber();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [client, enabled]);
}

/**
 * Asks the journal what `num` is once the text has settled, and answers `undefined` until the
 * journal has spoken for the number held now: an answer for an earlier number never shows.
 */
function useNumberLookup(client: MatronJournalClient, num: number | null): NumberLookupOutcome | undefined {
    const [answer, setAnswer] = useState<{ num: number; outcome: NumberLookupOutcome }>();

    useEffect(() => {
        if (num === null) return undefined;
        const controller = new AbortController();
        let current = true;
        const timer = setTimeout(() => {
            void client.lookupNumber(num, controller.signal).then((outcome) => {
                if (current) setAnswer({ num, outcome });
            });
        }, NUMBER_SEARCH_DEBOUNCE_MS);
        return () => {
            current = false;
            clearTimeout(timer);
            controller.abort();
        };
    }, [client, num]);

    return num !== null && answer?.num === num ? answer.outcome : undefined;
}

/** A milestone whose mission is unknown has nowhere to go. */
const canOpen = (hit: NumberLookup): boolean => hit.kind !== "milestone" || Boolean(hit.mission);

/** The found row, shared by the dialog and the sidebar search. */
function NumberHitRow({
    hit,
    num,
    onOpen,
}: {
    hit: NumberLookup;
    num: number;
    onOpen: () => void;
}): React.ReactElement {
    const label = `${KIND_LABEL[hit.kind]} #${hit.num ?? num}`;
    return (
        <button
            type="button"
            className="mj_SearchHit"
            aria-label={`Go to ${label}${hit.title ? `: ${hit.title}` : ""}`}
            onClick={onOpen}
        >
            <span className="mj_SearchHit_top">
                <span className="mj_SearchHit_title">{label}</span>
            </span>
            {hit.title ? <span className="mj_SearchHit_snippet">{hit.title}</span> : null}
        </button>
    );
}

/**
 * The field answers as it is typed: the row the number names appears under it, and Enter, Go or
 * the row itself opens it. A number nothing carries says so in the same place.
 */
export function GoToNumberDialog({ client }: { client: MatronJournalClient }): React.ReactElement {
    const onClose = (): void => client.closeGoToNumber();
    const [text, setText] = useState("");
    // Enter can beat the debounce, and retries a failed lookup: the answer it fetched itself.
    const [asked, setAsked] = useState<{ num: number; outcome: NumberLookupOutcome }>();
    const mountedRef = useSheetLifecycle(onClose);
    const num = parseTrackerNumber(text);
    const typed = useNumberLookup(client, num);
    const outcome = asked && asked.num === num ? asked.outcome : typed;

    const open = (hit: NumberLookup, forNum: number): void => {
        if (canOpen(hit) && client.openNumberHit(hit, forNum)) onClose();
    };

    const go = async (): Promise<void> => {
        if (num === null) return;
        let known = outcome;
        // Go on a failed lookup tries again.
        if (!known || known.status === "failed") {
            known = await client.lookupNumber(num);
            if (!mountedRef.current) return;
            setAsked({ num, outcome: known });
        }
        if (known.status === "found") open(known.hit, num);
    };

    let result: React.ReactNode = null;
    if (num !== null && !outcome) {
        result = (
            <p className="mj_GoToSheet_note" id="mj-goto-message" role="status">
                Looking…
            </p>
        );
    } else if (num !== null && outcome?.status === "none") {
        result = (
            <p className="mj_GoToSheet_note" id="mj-goto-message" role="status">
                Nothing is numbered {num}.
            </p>
        );
    } else if (num !== null && outcome?.status === "failed") {
        result = (
            <p className="mj_UploadConfirm_error" id="mj-goto-message" role="alert">
                Couldn't look up #{num}. Try again in a moment.
            </p>
        );
    } else if (num !== null && outcome?.status === "found") {
        const { hit } = outcome;
        result = canOpen(hit) ? (
            <NumberHitRow hit={hit} num={num} onOpen={() => open(hit, num)} />
        ) : (
            <p className="mj_GoToSheet_note" id="mj-goto-message" role="status">
                #{num} is a milestone, and its mission can't be opened here.
            </p>
        );
    }

    return createPortal(
        <div className="mj_UploadConfirm_scrim" role="dialog" aria-modal="true" aria-labelledby="mj-goto-title">
            <form
                className="mj_UploadConfirm mj_NewSessionSheet mj_GoToSheet"
                onSubmit={(event) => {
                    event.preventDefault();
                    void go();
                }}
            >
                <SheetHead id="mj-goto-title" title="Go to number" onClose={onClose} />
                <div>
                    <label htmlFor="mj-goto-number">Item, mission or project number</label>
                    <input
                        id="mj-goto-number"
                        type="text"
                        inputMode="numeric"
                        value={text}
                        maxLength={17}
                        autoFocus
                        autoComplete="off"
                        placeholder="#"
                        aria-describedby="mj-goto-result"
                        onChange={(event) => setText(event.target.value)}
                    />
                </div>
                <div className="mj_GoToSheet_result" id="mj-goto-result" data-testid="goto-result">
                    {result}
                </div>
                <div className="mj_UploadConfirm_actions">
                    <button type="button" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        type="submit"
                        className="mj_UploadConfirm_send"
                        disabled={num === null || outcome?.status === "none"}
                    >
                        Go
                    </button>
                </div>
            </form>
        </div>,
        document.body,
    );
}

/**
 * The exact match for a search that is just a number: one row, above the chat list, opening the
 * item, mission or project that carries it. Rows that merely mention the number still come from
 * the title filter and the message search below. Nothing renders for any other query, for a
 * number nothing carries, or when the journal cannot be asked.
 */
export function NumberSearchResult({
    client,
    query,
}: {
    client: MatronJournalClient;
    query: string;
}): React.ReactElement | null {
    const num = parseTrackerNumber(query);
    const outcome = useNumberLookup(client, num);

    if (num === null || outcome?.status !== "found" || !canOpen(outcome.hit)) return null;
    const { hit } = outcome;
    return (
        <div className="mj_SearchResults mj_NumberSearchResult" data-testid="number-search-result">
            <div className="mj_SearchResults_heading" role="presentation">
                Go to
            </div>
            <NumberHitRow hit={hit} num={num} onOpen={() => client.openNumberHit(hit, num)} />
        </div>
    );
}
