/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/** Max sent messages remembered per conversation; older ones fall off the front. */
export const SENT_HISTORY_CAP = 50;

/**
 * Per-conversation, in-memory history of the messages sent from this composer, powering
 * terminal-style Up/Down recall. Lives for the page session only (like the desktop app's,
 * which resets on quit) and is never seeded from the timeline: it holds what was sent from
 * here, not every message the conversation has seen. Up walks back from the most recent,
 * Down walks forward, and stepping past the newest restores the draft stashed when the walk
 * began.
 */
export class SentMessageHistory {
    /** Sent messages per conversation, most recent last. */
    private readonly messages = new Map<string, string[]>();
    /** The active walk, if any: which conversation, which entry is shown, and the stashed draft. */
    private walk?: { convoId: string; index: number; stashedDraft: string };

    /**
     * Records a just-sent message. A repeat of the newest entry is collapsed (bash
     * `ignoredups`); the list is capped at SENT_HISTORY_CAP. Recording ends any walk.
     */
    public record(text: string, convoId: string): void {
        this.endRecall();
        const messages = this.messages.get(convoId) ?? [];
        if (messages[messages.length - 1] === text) return;
        messages.push(text);
        if (messages.length > SENT_HISTORY_CAP) messages.splice(0, messages.length - SENT_HISTORY_CAP);
        this.messages.set(convoId, messages);
    }

    public get isNavigating(): boolean {
        return this.walk !== undefined;
    }

    /**
     * Up: the first call stashes `currentDraft` and returns the newest entry; later calls walk
     * toward older ones. Undefined when there is no history or the oldest is already shown.
     */
    public recallOlder(convoId: string, currentDraft: string): string | undefined {
        const messages = this.messages.get(convoId) ?? [];
        if (messages.length === 0) return undefined;
        if (this.walk?.convoId !== convoId) {
            const index = messages.length - 1;
            this.walk = { convoId, index, stashedDraft: currentDraft };
            return messages[index];
        }
        if (this.walk.index === 0) return undefined;
        this.walk.index -= 1;
        return messages[this.walk.index];
    }

    /**
     * Down: the next newer entry, or the stashed draft — ending the walk — on stepping past the
     * newest. Undefined when no walk is active in this conversation.
     */
    public recallNewer(convoId: string): string | undefined {
        if (this.walk?.convoId !== convoId) return undefined;
        const messages = this.messages.get(convoId) ?? [];
        if (this.walk.index < messages.length - 1) {
            this.walk.index += 1;
            return messages[this.walk.index];
        }
        const draft = this.walk.stashedDraft;
        this.endRecall();
        return draft;
    }

    /** Ends the walk (the user edited the field, sent, or left the conversation). Idempotent. */
    public endRecall(): void {
        this.walk = undefined;
    }
}
