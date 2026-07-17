# Upload Confirmation Modal with Caption — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — pick by plan signals (frontmatter + scope):
> - **Typical plan** (no `risk: high`, no auth/RLS/payments/data-loss surfaces): `/execute-slim` — implementer per task, Codex review per phase boundary, /ship-slim at end.
> - **Heavy plan** (R100, `risk: high`, auth/RLS/payments/data-loss): `/execute-heavy-codex` — per-task implementer + spec-compliance + quality + fix-mode chain via Codex, Sonnet only at every 5th phase + end-of-plan.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Picking/dragging/pasting a file opens a confirmation modal (preview + caption); Send ships file + caption as ONE journal event, and the bridge delivers both to Claude in one turn.

**Architecture:** Two repos. (1) `easelyte/matron-web` (`/opt/matron/web-journal`, branch `feat/upload-caption-modal`, base `main`): caption threads through the PR #1 attachment pipeline via one shared payload builder; a staged-uploads state machine (item-identity queue, synchronous `confirming` lock, persist-then-advance, serialized send chain with execution-time guards) feeds a new app-modal `UploadConfirmDialog`. (2) `easelyte/claude-matrix-bridge` @ `journal-deploy` (`/opt/matron/bridge-journal`): input router extracts+clamps `payload.caption`; media orchestrator threads it to `buildSavedBlocks` and tail-appends a caption text block when the iv branch didn't fold it (the live default is non-iv). Journal server: zero change (opaque payload).

**Tech Stack:** React 18 (custom journal client, no framework dialogs), TypeScript, jest + @testing-library-style DOM tests (`corepack pnpm test`), IndexedDB outbox; bridge is plain Node ESM with vitest.

**Spec:** `docs/superpowers/specs/2026-07-17-web-upload-caption-modal-design.md` (rev 6, approved, 5 review rounds). The spec is the contract; this plan implements it 1:1 with one noted refinement (T-4.2: the SDK-mode tail-append lives in `lib/journal-media.js` `routeOne` rather than the `index.js` wiring closure — identical observable contract, unit-testable location).

## Global Constraints

- Cross-repo discipline: drive both repos BY PATH (`git -C`, subshell `cd`); never `cd` the session. Web work on branch `feat/upload-caption-modal`; bridge work on a new branch off `journal-deploy`.
- Commits authored `easelyte <fantin@easelyte.ai>`. Never push to Matronhq remotes (web repo has `upstream` = Matronhq — do not touch).
- Wire contract: `payload.caption` present ONLY when non-empty after trim (web-side trim→omit decided once in the modal); bridge re-trims + clamps to 4096 at its boundary.
- No-caption sends must remain byte-identical to today's payloads (regression guard).
- `BROWSER_MEMORY_SAFETY_MAX_BYTES` (512MB) has ONE owner: exported from `client.ts`, imported by the modal (P2).
- Both PRs are HELD for operator review (no auto-merge). Deploy order: bridge first (Delivery §5-7 of the spec).
- Bridge test gate: `npm test` (vitest) green in `/opt/matron/bridge-journal` pre-merge AND on the merged SHA before any service restart (R702).
- Frontend work (Phase 3) applies the `frontend-design` skill at execute time for the modal's visual design; classes `mj_UploadConfirm*`, style echoing the auth-modal panel + full-screen scrim.

## File Structure

**matron-web** (`/opt/matron/web-journal`):
- Modify `src/journal/types.ts` — `PendingMessage.caption`, `StagedUploads`/`StagedUploadItem` types, `ClientState.stagedUploads`, `eventSnippet` caption preference.
- Modify `src/journal/client.ts` — export size constant; `attachmentPayload` helper (both emit sites); `sendAttachment(file, convoId, caption?)` recomposed into persist/upload phases; staging API (`stageFiles`, `confirmStagedFile`, `skipStagedFile`, `cancelStagedFiles`); serialized send chain.
- Modify `src/journal/components.tsx` — new `UploadConfirmDialog`; entry-point rewires + structural guards; file-tile caption; chip caption + `errorMessage` preference.
- Modify `src/journal/journal.pcss` — `mj_UploadConfirm*` styles.
- Modify `test/unit-tests/journal/{types-test.ts,client-test.ts,components-test.ts}`.

**bridge** (`/opt/matron/bridge-journal`):
- Modify `lib/journal-input-router.js` — caption extraction + clamp.
- Modify `lib/journal-media.js` — thread caption; accept `{blocks, ivHandled}` seam; SDK-mode tail-append.
- Modify `index.js` (~5911-5928) — pass `caption`→`ivCaption`, return the `{blocks, ivHandled}` object.
- Modify `test/{journal-input-router.test.js,journal-media.test.js}`.

## Task Dependency Graph

- Phase 1 → Phase 2 → Phase 3 (web, sequential: types → client machine → UI).
- Phase 4 (bridge) is independent of Phases 1-3; can run any time before Phase 5.
- Phase 5 (verification + PRs) last.

---

## Phase 1 — Web caption plumbing (types + payload)

### T-1.1: Caption on PendingMessage + staged-uploads types + snippet preference

**Files:**
- Modify: `src/journal/types.ts`
- Test: `test/unit-tests/journal/types-test.ts`

**Interfaces:**
- Consumes: nothing (leaf task).
- Produces: `PendingMessage.caption?: string`; `StagedUploadItem { id: string; file: File; message?: PendingMessage }`; `StagedUploads { convoId: string; items: StagedUploadItem[]; total: number; confirming: boolean; error?: "archived"; persistError?: boolean }`; `ClientState.stagedUploads?: StagedUploads`; `eventSnippet` prefers `payload.caption` for file/image.

- [ ] **Step 1: Write the failing tests** — append to `test/unit-tests/journal/types-test.ts`:

```ts
describe("eventSnippet captions", () => {
    it("prefers the caption over the filename for image and file snippets", () => {
        expect(eventSnippet("image", { filename: "shot.png", caption: "what is wrong here?" })).toBe(
            "🖼 what is wrong here?",
        );
        expect(eventSnippet("file", { filename: "notes.txt", caption: "read this first" })).toBe(
            "📎 read this first",
        );
    });

    it("falls back to the filename when no caption is present", () => {
        expect(eventSnippet("image", { filename: "shot.png" })).toBe("🖼 shot.png");
        expect(eventSnippet("file", { filename: "notes.txt", caption: "" })).toBe("📎 notes.txt");
    });
});
```

(If `types-test.ts` does not already import `eventSnippet`, add it to the existing import from `../../../src/journal/types`.)

- [ ] **Step 2: Run to verify failure**

Run: `(cd /opt/matron/web-journal && corepack pnpm test -- types-test)`
Expected: FAIL — snippets come back as `🖼 shot.png` (caption ignored).

- [ ] **Step 3: Implement in `src/journal/types.ts`**

(a) `PendingMessage` gains one optional field (after `contentType?`):

```ts
    caption?: string;
```

(b) Add staged-upload types (above `ClientState`):

```ts
export interface StagedUploadItem {
    id: string;
    file: File;
    /** Built on first confirm attempt; reused by persist retries so a page has ONE row identity. */
    message?: PendingMessage;
}

export interface StagedUploads {
    convoId: string;
    items: StagedUploadItem[];
    /** Cumulative count ever staged into this queue (paste-append increments). Header: "File k of N", k = total - items.length + 1. */
    total: number;
    /** P23 transient-submission lock: set synchronously at confirm entry; all modal actions inert while true. */
    confirming: boolean;
    /** Terminal invalidation notice (items cleared, error page shown). */
    error?: "archived";
    /** Non-terminal persist failure: page kept, inline error shown, Send retries. */
    persistError?: boolean;
}
```

(c) `ClientState` gains (after `dragActive: boolean;`):

```ts
    stagedUploads?: StagedUploads;
```

(d) `eventSnippet` file/image cases become:

```ts
    if (type === "file") return `📎 ${asString(payload.caption) || asString(payload.filename, "File")}`.slice(0, 120);
    if (type === "image") return `🖼 ${asString(payload.caption) || asString(payload.filename, "Image")}`.slice(0, 120);
```

- [ ] **Step 4: Run to verify pass**

Run: `(cd /opt/matron/web-journal && corepack pnpm test -- types-test)`
Expected: PASS (all pre-existing types tests stay green).

- [ ] **Step 5: Commit**

```bash
git -C /opt/matron/web-journal add src/journal/types.ts test/unit-tests/journal/types-test.ts
git -C /opt/matron/web-journal -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(types): caption field, staged-upload state types, caption-first snippets"
```

### T-1.2: Shared attachment payload builder + caption through send/retry/replay

**Files:**
- Modify: `src/journal/client.ts`
- Test: `test/unit-tests/journal/client-test.ts`

**Interfaces:**
- Consumes: `PendingMessage.caption` (T-1.1).
- Produces: `export const BROWSER_MEMORY_SAFETY_MAX_BYTES` (moved from `const` to exported); private `attachmentPayload(message: PendingMessage): Record<string, unknown>` used by BOTH `emitPendingAttachment` and `sendPendingMessage`; `sendAttachment(file: File, convoId: string, caption?: string)` stores the caption on the row.

- [ ] **Step 1: Write the failing tests** — append to the attachment describe-block in `client-test.ts` (reuse the existing `fakeDatabase`/`internals`/`signedInState`/`fileFixture` helpers already in that file):

```ts
    it("includes the caption in the WS payload and omits the key when absent", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const send = jest.fn().mockReturnValue(true);
        state.state = signedInState(client);
        state.database = fakeDatabase({});
        state.api = {
            messages: jest.fn().mockResolvedValue({ events: [] }),
            uploadMedia: jest.fn().mockResolvedValue({ media_id: "media-1" }),
        };
        state.connection = { send };

        await client.sendAttachment(fileFixture("shot.png", "image/png", [1, 2]), "c1", "look at this");
        await client.sendAttachment(fileFixture("plain.png", "image/png", [3]), "c1");

        const framesWithCaption = send.mock.calls.filter(([frame]) => frame.op === "send" && frame.payload?.caption);
        expect(framesWithCaption).toHaveLength(1);
        expect(framesWithCaption[0][0].payload).toEqual(
            expect.objectContaining({ caption: "look at this", filename: "shot.png" }),
        );
        const bare = send.mock.calls.find(([frame]) => frame.payload?.filename === "plain.png");
        expect(bare?.[0].payload).not.toHaveProperty("caption");
    });

    it("re-sends the caption on reconnect replay (sendPendingMessage path)", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const send = jest.fn().mockReturnValue(true);
        const row: PendingMessage = {
            localId: "L1",
            convoId: "c1",
            body: "",
            createdAt: 1,
            kind: "image",
            filename: "shot.png",
            size: 2,
            contentType: "image/png",
            blobRef: "media-1",
            attachState: "sending",
            caption: "look at this",
        };
        state.state = signedInState(client);
        state.database = fakeDatabase({ outbox: jest.fn().mockResolvedValue([row]) });
        state.connection = { send };

        await (client as unknown as { handleReady: () => Promise<void> }).handleReady();

        expect(send).toHaveBeenCalledWith(
            expect.objectContaining({
                op: "send",
                type: "image",
                payload: expect.objectContaining({ caption: "look at this", local_id: "L1" }),
            }),
        );
    });
```

(Match the surrounding tests' exact helper signatures — e.g. if `fakeDatabase` requires a full shape, copy the neighboring test's construction. `handleReady` may need the same connection stub shape the existing reconnect tests use; mirror them.)

- [ ] **Step 2: Run to verify failure**

Run: `(cd /opt/matron/web-journal && corepack pnpm test -- client-test)`
Expected: FAIL — `sendAttachment` has no third parameter / payload lacks `caption`.

- [ ] **Step 3: Implement in `src/journal/client.ts`**

(a) Export the constant (line ~35): `export const BROWSER_MEMORY_SAFETY_MAX_BYTES = 512 * 1024 * 1024;`

(b) Add the single payload builder (near `emitPendingAttachment`):

```ts
    private attachmentPayload(message: PendingMessage): Record<string, unknown> {
        return {
            blob_ref: message.blobRef,
            name: message.filename,
            filename: message.filename,
            content_type: message.contentType,
            size: message.size,
            local_id: message.localId,
            ...(message.caption ? { caption: message.caption } : {}),
        };
    }
```

(c) `emitPendingAttachment`: replace the inline `payload: { blob_ref: ..., local_id: message.localId }` object with `payload: this.attachmentPayload(message)` (keep the surrounding frame fields `op/convo_id/type/blob_ref/local_id` untouched).

(d) `sendPendingMessage` image/file branch: replace its inline payload object with `payload: this.attachmentPayload(message)` likewise.

(e) `sendAttachment` signature becomes `public async sendAttachment(file: File, convoId: string, caption?: string): Promise<void>` and the constructed `PendingMessage` gains `...(caption ? { caption } : {})` in its literal. (No other behavior change in this task — the phase split is T-2.1.)

- [ ] **Step 4: Run to verify pass**

Run: `(cd /opt/matron/web-journal && corepack pnpm test -- client-test)`
Expected: PASS, including all pre-existing attachment tests (byte-identical no-caption payloads).

- [ ] **Step 5: Commit**

```bash
git -C /opt/matron/web-journal add src/journal/client.ts test/unit-tests/journal/client-test.ts
git -C /opt/matron/web-journal -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(client): shared attachmentPayload carries caption on send, retry, and reconnect replay"
```

---

## Phase 2 — Staged-uploads state machine (client)

### T-2.1: Split sendAttachment into persist / upload phases (behavior-preserving)

**Files:**
- Modify: `src/journal/client.ts`
- Test: `test/unit-tests/journal/client-test.ts` (existing suite is the regression gate; one new test)

**Interfaces:**
- Consumes: T-1.2's `sendAttachment(file, convoId, caption?)`.
- Produces (private, used by T-2.2/T-2.3):
  - `buildPendingAttachment(file: File, convoId: string, caption?: string): PendingMessage`
  - `persistPendingAttachment(message: PendingMessage, file: File, db: JournalDatabase, gen: number): Promise<boolean>` — size/empty guards, `pendingFiles.set`, `persistAttachment`, then `refreshSelectedConversation` (live chip visibility); returns `true` only when the row is persisted in `uploading` state.
  - `runPendingUpload(message: PendingMessage, file: File, owner: AttachmentOwner): Promise<void>` — phase (b): `uploadPendingAttachment` with the original catch semantics.

- [ ] **Step 1: Write the failing test** (live visibility — spec Testing #6 first half):

```ts
    it("persists and shows a pending chip before the upload phase runs", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        let releaseUpload: (() => void) | undefined;
        const uploadMedia = jest.fn().mockImplementation(
            () =>
                new Promise((resolve) => {
                    releaseUpload = () => resolve({ media_id: "media-1" });
                }),
        );
        state.state = signedInState(client);
        const { database } = attachmentDatabase(); // stateful — outbox() must return persisted rows
        state.database = database;
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send: jest.fn().mockReturnValue(true) };

        const inFlight = client.sendAttachment(fileFixture("slow.bin", "application/octet-stream", [1]), "c1");
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(client.getSnapshot().pendingMessages).toEqual([
            expect.objectContaining({ filename: "slow.bin", attachState: "uploading" }),
        ]);
        releaseUpload?.();
        await inFlight;
    });
```

- [ ] **Step 2: Run to verify failure or pass** — this may already pass (today's optimistic refresh races the upload); the load-bearing outcome of this task is the refactor with the FULL suite green. Run: `(cd /opt/matron/web-journal && corepack pnpm test -- client-test)` and note the baseline. **ROUND-1 FIX (M1): the Step-1 test must use the suite's stateful `attachmentDatabase()` helper (the established pattern at 20+ sites), NOT `fakeDatabase({})` — the plain stub's `outbox()` always resolves `[]`, so `refreshSelectedConversation` would never surface the chip and the test fails regardless of implementation.** Same substitution applies to every T-2.3 test below that asserts on `pendingMessages` or outbox contents.

- [ ] **Step 3: Refactor `sendAttachment` into the three privates**

```ts
    private buildPendingAttachment(file: File, convoId: string, caption?: string): PendingMessage {
        return {
            localId: crypto.randomUUID(),
            convoId,
            body: "",
            createdAt: Date.now(),
            kind: file.type.startsWith("image/") ? "image" : "file",
            filename: file.name,
            size: file.size,
            contentType: file.type || "application/octet-stream",
            blobRef: null,
            attachState: "uploading",
            ...(caption ? { caption } : {}),
        };
    }

    private async persistPendingAttachment(
        message: PendingMessage,
        file: File,
        db: JournalDatabase,
        gen: number,
    ): Promise<boolean> {
        if (file.size > BROWSER_MEMORY_SAFETY_MAX_BYTES || file.size === 0) {
            message.attachState = "error";
            message.errorKind = file.size > BROWSER_MEMORY_SAFETY_MAX_BYTES ? "browser_memory_limit" : "empty";
            if (!(await this.persistAttachment(message, db, gen))) return false;
            if (this.sessionGen !== gen) return false;
            await this.refreshSelectedConversation(message.convoId, db, gen).catch(() => undefined);
            return false;
        }
        this.pendingFiles.set(message.localId, file);
        if (!(await this.persistAttachment(message, db, gen))) return false;
        if (this.sessionGen !== gen || this.database !== db) return false;
        return message.attachState === "uploading";
    }
```

ROUND-1 FIX (M2): the persist phase does NOT await a refresh — today's
`sendAttachment` runs the optimistic refresh CONCURRENT with the upload
(`Promise.all`, `client.ts:449-456`) and the recomposition below preserves
exactly that shape. The invalid-file branch keeps its awaited refresh
(matches today's error path).

```ts

    private async runPendingUpload(message: PendingMessage, file: File, owner: AttachmentOwner): Promise<void> {
        if (!this.ownsAttachment(owner, message.localId)) return;
        try {
            await this.uploadPendingAttachment(message, file, owner);
        } catch {
            if (
                !this.ownsAttachment(owner, message.localId) ||
                message.attachState !== "uploading" ||
                this.inFlightUploads.has(message.localId)
            ) {
                return;
            }
            message.attachState = "error";
            message.errorKind = "upload_failed";
            if (!(await this.persistAttachment(message, owner.db, owner.gen))) return;
            try {
                await this.refreshSelectedConversation(message.convoId, owner.db, owner.gen);
            } catch {
                if (this.ownsAttachment(owner, message.localId) && this.state.selectedConversationId === message.convoId) {
                    const pendingMessages = this.state.pendingMessages.filter(
                        (pending) => pending.localId !== message.localId,
                    );
                    this.patch({ pendingMessages: [...pendingMessages, { ...message, canRetry: true }] });
                }
            }
        }
    }

    public async sendAttachment(file: File, convoId: string, caption?: string): Promise<void> {
        const gen = this.sessionGen;
        const api = this.api;
        const db = this.database;
        if (!api || !db) return;
        const owner = { gen, api, db };
        const message = this.buildPendingAttachment(file, convoId, caption);
        if (!(await this.persistPendingAttachment(message, file, db, gen))) return;
        const optimisticRefresh = this.refreshSelectedConversation(convoId, db, gen).catch(() => undefined);
        await Promise.all([optimisticRefresh, this.runPendingUpload(message, file, owner)]);
    }
```

(Refresh and upload run concurrently — byte-for-byte today's `Promise.all`
semantics; the upload is not delayed behind the refresh.)

Delete the old `sendAttachment` body it replaces. Do NOT touch `uploadPendingAttachment`, `emitPendingAttachment`, `retryAttachment`, `dismissAttachment`, `attachFiles`.

- [ ] **Step 4: Run the FULL suite**

Run: `(cd /opt/matron/web-journal && corepack pnpm test -- client-test)`
Expected: PASS — every pre-existing attachment/regression test green (this is the gate that the split is behavior-preserving), plus Step 1's test.

- [ ] **Step 5: Commit**

```bash
git -C /opt/matron/web-journal add src/journal/client.ts test/unit-tests/journal/client-test.ts
git -C /opt/matron/web-journal -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "refactor(client): split sendAttachment into persist and upload phases (behavior-preserving)"
```

### T-2.2: Staging queue — stageFiles / cancelStagedFiles / session teardown

**Files:**
- Modify: `src/journal/client.ts`
- Test: `test/unit-tests/journal/client-test.ts`

**Interfaces:**
- Consumes: `StagedUploads` types (T-1.1).
- Produces: `stageFiles(files: File[]): void` (branch precedence: open-queue append first, keyed off `stagedUploads.convoId`, inert on `error`; selection guard only when opening); `cancelStagedFiles(): void`; `startSession` clears staging and resets `stagedSendChain`; private `stagedSendChain: Promise<void>` field and `stagedConvoValid(convoId: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("staged uploads queue", () => {
    const stagedFile = (name: string): File => fileFixture(name, "image/png", [1]);

    it("opens a queue for the selected conversation and appends while open (ignoring live selection)", () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        state.state = signedInState(client); // selectedConversationId: "c1"

        client.stageFiles([stagedFile("a.png"), stagedFile("b.png")]);
        let staged = client.getSnapshot().stagedUploads;
        expect(staged?.convoId).toBe("c1");
        expect(staged?.items).toHaveLength(2);
        expect(staged?.total).toBe(2);
        expect(staged?.confirming).toBe(false);
        expect(new Set(staged?.items.map((item) => item.id)).size).toBe(2);

        // cross-tab clearSelection must not break paste-append
        state.state = { ...state.state, selectedConversationId: undefined, stagedUploads: staged };
        client.stageFiles([stagedFile("c.png")]);
        staged = client.getSnapshot().stagedUploads;
        expect(staged?.items).toHaveLength(3);
        expect(staged?.total).toBe(3);
        expect(staged?.convoId).toBe("c1");
    });

    it("no-ops when opening with no conversation selected, and cancel-all clears the queue", () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        state.state = { ...signedInState(client), selectedConversationId: undefined };
        client.stageFiles([stagedFile("a.png")]);
        expect(client.getSnapshot().stagedUploads).toBeUndefined();

        state.state = signedInState(client);
        client.stageFiles([stagedFile("a.png")]);
        client.cancelStagedFiles();
        expect(client.getSnapshot().stagedUploads).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `(cd /opt/matron/web-journal && corepack pnpm test -- client-test)`
Expected: FAIL — `stageFiles` does not exist.

- [ ] **Step 3: Implement**

Fields (near `pendingFiles`): `private stagedSendChain: Promise<void> = Promise.resolve();`

```ts
    public stageFiles(files: File[]): void {
        if (files.length === 0) return;
        const staged = this.state.stagedUploads;
        if (staged) {
            if (staged.error) return;
            this.patch({
                stagedUploads: {
                    ...staged,
                    items: [...staged.items, ...files.map((file) => ({ id: crypto.randomUUID(), file }))],
                    total: staged.total + files.length,
                },
            });
            return;
        }
        const convoId = this.state.selectedConversationId;
        if (!convoId) return;
        this.patch({
            stagedUploads: {
                convoId,
                items: files.map((file) => ({ id: crypto.randomUUID(), file })),
                total: files.length,
                confirming: false,
            },
        });
    }

    public cancelStagedFiles(): void {
        const staged = this.state.stagedUploads;
        if (!staged) return;
        // ROUND-2 FIX (Codex M1): the confirming lock guards ALL mutations at
        // the client boundary, not just via disabled buttons — a cancel racing
        // an in-flight persist could otherwise strand a persisted row whose
        // upload thunk was never scheduled.
        if (staged.confirming) return;
        this.patch({ stagedUploads: undefined });
    }

    private stagedConvoValid(convoId: string): boolean {
        return (
            this.state.conversations.some((conversation) => conversation.id === convoId) &&
            !this.state.archivedIds.has(convoId)
        );
    }
```

`startSession` additions (with the other teardown lines near `this.pendingFiles.clear()`): `this.stagedSendChain = Promise.resolve();` (staging state itself is wiped by the `blankState()` rebuild already in `startSession`; verify `blankState()` leaves `stagedUploads` undefined).

- [ ] **Step 4: Run to verify pass** — `(cd /opt/matron/web-journal && corepack pnpm test -- client-test)` → PASS.

- [ ] **Step 5: Commit**

```bash
git -C /opt/matron/web-journal add src/journal/client.ts test/unit-tests/journal/client-test.ts
git -C /opt/matron/web-journal -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(client): staged-uploads queue (stage/append/cancel) with item identity and total accounting"
```

### T-2.3: confirmStagedFile / skipStagedFile — locks, guards, serialized chain

**Files:**
- Modify: `src/journal/client.ts`
- Test: `test/unit-tests/journal/client-test.ts`

**Interfaces:**
- Consumes: T-2.1 phases, T-2.2 queue, `stagedConvoValid`.
- Produces: `confirmStagedFile(itemId: string, caption?: string): Promise<void>`; `skipStagedFile(itemId: string): void`. Contract (spec Staging state §1-4): synchronous `confirming` reservation; confirm-time convo check → `error: "archived"`; bounded persist (5s) with same-row-identity retry (`item.message` reuse) and `persistError` on failure; advance only on persist success; upload deferred on `stagedSendChain` with execution-time session-gen + convo guards, invalidation → `upload_failed` + `errorMessage`, per-thunk rejection isolation.

- [ ] **Step 1: Write the failing tests** (spec Testing #4, #5, #7, #8, #9, #10, #11, #12 — client half):

```ts
    const PERSIST_TICK = async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    };

    it("confirms head-only, advances pages, and serializes uploads in confirm order", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const uploadStarts: string[] = [];
        let releaseA: (() => void) | undefined;
        const uploadMedia = jest.fn().mockImplementation((_bytes: ArrayBuffer, contentType: string) => {
            uploadStarts.push(contentType);
            if (uploadStarts.length === 1) return new Promise((resolve) => { releaseA = () => resolve({ media_id: "m-a" }); });
            return Promise.resolve({ media_id: "m-b" });
        });
        state.state = signedInState(client);
        state.database = fakeDatabase({});
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send: jest.fn().mockReturnValue(true) };

        client.stageFiles([fileFixture("a.png", "image/a", [1]), fileFixture("b.png", "image/b", [2])]);
        const first = client.getSnapshot().stagedUploads!.items[0];
        await client.confirmStagedFile(first.id, "caption A");
        const second = client.getSnapshot().stagedUploads!.items[0];
        expect(second.id).not.toBe(first.id);
        await client.confirmStagedFile(second.id);
        expect(client.getSnapshot().stagedUploads).toBeUndefined();
        await PERSIST_TICK();

        expect(uploadStarts).toEqual(["image/a"]); // B waits for A (serialized chain)
        releaseA?.();
        await PERSIST_TICK();
        await PERSIST_TICK();
        expect(uploadStarts).toEqual(["image/a", "image/b"]);
    });

    it("is atomic against double activation (one row per page)", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const addToOutbox = jest.fn().mockResolvedValue(undefined);
        state.state = signedInState(client);
        state.database = fakeDatabase({ addToOutbox });
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia: jest.fn().mockResolvedValue({ media_id: "m" }) };
        state.connection = { send: jest.fn().mockReturnValue(true) };

        client.stageFiles([fileFixture("a.png", "image/png", [1])]);
        const head = client.getSnapshot().stagedUploads!.items[0];
        // ROUND-2 FIX (Codex M4): capture at INVOCATION time — jest stores
        // argument references, and the shared PendingMessage mutates to
        // "sending"/"error" after later ticks, so a post-hoc filter on
        // row.attachState would see the mutated object and miss the call.
        const uploadingPersists = new Set<string>();
        addToOutbox.mockImplementation(async (row: PendingMessage) => {
            if (row.attachState === "uploading") uploadingPersists.add(row.localId);
        });
        const race = Promise.all([client.confirmStagedFile(head.id, "x"), client.confirmStagedFile(head.id, "x")]);
        await race;
        await PERSIST_TICK();
        expect(uploadingPersists.size).toBe(1);
    });

    it("keeps the page with persistError on a failed put, and retries with the SAME localId", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const addToOutbox = jest.fn().mockRejectedValueOnce(new Error("quota")).mockResolvedValue(undefined);
        state.state = signedInState(client);
        state.database = fakeDatabase({ addToOutbox });
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia: jest.fn().mockResolvedValue({ media_id: "m" }) };
        state.connection = { send: jest.fn().mockReturnValue(true) };

        client.stageFiles([fileFixture("a.png", "image/png", [1])]);
        const head = client.getSnapshot().stagedUploads!.items[0];
        await client.confirmStagedFile(head.id, "x");
        let staged = client.getSnapshot().stagedUploads;
        expect(staged?.items[0]?.id).toBe(head.id);
        expect(staged?.persistError).toBe(true);
        expect(staged?.confirming).toBe(false);

        await client.confirmStagedFile(head.id, "x");
        await PERSIST_TICK();
        staged = client.getSnapshot().stagedUploads;
        expect(staged).toBeUndefined();
        const ids = addToOutbox.mock.calls.map(([row]) => row.localId);
        expect(new Set(ids).size).toBe(1);
    });

    it("leaves no retryable ghost chip when the user cancels after a persist failure", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const addToOutbox = jest.fn().mockRejectedValue(new Error("quota"));
        state.state = signedInState(client);
        state.database = fakeDatabase({ addToOutbox });
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia: jest.fn() };

        client.stageFiles([fileFixture("a.png", "image/png", [1])]);
        const head = client.getSnapshot().stagedUploads!.items[0];
        await client.confirmStagedFile(head.id, "x");
        expect(client.getSnapshot().stagedUploads?.persistError).toBe(true);
        client.cancelStagedFiles();

        expect(client.getSnapshot().stagedUploads).toBeUndefined();
        expect(client.getSnapshot().pendingMessages).toEqual([]); // no transient storage_failed chip
        await client.retryAttachment(head.message!.localId); // must be inert — nothing to retry
        expect(state.api!.uploadMedia).not.toHaveBeenCalled();
    });

    it("restart-recovery: two confirmed rows (second never uploaded) both surface as upload_failed after startSession", async () => {
        // Spec Testing #6 second half — mirrors the suite's existing
        // "reaps persisted uploads before starting the connection" pattern
        // (attachmentDatabase rows map + mocked JournalDatabase.open +
        // mocked JournalConnection.start). Two persisted `uploading` rows
        // stand in for confirm-A-uploading + confirm-B-queued at crash time.
        const client = new MatronJournalClient();
        const state = internals(client);
        const { database, rows } = attachmentDatabase();
        rows.set("row-a", {
            localId: "row-a", convoId: "c1", body: "", createdAt: 1,
            kind: "image", filename: "a.png", blobRef: null, attachState: "uploading",
        });
        rows.set("row-b", {
            localId: "row-b", convoId: "c1", body: "", createdAt: 2,
            kind: "image", filename: "b.png", blobRef: null, attachState: "uploading",
            caption: "b caption",
        });
        jest.spyOn(JournalDatabase, "open").mockResolvedValue(database as unknown as JournalDatabase);
        jest.spyOn(JournalConnection.prototype, "start").mockImplementation(() => undefined);

        await state.startSession(SESSION);

        expect(rows.get("row-a")).toMatchObject({ attachState: "error", errorKind: "upload_failed" });
        expect(rows.get("row-b")).toMatchObject({
            attachState: "error",
            errorKind: "upload_failed",
            caption: "b caption", // caption survives the reap re-persist
        });
        expect(client.getSnapshot().pendingMessages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ localId: "row-a", attachState: "error" }),
                expect.objectContaining({ localId: "row-b", attachState: "error", caption: "b caption" }),
            ]),
        );
    });

    it("refuses confirm into an archived conversation with a visible error state", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        state.state = signedInState(client);
        state.database = fakeDatabase({});
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia: jest.fn() };

        client.stageFiles([fileFixture("a.png", "image/png", [1])]);
        state.state = { ...state.state, archivedIds: new Set(["c1"]) };
        const head = client.getSnapshot().stagedUploads!.items[0];
        await client.confirmStagedFile(head.id, "x");

        const staged = client.getSnapshot().stagedUploads;
        expect(staged?.error).toBe("archived");
        expect(staged?.items).toHaveLength(0);
        expect(state.api!.uploadMedia).not.toHaveBeenCalled();
    });

    it("marks a queued item upload_failed (retryable, with errorMessage) when the convo archives before its turn", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const addToOutbox = jest.fn().mockResolvedValue(undefined);
        let releaseA: (() => void) | undefined;
        const uploadMedia = jest.fn().mockImplementationOnce(
            () => new Promise((resolve) => { releaseA = () => resolve({ media_id: "m-a" }); }),
        );
        state.state = signedInState(client);
        state.database = fakeDatabase({ addToOutbox });
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send: jest.fn().mockReturnValue(true) };

        client.stageFiles([fileFixture("a.png", "image/png", [1]), fileFixture("b.png", "image/png", [2])]);
        await client.confirmStagedFile(client.getSnapshot().stagedUploads!.items[0].id);
        await client.confirmStagedFile(client.getSnapshot().stagedUploads!.items[0].id, "b caption");
        state.state = { ...state.state, archivedIds: new Set(["c1"]) };
        releaseA?.();
        await PERSIST_TICK();
        await PERSIST_TICK();

        expect(uploadMedia).toHaveBeenCalledTimes(1); // B never uploads
        const bFailure = addToOutbox.mock.calls
            .map(([row]) => row)
            .find((row) => row.errorKind === "upload_failed" && row.errorMessage);
        expect(bFailure).toEqual(
            expect.objectContaining({ caption: "b caption", attachState: "error" }),
        );
    });

    it("aborts a queued thunk when the session changes before it executes", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        let releaseA: (() => void) | undefined;
        const uploadMedia = jest.fn().mockImplementationOnce(
            () => new Promise((resolve) => { releaseA = () => resolve({ media_id: "m-a" }); }),
        );
        state.state = signedInState(client);
        state.database = fakeDatabase({});
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send: jest.fn().mockReturnValue(true) };

        client.stageFiles([fileFixture("a.png", "image/png", [1]), fileFixture("b.png", "image/png", [2])]);
        await client.confirmStagedFile(client.getSnapshot().stagedUploads!.items[0].id);
        await client.confirmStagedFile(client.getSnapshot().stagedUploads!.items[0].id);
        (client as unknown as { sessionGen: number }).sessionGen += 1; // simulate startSession
        releaseA?.();
        await PERSIST_TICK();
        await PERSIST_TICK();
        expect(uploadMedia).toHaveBeenCalledTimes(1); // B's thunk aborted
    });

    it("does not poison the chain when an upload rejects (B still runs after A fails)", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        const uploadMedia = jest
            .fn()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValue({ media_id: "m-b" });
        state.state = signedInState(client);
        state.database = fakeDatabase({});
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia };
        state.connection = { send: jest.fn().mockReturnValue(true) };

        client.stageFiles([fileFixture("a.png", "image/png", [1]), fileFixture("b.png", "image/png", [2])]);
        await client.confirmStagedFile(client.getSnapshot().stagedUploads!.items[0].id);
        await client.confirmStagedFile(client.getSnapshot().stagedUploads!.items[0].id);
        await PERSIST_TICK();
        await PERSIST_TICK();
        expect(uploadMedia).toHaveBeenCalledTimes(2);
    });

    it("skip advances without sending; cancel-all leaves confirmed items alone", async () => {
        const client = new MatronJournalClient();
        const state = internals(client);
        state.state = signedInState(client);
        state.database = fakeDatabase({});
        state.api = { messages: jest.fn().mockResolvedValue({ events: [] }), uploadMedia: jest.fn() };

        client.stageFiles([fileFixture("a.png", "image/png", [1]), fileFixture("b.png", "image/png", [2])]);
        const first = client.getSnapshot().stagedUploads!.items[0];
        client.skipStagedFile(first.id);
        expect(client.getSnapshot().stagedUploads!.items[0].id).not.toBe(first.id);
        client.skipStagedFile("not-the-head");
        expect(client.getSnapshot().stagedUploads!.items).toHaveLength(1);
        client.cancelStagedFiles();
        expect(client.getSnapshot().stagedUploads).toBeUndefined();
        expect(state.api!.uploadMedia).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run to verify failure** — `(cd /opt/matron/web-journal && corepack pnpm test -- client-test)` → FAIL (`confirmStagedFile` missing).

- [ ] **Step 3: Implement**

ROUND-1 FIX (Codex B2 — documented oscillation override, spec amended):
there is NO persist timeout. The spec's earlier "bounded (~5s)" line is
superseded — a `Promise.race` timeout cannot cancel the losing IndexedDB
put, so a late completion would ghost-write an orphan `uploading` row with
no upload thunk (stuck chip: strictly worse than the hypothetical wedge).
`confirming` holds until the persist settles; a truly hung put wedges only
the modal, and refresh is a lossless escape (unconfirmed staging is
in-memory).

```ts
    public async confirmStagedFile(itemId: string, captionInput?: string): Promise<void> {
        const staged = this.state.stagedUploads;
        if (!staged || staged.confirming || staged.error) return;
        const head = staged.items[0];
        if (!head || head.id !== itemId) return;
        // 1. Atomic reservation — same tick, before any await.
        this.patch({ stagedUploads: { ...staged, confirming: true } });

        const gen = this.sessionGen;
        const api = this.api;
        const db = this.database;
        if (!api || !db) {
            const current = this.state.stagedUploads;
            if (current) this.patch({ stagedUploads: { ...current, confirming: false } });
            return;
        }
        const owner: AttachmentOwner = { gen, api, db };
        const convoId = staged.convoId;

        // 2. Confirm-time convo validation (P19, first of two).
        if (!this.stagedConvoValid(convoId)) {
            this.patch({ stagedUploads: { ...staged, items: [], confirming: false, error: "archived" } });
            return;
        }

        // 3. Persist-then-advance with one row identity per page.
        const caption = captionInput?.trim() ? captionInput.trim() : undefined;
        const message = head.message ?? this.buildPendingAttachment(head.file, convoId, caption);
        head.message = message;
        if (caption) message.caption = caption;
        else delete message.caption;

        const persisted = await this.persistPendingAttachment(message, head.file, db, gen);
        if (this.sessionGen !== gen) return; // startSession wiped staging
        const current = this.state.stagedUploads;
        if (!current) return;
        if (!persisted) {
            // ROUND-1 FIX (Codex B3) + ROUND-2 FIX (Claude M3): purge the
            // transient failure state so Cancel/Skip cannot leave a retryable
            // ghost chip — and AWAIT the refresh so the purge is a synchronous
            // guarantee by the time confirmStagedFile resolves (a fire-and-
            // forget refresh loses the race against the caller's very next
            // getSnapshot(), verified by microtask-ordering analysis in
            // plan-review round 2). This is an error path; one extra awaited
            // tick cannot stall the happy path.
            this.transientAttachmentErrors.delete(message.localId);
            this.pendingFiles.delete(message.localId);
            if (this.state.selectedConversationId === convoId) {
                await this.refreshSelectedConversation(convoId, db, gen).catch(() => undefined);
            }
            const afterPurge = this.state.stagedUploads;
            if (!afterPurge) return;
            this.patch({ stagedUploads: { ...afterPurge, confirming: false, persistError: true } });
            return;
        }
        // Live chip visibility: fire the refresh without blocking the modal.
        void this.refreshSelectedConversation(convoId, db, gen).catch(() => undefined);
        const rest = current.items.slice(1);
        this.patch({
            stagedUploads: rest.length
                ? { ...current, items: rest, confirming: false, persistError: false }
                : undefined,
        });

        // 4. Deferred upload with execution-time guards + rejection isolation.
        this.stagedSendChain = this.stagedSendChain.then(async () => {
            try {
                if (this.sessionGen !== gen || this.database !== db) return; // session guard
                if (!this.stagedConvoValid(convoId)) {
                    message.attachState = "error";
                    message.errorKind = "upload_failed";
                    message.errorMessage = "Conversation was archived in another tab — unarchive to retry.";
                    if (await this.persistAttachment(message, db, gen)) {
                        await this.refreshSelectedConversation(convoId, db, gen).catch(() => undefined);
                    }
                    return;
                }
                await this.runPendingUpload(message, head.file, owner);
            } catch {
                // Rejection isolation: one failed upload must not poison the chain.
            }
        });
    }

    public skipStagedFile(itemId: string): void {
        const staged = this.state.stagedUploads;
        if (!staged || staged.confirming || staged.error) return;
        const head = staged.items[0];
        if (!head || head.id !== itemId) return;
        const rest = staged.items.slice(1);
        this.patch({
            stagedUploads: rest.length ? { ...staged, items: rest, persistError: false } : undefined,
        });
    }
```

Note the pre-flight-invalid case (`size === 0` / over-cap): those files never reach `confirmStagedFile` — the modal disables Send (T-3.1). `persistPendingAttachment` still guards as defense-in-depth for the `attachFiles` path.

- [ ] **Step 4: Run to verify pass** — `(cd /opt/matron/web-journal && corepack pnpm test -- client-test)` → PASS (new + all pre-existing).

- [ ] **Step 5: Commit**

```bash
git -C /opt/matron/web-journal add src/journal/client.ts test/unit-tests/journal/client-test.ts
git -C /opt/matron/web-journal -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(client): confirm/skip staged files — confirming lock, bounded persist-then-advance, guarded serialized send chain"
```

---

## Phase 3 — Modal UI, entry-point rewires, render additions

### T-3.1: UploadConfirmDialog component + styles + mount

**Files:**
- Modify: `src/journal/components.tsx` (new component + mount in `SignedInApp`)
- Modify: `src/journal/journal.pcss`
- Test: `test/unit-tests/journal/components-test.ts`

**Interfaces:**
- Consumes: `client.stagedUploads` state, `confirmStagedFile(itemId, caption)`, `skipStagedFile(itemId)`, `cancelStagedFiles()`, `stageFiles()` (paste-append), `BROWSER_MEMORY_SAFETY_MAX_BYTES` (imported from `./client`).
- Produces: `UploadConfirmDialog({ client, staged })` rendered by `SignedInApp` at the top of the signed-in tree whenever `state.stagedUploads` is present (items or error). Apply the **frontend-design skill** for the visual pass — panel echoes the auth-modal look over a full-screen scrim; distinctive but consistent with the existing `mj_*` design language.

- [ ] **Step 1: Write the failing tests** (spec Testing #11, #12, #13, #17 + error state + paste-append):

```ts
describe("UploadConfirmDialog", () => {
    const stage = async (client: MatronJournalClient, files: File[]): Promise<void> => {
        await act(async () => client.stageFiles(files));
    };

    it("renders preview + caption for an image and confirms with the typed caption on Send and on Enter", async () => {
        const client = signedInClient();
        const confirm = jest.spyOn(client, "confirmStagedFile").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        await stage(client, [new File(["x"], "shot.png", { type: "image/png" })]);

        const dialog = rendered.container.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog!.getAttribute("aria-modal")).toBe("true");
        expect(dialog!.querySelector("img")).not.toBeNull();

        const textarea = dialog!.querySelector<HTMLTextAreaElement>("textarea");
        expect(document.activeElement).toBe(textarea);
        expect(textarea!.maxLength).toBe(4096);
        await act(async () => {
            textarea!.value = "look here";
            textarea!.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => button(dialog as HTMLElement, "Send").click());
        const headId = client.getSnapshot().stagedUploads!.items[0].id;
        expect(confirm).toHaveBeenCalledWith(headId, "look here");
    });

    it("shows name+size (no img) for non-images, pages 'File k of N', and isolates captions per page", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        await stage(client, [
            new File(["a"], "a.txt", { type: "text/plain" }),
            new File(["b"], "b.txt", { type: "text/plain" }),
        ]);
        const dialog = (): HTMLElement => rendered!.container.querySelector('[role="dialog"]')!;
        expect(dialog().textContent).toContain("File 1 of 2");
        expect(dialog().querySelector("img")).toBeNull();
        expect(dialog().textContent).toContain("a.txt");

        const textarea = dialog().querySelector<HTMLTextAreaElement>("textarea")!;
        await act(async () => {
            textarea.value = "caption for a";
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => {
            const headId = client.getSnapshot().stagedUploads!.items[0].id;
            client.skipStagedFile(headId);
        });
        expect(dialog().textContent).toContain("File 2 of 2");
        expect(dialog().querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
    });

    it("keyboard contract: Enter confirms; Shift+Enter, IME-composing Enter, and keyCode-229 Enter do not; Escape skips", async () => {
        // ROUND-2 FIX (Codex M3): each advertised keyboard path gets its OWN
        // dispatched event + assertion — no behavior encoded only in the name.
        const client = signedInClient();
        const confirm = jest.spyOn(client, "confirmStagedFile").mockResolvedValue(undefined);
        const skip = jest.spyOn(client, "skipStagedFile");
        rendered = await renderClient(client);
        await stage(client, [new File(["ok"], "ok.png", { type: "image/png" })]);
        const textarea = (): HTMLTextAreaElement =>
            rendered!.container.querySelector<HTMLElement>('[role="dialog"]')!.querySelector("textarea")!;
        const key = (init: KeyboardEventInit & { keyCode?: number }) =>
            act(async () => {
                const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
                if (init.keyCode) Object.defineProperty(event, "keyCode", { value: init.keyCode });
                textarea().dispatchEvent(event);
            });

        await key({ key: "Enter", shiftKey: true });
        expect(confirm).not.toHaveBeenCalled(); // Shift+Enter = newline
        await key({ key: "Enter", isComposing: true } as KeyboardEventInit);
        expect(confirm).not.toHaveBeenCalled(); // IME composing guard
        await key({ key: "Enter", keyCode: 229 });
        expect(confirm).not.toHaveBeenCalled(); // Safari IME keyCode guard
        await key({ key: "Enter" });
        expect(confirm).toHaveBeenCalledTimes(1); // plain Enter confirms
        await key({ key: "Escape" });
        expect(skip).toHaveBeenCalledTimes(1); // Escape skips
    });

    it("zero-byte and over-cap files disable Send AND the Enter path", async () => {
        const client = signedInClient();
        const confirm = jest.spyOn(client, "confirmStagedFile").mockResolvedValue(undefined);
        rendered = await renderClient(client);
        const empty = new File([], "empty.bin", { type: "application/octet-stream" });
        const big = new File([""], "big.bin", { type: "application/octet-stream" });
        Object.defineProperty(big, "size", { value: BROWSER_MEMORY_SAFETY_MAX_BYTES + 1 });
        await stage(client, [empty, big]);

        for (let page = 0; page < 2; page += 1) {
            const dialog = rendered.container.querySelector<HTMLElement>('[role="dialog"]')!;
            expect(dialog.querySelector<HTMLButtonElement>("button.mj_UploadConfirm_send")?.disabled).toBe(true);
            const textarea = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
            await act(async () => {
                textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            });
            expect(confirm).not.toHaveBeenCalled();
            await act(async () => client.skipStagedFile(client.getSnapshot().stagedUploads!.items[0].id));
        }
    });

    it("shows the archived error state with Close, and pasted files append as pages", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        await stage(client, [new File(["a"], "a.txt", { type: "text/plain" })]);
        // paste appends
        const pasted = new File(["p"], "p.png", { type: "image/png" });
        await act(async () => {
            document.dispatchEvent(
                Object.assign(new Event("paste", { bubbles: true }), {
                    clipboardData: { files: [pasted] },
                }),
            );
        });
        expect(client.getSnapshot().stagedUploads!.total).toBe(2);

        // archived error page — ROUND-1 FIX (Claude B2): drive the transition
        // through the REAL client path (archiveConversation → patch/emit →
        // confirm-time check), never by direct state assignment (which bypasses
        // patch()/emit() and can never re-render useSyncExternalStore).
        const cancel = jest.spyOn(client, "cancelStagedFiles");
        await act(async () => client.archiveConversation("c1"));
        const headId = client.getSnapshot().stagedUploads!.items[0].id;
        await act(async () => client.confirmStagedFile(headId, "x"));
        const dialog = rendered.container.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog.textContent).toContain("archived in another tab");
        await act(async () => button(dialog, "Close").click());
        expect(cancel).toHaveBeenCalled();
    });

    it("revokes object URLs on advance and on close", async () => {
        const revoke = jest.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
        jest.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
        const client = signedInClient();
        rendered = await renderClient(client);
        await stage(client, [
            new File(["a"], "a.png", { type: "image/png" }),
            new File(["b"], "b.png", { type: "image/png" }),
        ]);
        await act(async () => client.skipStagedFile(client.getSnapshot().stagedUploads!.items[0].id));
        expect(revoke).toHaveBeenCalledWith("blob:preview");
        await act(async () => client.cancelStagedFiles());
        expect(revoke).toHaveBeenCalledTimes(2);
    });
});
```

(Adapt helper names — `signedInClient`, `renderClient`, `button`, `internalsOf` — to the exact helpers already defined in `components-test.ts`; mirror the state-mutation pattern the existing tests use to drive `useSyncExternalStore` re-renders.)

- [ ] **Step 2: Run to verify failure** — `(cd /opt/matron/web-journal && corepack pnpm test -- components-test)` → FAIL (no dialog rendered).

- [ ] **Step 3: Implement the component** in `components.tsx` (invoke the **frontend-design skill** before writing the JSX/styles):

```tsx
// ROUND-1 FIX (consensus B1): two components. The SHELL (UploadConfirmDialog)
// owns the scrim, the error page, and the document-level paste listener — it
// stays mounted across pages. The PAGE (UploadConfirmPage) owns caption /
// preview / focus state and is keyed by head.id AT ITS CALL SITE, so every
// page advance remounts the component INSTANCE that owns the hooks (keying an
// inner div would only replace DOM and leak the caption across pages).

function UploadConfirmDialog({ client, staged }: { client: MatronJournalClient; staged: StagedUploads }): React.ReactElement {
    useEffect(() => {
        const onPaste = (event: ClipboardEvent): void => {
            const files = [...(event.clipboardData?.files ?? [])];
            if (files.length > 0) {
                event.preventDefault();
                client.stageFiles(files);
            }
        };
        document.addEventListener("paste", onPaste);
        return () => document.removeEventListener("paste", onPaste);
    }, [client]);

    if (staged.error) {
        return (
            <div className="mj_UploadConfirm_scrim" role="dialog" aria-modal="true" aria-label="Upload error">
                <div className="mj_UploadConfirm">
                    <p className="mj_UploadConfirm_error">
                        This conversation was archived in another tab. Attachment(s) were not sent.
                    </p>
                    <div className="mj_UploadConfirm_actions">
                        <button aria-label="Close" onClick={() => client.cancelStagedFiles()}>Close</button>
                    </div>
                </div>
            </div>
        );
    }
    const head = staged.items[0];
    if (!head) return <></>;
    return (
        <div className="mj_UploadConfirm_scrim" role="dialog" aria-modal="true" aria-label={head.file.name}>
            <UploadConfirmPage key={head.id} client={client} staged={staged} head={head} />
        </div>
    );
}

function UploadConfirmPage({
    client,
    staged,
    head,
}: {
    client: MatronJournalClient;
    staged: StagedUploads;
    head: StagedUploadItem;
}): React.ReactElement {
    const isImage = head.file.type.startsWith("image/");
    const preflight =
        head.file.size === 0
            ? "That file is empty."
            : head.file.size > BROWSER_MEMORY_SAFETY_MAX_BYTES
              ? "This file is too large for this browser to upload safely."
              : undefined;
    const canSend = !preflight && !staged.confirming;
    const [caption, setCaption] = useState("");
    const textarea = useRef<HTMLTextAreaElement>(null);
    const [previewUrl, setPreviewUrl] = useState<string>();
    const position = staged.total - staged.items.length + 1;

    useEffect(() => {
        textarea.current?.focus();
        if (!isImage) return undefined;
        const url = URL.createObjectURL(head.file);
        setPreviewUrl(url);
        return () => {
            URL.revokeObjectURL(url);
        };
        // Mounted once per page (keyed by head.id at the call site).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const send = (): void => {
        if (!canSend) return;
        void client.confirmStagedFile(head.id, caption);
    };

    return (
        <div className="mj_UploadConfirm">
            <h2 className="mj_UploadConfirm_title">
                {head.file.name}
                {staged.total > 1 && <span className="mj_UploadConfirm_count"> — File {position} of {staged.total}</span>}
            </h2>
            {isImage && previewUrl ? (
                <img className="mj_UploadConfirm_preview" src={previewUrl} alt={head.file.name} />
            ) : (
                <div className="mj_UploadConfirm_fileMeta">
                    <AttachmentIcon />
                    <span>{head.file.name}</span>
                    <span className="mj_FileSize">{formatBytes(head.file.size)}</span>
                </div>
            )}
            {preflight && <p className="mj_UploadConfirm_error">{preflight}</p>}
            {staged.persistError && (
                <p className="mj_UploadConfirm_error">Couldn&apos;t save this attachment — try Send again.</p>
            )}
            <textarea
                ref={textarea}
                className="mj_UploadConfirm_caption"
                placeholder="Add a caption…"
                maxLength={4096}
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        send();
                    } else if (event.key === "Escape" && !staged.confirming) {
                        event.preventDefault();
                        client.skipStagedFile(head.id);
                    }
                }}
                aria-label="Caption"
            />
            <div className="mj_UploadConfirm_actions">
                {/* aria-labels REQUIRED: the suite's button() helper selects strictly
                    by button[aria-label=...] (components-test.ts:70-74) — codebase
                    convention for every helper-targeted button. */}
                {staged.total > 1 && (
                    <button
                        className="mj_TextButton"
                        aria-label="Cancel all"
                        disabled={staged.confirming}
                        onClick={() => client.cancelStagedFiles()}
                    >
                        Cancel all
                    </button>
                )}
                <button aria-label="Cancel" disabled={staged.confirming} onClick={() => client.skipStagedFile(head.id)}>
                    Cancel
                </button>
                <button className="mj_UploadConfirm_send" aria-label="Send" disabled={!canSend} onClick={send}>
                    Send
                </button>
            </div>
        </div>
    );
}
```

Wiring: `SignedInApp` renders `{state.stagedUploads && <UploadConfirmDialog client={client} staged={state.stagedUploads} />}` as the LAST child of `mx_MatrixChat_wrapper` (full-viewport sibling above both panels). Imports: add `StagedUploads`/`StagedUploadItem` to the types import, `BROWSER_MEMORY_SAFETY_MAX_BYTES` to the client import. The keyed `UploadConfirmPage` remount resets caption state and re-fires autofocus per page (P5/P31) and its effect cleanup revokes the object URL on advance/close/unmount.

Styles in `journal.pcss` (echo `mj_DragOverlay`'s scrim tokens and the auth-panel look; exact values from the frontend-design pass at execute time):

```css
.mj_UploadConfirm_scrim {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
}
.mj_UploadConfirm {
    background: var(--cpd-color-bg-canvas-default, #fff);
    border-radius: 12px;
    padding: 20px;
    max-width: min(520px, 92vw);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: auto;
}
.mj_UploadConfirm_preview {
    max-height: 50vh;
    max-width: 100%;
    object-fit: contain;
    border-radius: 8px;
}
.mj_UploadConfirm_caption {
    resize: vertical;
    min-height: 44px;
}
.mj_UploadConfirm_actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}
.mj_UploadConfirm_error {
    color: var(--cpd-color-text-critical-primary, #d32f2f);
    margin: 0;
}
```

(Match the variable names/tokens actually used elsewhere in `journal.pcss` — grep for the auth modal + `mj_DragOverlay` blocks and reuse their color tokens rather than inventing new ones.)

- [ ] **Step 4: Run to verify pass** — `(cd /opt/matron/web-journal && corepack pnpm test -- components-test)` → PASS (new tests; pre-existing suite untouched so far).

- [ ] **Step 5: Commit**

```bash
git -C /opt/matron/web-journal add src/journal/components.tsx src/journal/journal.pcss test/unit-tests/journal/components-test.ts
git -C /opt/matron/web-journal -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(ui): UploadConfirmDialog — app-modal preview + caption, per-page remount, error states"
```

### T-3.2: Entry-point rewires + structural guards

**Files:**
- Modify: `src/journal/components.tsx` (Composer `onChange`/`onPaste`, `SignedInApp` `onDrop`)
- Test: `test/unit-tests/journal/components-test.ts` (three existing `attachFiles` spies → `stageFiles`; two new guard tests)

**Interfaces:**
- Consumes: `client.stageFiles` (T-2.2), `state.stagedUploads`.
- Produces: all three entry points call `stageFiles`; Composer/onDrop guarded while the modal is open; drop handler `preventDefault` ordering per spec.

- [ ] **Step 1: Update the three existing spy tests** — in `components-test.ts` (~lines 102, 131, 180): change `jest.spyOn(client, "attachFiles")` to `jest.spyOn(client, "stageFiles")` and the matching `expect(attachFiles)` assertions to the `stageFiles` spy (call args unchanged: `[file]` arrays). **This is planned breakage from the rewire, not a regression.**

- [ ] **Step 2: Add the failing guard tests** (spec Testing #15, #16):

```ts
    it("paste while the modal is open appends exactly once (composer handler inert)", async () => {
        const client = signedInClient();
        const stageFiles = jest.spyOn(client, "stageFiles");
        rendered = await renderClient(client);
        await act(async () => client.stageFiles([new File(["a"], "a.txt", { type: "text/plain" })]));
        stageFiles.mockClear();

        const textareaEl = rendered.container.querySelector<HTMLTextAreaElement>(".mx_BasicMessageComposer_input")!;
        const pasted = new File(["p"], "p.png", { type: "image/png" });
        await act(async () => {
            textareaEl.dispatchEvent(
                Object.assign(new Event("paste", { bubbles: true }), { clipboardData: { files: [pasted] } }),
            );
        });
        expect(stageFiles).toHaveBeenCalledTimes(1); // modal document listener only
        expect(client.getSnapshot().stagedUploads!.total).toBe(2);
    });

    it("file drop while the modal is open prevents navigation and stages nothing extra", async () => {
        const client = signedInClient();
        rendered = await renderClient(client);
        await act(async () => client.stageFiles([new File(["a"], "a.txt", { type: "text/plain" })]));
        const stageFiles = jest.spyOn(client, "stageFiles");

        const room = rendered.container.querySelector<HTMLElement>(".mx_RoomView")!;
        const drop = fileDragEvent("drop", new File(["d"], "d.txt", { type: "text/plain" }));
        await act(async () => room.dispatchEvent(drop));
        expect(drop.defaultPrevented).toBe(true);
        expect(stageFiles).not.toHaveBeenCalled();
    });
```

- [ ] **Step 3: Run to verify failure** — `(cd /opt/matron/web-journal && corepack pnpm test -- components-test)` → FAIL (entry points still call `attachFiles`; guards missing).

- [ ] **Step 4: Implement the rewires**

Composer file input `onChange`: `if (event.target.files) client.stageFiles([...event.target.files]);` (keep `event.target.value = ""`).

Composer textarea `onPaste`:

```tsx
onPaste={(event) => {
    if (state.stagedUploads) return; // modal's document listener owns pastes while open
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
        event.preventDefault(); // deliberate addition (round-1 Mn1): keeps a pasted
        // file's name/text out of the textarea now that the file goes to the modal
        client.stageFiles(files);
    }
}}
```

`SignedInApp` `onDrop` — exact ordering per spec (preventDefault BEFORE the staged guard):

```tsx
onDrop={(event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setDragActive(false);
    if (state.stagedUploads) return;
    const files = [...event.dataTransfer.files];
    if (files.length > 0) client.stageFiles(files);
}}
```

- [ ] **Step 5: Run to verify pass** — `(cd /opt/matron/web-journal && corepack pnpm test -- components-test)` → PASS (updated spies + guards).

- [ ] **Step 6: Commit**

```bash
git -C /opt/matron/web-journal add src/journal/components.tsx test/unit-tests/journal/components-test.ts
git -C /opt/matron/web-journal -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(ui): route picker/paste/drop through stageFiles with structural modal guards"
```

### T-3.3: Render additions — file-tile caption, chip caption + errorMessage preference

**Files:**
- Modify: `src/journal/components.tsx` (`EventContent` case `"file"`, `PendingAttachment`, `attachmentErrorMessage`)
- Test: `test/unit-tests/journal/components-test.ts`

**Interfaces:**
- Consumes: `payload.caption` (wire), `PendingMessage.caption` / `errorMessage` (T-1.1/T-2.3).
- Produces: caption line under file tiles and pending chips; `attachmentErrorMessage` prefers `message.errorMessage` when set.

- [ ] **Step 1: Write the failing tests** (spec Testing #14):

```ts
    it("renders the caption under file tiles and pending chips, and prefers errorMessage on error chips", async () => {
        // ROUND-1 FIX (Claude M5): no applyState helper exists — pass events/
        // pendingMessages into signedInClient(...) BEFORE rendering (the
        // suite's established construction pattern, components-test.ts:38-55).
        const client = signedInClient({
            events: [
                {
                    seq: 1, convo_id: "c1", ts: 1, sender: "user:dan", type: "file",
                    payload: { blob_ref: "m1", filename: "notes.txt", size: 10, caption: "read this first" },
                },
            ],
            pendingMessages: [
                {
                    localId: "p1", convoId: "c1", body: "", createdAt: 2, kind: "image",
                    filename: "shot.png", size: 5, contentType: "image/png", blobRef: null,
                    attachState: "error", errorKind: "upload_failed", canRetry: true,
                    caption: "look at this",
                    errorMessage: "Conversation was archived in another tab — unarchive to retry.",
                },
            ],
        });
        rendered = await renderClient(client);
        expect(rendered.container.textContent).toContain("read this first");
        expect(rendered.container.textContent).toContain("look at this");
        expect(rendered.container.textContent).toContain("unarchive to retry");
    });
```

- [ ] **Step 2: Run to verify failure** — FAIL (file tile drops caption; chip shows generic copy).

- [ ] **Step 3: Implement**

`EventContent` case `"file"` — add after the size span, inside the wrapping `<div>`:

```tsx
{asString(event.payload.caption) && <div className="mj_FileCaption">{asString(event.payload.caption)}</div>}
```

`PendingAttachment` — under the filename span inside `mj_AttachmentChip_content`:

```tsx
{message.caption && <span className="mj_AttachmentChip_caption">{message.caption}</span>}
```

`attachmentErrorMessage` — first line becomes:

```ts
function attachmentErrorMessage(message: PendingMessage): string {
    if (message.errorMessage) return message.errorMessage;
    switch (message.errorKind) {
        // ...existing cases unchanged (the electron case's `message.errorMessage ||` fallback is now redundant but harmless)
    }
}
```

`journal.pcss`: `.mj_FileCaption { margin-top: 4px; }` and `.mj_AttachmentChip_caption { display: block; opacity: 0.8; font-size: 0.9em; }` (align with neighboring chip styles).

- [ ] **Step 4: Run to verify pass** — `(cd /opt/matron/web-journal && corepack pnpm test -- components-test)` → PASS.

- [ ] **Step 5: Full web suite + commit**

Run: `(cd /opt/matron/web-journal && corepack pnpm test)` → all suites PASS.

```bash
git -C /opt/matron/web-journal add src/journal/components.tsx src/journal/journal.pcss test/unit-tests/journal/components-test.ts
git -C /opt/matron/web-journal -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(ui): render captions on file tiles and pending chips; prefer errorMessage on error chips"
```

---

## Phase 4 — Bridge consumer (easelyte/claude-matrix-bridge @ journal-deploy)

Branch setup (once, before T-4.1): `git -C /opt/matron/bridge-journal checkout -b feat/journal-media-captions journal-deploy` (working tree is the live service checkout — do NOT restart the service during this phase; the running process is unaffected by working-tree edits until restart).

### T-4.1: Input router — extract + clamp `payload.caption`

**Files:**
- Modify: `lib/journal-input-router.js` (the media-routing block — grep `routeMediaToSession(session, {`)
- Test: `test/journal-input-router.test.js`

**Interfaces:**
- Consumes: journal `file`/`image` frames with optional `payload.caption`.
- Produces: media object gains `caption: string | null` (trimmed, clamped to 4096; `null` when absent/blank).

- [ ] **Step 1: Write the failing tests** — in `test/journal-input-router.test.js`. **ROUND-1 FIX (Claude M4): `createJournalInputConsumer(deps)` returns a BARE CALLABLE invoked as `consumer(frame)` — there is no `.onEvent()` method.** The file's real helpers are `makeDeps` / `fileFrame` / `baseFrame` (~line 698+). Add, mirroring the existing media-routing tests:

```js
  it('extracts, trims, and clamps payload.caption into the media object', () => {
    const deps = makeDeps();               // file's existing deps factory (includes routeMediaToSession mock)
    const consumer = createJournalInputConsumer(deps);
    const framed = (payload) => fileFrame({ payload: { ...fileFrame().payload, ...payload } });

    consumer(framed({ caption: '  look at this  ' }));
    expect(deps.routeMediaToSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ caption: 'look at this' }),
      expect.anything(),
    );

    deps.routeMediaToSession.mockClear();
    consumer(framed({ caption: 'x'.repeat(5000) }));
    expect(deps.routeMediaToSession.mock.calls[0][1].caption).toHaveLength(4096);

    deps.routeMediaToSession.mockClear();
    consumer(framed({}));
    expect(deps.routeMediaToSession.mock.calls[0][1].caption).toBeNull();

    deps.routeMediaToSession.mockClear();
    consumer(framed({ caption: '   ' }));
    expect(deps.routeMediaToSession.mock.calls[0][1].caption).toBeNull();
  });
```

(Adapt `makeDeps`/`fileFrame` call shapes to their exact local signatures — the invocation form `consumer(frame)` is the verified contract.)

**Planned breakage (round-2 Claude B2 — mirror of T-3.2's spy updates):** the
unconditional `caption` key breaks the two pre-existing exact-shape assertions
in this file — "routes a user file event ... resolved media shape"
(~lines 719-732) and "routes a user image event ... passes through image dims"
(~lines 734-747), both `expect(media).toEqual({...})` with no `caption` key.
Update BOTH expected objects to include `caption: null`. Expected, mechanical,
not a regression.

- [ ] **Step 2: Run to verify failure** — `(cd /opt/matron/bridge-journal && npm test -- journal-input-router)` → FAIL (`caption` undefined).

- [ ] **Step 3: Implement** — in the media branch of `lib/journal-input-router.js`, where the media object literal is built (`{ type, blobRef, contentType: ..., name: ..., size: ..., dims: ... }`), add:

```js
        const captionRaw = typeof payload?.caption === 'string' ? payload.caption.trim() : '';
```

and in the object literal:

```js
          caption: captionRaw ? captionRaw.slice(0, 4096) : null,
```

- [ ] **Step 4: Run to verify pass** — `(cd /opt/matron/bridge-journal && npm test -- journal-input-router)` → PASS.

- [ ] **Step 5: Commit**

```bash
git -C /opt/matron/bridge-journal add lib/journal-input-router.js test/journal-input-router.test.js
git -C /opt/matron/bridge-journal -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(journal-input): extract, trim, and clamp payload.caption for media frames"
```

### T-4.2: Media orchestrator — thread caption, tail-append for non-iv, wiring update

**Files:**
- Modify: `lib/journal-media.js` (`routeOne`)
- Modify: `index.js` (~5911-5928, `createJournalMediaRouter` `buildSavedBlocks` wiring)
- Test: `test/journal-media.test.js`

**Interfaces:**
- Consumes: `media.caption` (T-4.1); `buildSavedMediaBlocks`'s `{ blocks, ivHandled }` return (`index.js` ~4365).
- Produces: `buildSavedBlocks` seam contract widened — may return `blocks[]` (legacy) OR `{ blocks, ivHandled }`; `routeOne` performs the SDK-mode tail-append (`{type:'text', text: caption}` when `caption && !ivHandled`). **Spec refinement note:** spec Part 2 §3 places the tail-append in the `index.js` wiring; implementing it in `routeOne` is observably identical and unit-testable — the wiring just forwards `ivCaption` and returns the object.

- [ ] **Step 1: Write the failing tests** — in `test/journal-media.test.js`, following the file's existing router-construction pattern:

```js
  it('threads caption to buildSavedBlocks and tail-appends it when the iv branch did not fold it (non-iv/SDK mode)', async () => {
    const injected = [];
    const buildSavedBlocks = vi.fn().mockReturnValue({
      blocks: [{ type: 'text', text: 'File saved to /tmp/x' }],
      ivHandled: false,
    });
    const router = createJournalMediaRouter({
      fetchMedia: vi.fn().mockResolvedValue({ buffer: Buffer.from('x'), contentType: 'image/png' }),
      transcribe: vi.fn(),
      buildSavedBlocks,
      injectText: vi.fn().mockReturnValue(true),
      injectBlocks: vi.fn((session, blocks) => { injected.push(blocks); return true; }),
      echoToRoom: vi.fn(),
      publishNotice: vi.fn(),
    });
    await router({ claudeSessionId: 'c1' }, { type: 'image', blobRef: 'b1', contentType: 'image/png', name: 's.png', caption: 'look at this' }, {});

    expect(buildSavedBlocks).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ caption: 'look at this' }));
    expect(injected[0][injected[0].length - 1]).toEqual({ type: 'text', text: 'look at this' });
  });

  it('does NOT tail-append when the iv branch already folded the caption (ivHandled: true)', async () => {
    const injected = [];
    const router = createJournalMediaRouter({
      fetchMedia: vi.fn().mockResolvedValue({ buffer: Buffer.from('x'), contentType: 'image/png' }),
      transcribe: vi.fn(),
      buildSavedBlocks: vi.fn().mockReturnValue({
        blocks: [{ type: 'text', text: 'look at this\n\n[annotation]' }],
        ivHandled: true,
      }),
      injectText: vi.fn().mockReturnValue(true),
      injectBlocks: vi.fn((session, blocks) => { injected.push(blocks); return true; }),
      echoToRoom: vi.fn(),
      publishNotice: vi.fn(),
    });
    await router({ claudeSessionId: 'c1' }, { type: 'image', blobRef: 'b1', contentType: 'image/png', name: 's.png', caption: 'look at this' }, {});

    expect(injected[0]).toHaveLength(1);
    expect(injected[0][0].text).toContain('look at this');
  });

  it('keeps the legacy bare-array seam working with no caption change', async () => {
    const injected = [];
    const router = createJournalMediaRouter({
      fetchMedia: vi.fn().mockResolvedValue({ buffer: Buffer.from('x'), contentType: 'image/png' }),
      transcribe: vi.fn(),
      buildSavedBlocks: vi.fn().mockReturnValue([{ type: 'text', text: 'File saved to /tmp/x' }]),
      injectText: vi.fn().mockReturnValue(true),
      injectBlocks: vi.fn((session, blocks) => { injected.push(blocks); return true; }),
      echoToRoom: vi.fn(),
      publishNotice: vi.fn(),
    });
    await router({ claudeSessionId: 'c1' }, { type: 'image', blobRef: 'b1', contentType: 'image/png', name: 's.png', caption: null }, {});
    expect(injected[0]).toHaveLength(1);
  });
```

(Adapt the router construction/session fixtures to the file's existing helpers; keep the busy-queue seam untested here — caption rides inside the built blocks, so queueing needs nothing.)

- [ ] **Step 2: Run to verify failure** — `(cd /opt/matron/bridge-journal && npm test -- journal-media)` → FAIL.

- [ ] **Step 3: Implement**

`lib/journal-media.js` `routeOne`: destructure `caption` — `const { type, blobRef, contentType, name, dims, caption } = media || {};`.

**Audio branch (round-2 Codex B2 — captions must survive transcription):** the
`audioMime` branch returns before `buildSavedBlocks`, so thread the caption
there too — both delivery shapes:

```js
        const injected = caption
          ? `${caption}\n\n[Voice note transcription]: ${transcript}`
          : `[Voice note transcription]: ${transcript}`;
```

(the busy-queue path already queues `injected` inside its text block, so both
immediate `injectText` and queued delivery carry the caption). Add a test:
captioned `audio/*` media → the injected/queued text starts with the caption
and contains the transcript.

Then replace the save-branch block construction:

```js
      // image / other file: save + attach exactly like the Matrix media path.
      const built = buildSavedBlocks(session, { buffer, mime, isImage: type === 'image', name, dims, caption: caption || null });
      const blocks = Array.isArray(built) ? built : (built && Array.isArray(built.blocks) ? built.blocks : []);
      const ivHandled = !Array.isArray(built) && !!(built && built.ivHandled);
      // ROUND-3 FIX (Codex B1): the empty-media guard runs BEFORE the caption
      // append — a caption must never turn an empty builder result into a
      // caption-only injection with the file silently missing (P19: validate,
      // then mutate). Regression test: captioned media + empty builder output
      // → dropped, publishNotice fires, nothing injected.
      if (!Array.isArray(blocks) || blocks.length === 0) {
        warn(`[journal-media] media produced no blocks for convo=${convoId} — dropping`);
        return;
      }
      if (caption && !ivHandled) blocks.push({ type: 'text', text: caption });
```

(The existing `if (!Array.isArray(blocks) || blocks.length === 0)` warn/drop
block at the original position is REPLACED by the guard above — delete it so
the check runs exactly once, before the caption append. The queue and inject
code below it stay unchanged — they operate on `blocks`.)

`index.js` wiring (~5914-5921) becomes:

```js
  buildSavedBlocks: (session, { buffer, mime, isImage, name, dims, caption }) => {
    const safeName = safeMediaFilename(name);
    return buildSavedMediaBlocks(session, {
      buffer, mime, dims: dims || undefined, isImage,
      ivFilename: safeName, ivCaption: caption ?? null, workdirName: safeName,
    });
  },
```

(Returns the `{ blocks, ivHandled }` object; iv mode folds via `ivUploadAnnotation` with the caption now fed; non-iv gets the `routeOne` tail-append. Update the wiring's comment block to describe the caption contract.)

- [ ] **Step 4: Run the FULL bridge suite** — `(cd /opt/matron/bridge-journal && npm test)` → PASS (R702 gate; existing media tests must stay green under the widened seam).

- [ ] **Step 5: Commit**

```bash
git -C /opt/matron/bridge-journal add lib/journal-media.js index.js test/journal-media.test.js
git -C /opt/matron/bridge-journal -c user.name=easelyte -c user.email=fantin@easelyte.ai commit -m "feat(journal-media): deliver user captions to Claude in both iv and SDK modes"
```

---

## Phase 5 — Verification + held PRs

### T-5.1: Bridge push + held PR

**Files:** none (git/gh only).

- [ ] **Step 1: Verify origin + suite** — ROUND-3 FIX (Codex B2): the checkout
  legitimately carries `upstream` = Matronhq (never pushed); the executable
  gate is on ORIGIN specifically:
  `git -C /opt/matron/bridge-journal remote get-url origin` MUST equal
  `https://github.com/easelyte/claude-matrix-bridge.git` (halt otherwise, per
  `procedure_verify_origin_before_push_external_repos`); every push in this
  task explicitly names `origin`. Then `(cd /opt/matron/bridge-journal && npm test)` green.
- [ ] **Step 2: Push + PR (held)**

```bash
git -C /opt/matron/bridge-journal push -u origin feat/journal-media-captions
gh pr create --repo easelyte/claude-matrix-bridge --base journal-deploy --head feat/journal-media-captions \
  --title "journal media: deliver user captions to Claude (iv + SDK modes)" \
  --body "Consumer half of easelyte/matron-web upload-caption-modal. Extracts payload.caption (trim + 4096 clamp) in journal-input-router, threads it through journal-media, folds via ivUploadAnnotation in iv mode and tail-appends a text block in SDK mode (the live default, MATRON_INTERACTIVE_MODE=0). Additive + backwards-compatible. HELD for operator review — deploy BEFORE the web PR per the spec's Delivery section. Spec: matron-web docs/superpowers/specs/2026-07-17-web-upload-caption-modal-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Restore the live checkout branch** — `git -C /opt/matron/bridge-journal checkout journal-deploy` (service keeps running the deployed code; the feature branch lives on the remote until the operator merges).

### T-5.2: Web verification + held PR (ship gate)

**Files:** none (verification + ship).

- [ ] **Step 1: Full web gate** — `(cd /opt/matron/web-journal && corepack pnpm test)` all green; run `corepack pnpm lint` if a lint script exists in `package.json` (check first; PR #1 era had none — skip silently if absent).
- [ ] **Step 2: Ship via `/ship-slim --no-auto-merge`** (execute-slim's tail) — PR on `easelyte/matron-web` base `main`, head `feat/upload-caption-modal`. PR body must state: the wire contract (`payload.caption`, trim→omit), the bridge-first deploy order + link to the bridge PR, and that the operator live-tests via `webapp/` backup + `corepack pnpm build` before merging. **Do NOT merge; do NOT build/deploy `webapp/`** — both operator-gated.
- [ ] **Step 3: File the P18 follow-up loop** (spec Risks commitment; round-1 M6 widened it; round-3 M1 made it executable) — run from the son-of-anton WORKSPACE ROOT (`/root/.openclaw/workspace` — canonical loop store; a worktree copy must resolve via the canonical root per the loop-store procedures):

```bash
python3 - <<'EOF'
from scripts.lib.open_loops_store import add_loop
add_loop({
    "title": "matron-web-journal-client-file-splits",
    "status": "active",
    "priority": 4,
    "opened": "<today ISO8601Z>",
    "owner": "operator",
    "description": "P18 cognitive-budget follow-up from the upload-caption-modal feature (spec matron-web docs/superpowers/specs/2026-07-17-web-upload-caption-modal-design.md): split matron-web src/journal/components.tsx (~1.8k lines post-feature) and client.ts (~1.4k lines, +10 methods) into focused modules. Repo easelyte/matron-web, /opt/matron/web-journal.",
    "next_action": {
        "action_id": "split-matron-web-journal-client-files",
        "type": "cleanup",
        "priority": 4,
    },
})
EOF
```

(Commit the store change as a separate `chore(loops): ...` commit on son-of-anton main per the loop-store procedures. `next_action.type` uses the locked enum — `cleanup` is valid.)

---

## Spec-coverage map

| Spec section | Tasks |
|---|---|
| Wire shape + single payload builder | T-1.2 |
| Staging state (types, stageFiles precedence, cancel, teardown) | T-1.1, T-2.2 |
| confirmStagedFile §1-4 (reservation, check-act ×2, persist-then-advance, chain guards, rejection isolation) | T-2.3 (machine), T-2.1 (phases) |
| skipStagedFile / cancel semantics | T-2.3, T-2.2 |
| Modal UI (preview, remount, keyboard/IME, buttons, focus, paste exactly-once, pre-flight, error states, ARIA, object-URLs) | T-3.1, T-3.2 |
| Entry-point rewires + structural guards + drop ordering | T-3.2 |
| Render additions (file tile, chip, snippet, errorMessage preference) | T-1.1 (snippet), T-3.3 |
| Part 2 §1-3 (bridge extract/clamp, thread, both-modes fold) | T-4.1, T-4.2 |
| Edge cases | encoded as tests across T-2.3 / T-3.x (each edge case has a named test) |
| Testing §web 1-18 | T-1.1 (18 partial via snippet), T-1.2 (1-3), T-2.x (4-12), T-3.x (11-18) |
| Testing §bridge 1-3 | T-4.1 (1), T-4.2 (2-3) |
| Delivery §1-7 (gates, held PRs, deploy/rollback runbook) | T-5.1, T-5.2; deploy/rollback steps are OPERATOR-run post-merge (runbook lives in the spec, not re-executed by this plan) |
| Risks (P18 loop commitment) | T-5.2 step 3 |

Deliberate exceptions (right-sizing): focus-trap is the modal's autofocus + inert-actions contract, not a full roving-tabindex implementation (small custom app; Tab-cycle assertion dropped — the structural guards are what's load-bearing, per spec round-2 resolution). IME guard is the simplified `isComposing || 229` form (spec Risks, accepted). **Persist-timeout: OSCILLATION OVERRIDE (locked)** — the bounded-vs-unbounded persist await flipped three times across reviews (spec r5 demanded a ceiling; plan r1 showed the ceiling ghost-writes an orphan row; plan r2 re-demanded a ceiling). Per the reviewer-oscillation stop rule, the documented decision stands: NO artificial timeout; `confirming` holds until the IndexedDB put settles; a never-settling put is browser-broken territory where refresh is the escape (unconfirmed staging is re-pickable). An abortable/transaction-aware persistence layer is out of scope for this feature — reviewers must not re-litigate this point; it is an accepted, documented tradeoff.

---

## Plan self-review notes

- No placeholders; every code step carries real code. Helper names referenced from existing tests (`fakeDatabase`, `signedInState`, `fileFixture`, `internals`, `renderClient`, `button`) exist in the current suites — implementers adapt call shapes to the exact local helpers rather than inventing new harnesses.
- Type consistency: `confirmStagedFile(itemId, caption?)` / `skipStagedFile(itemId)` / `stageFiles(files)` / `cancelStagedFiles()` used identically in T-2.3, T-3.1, T-3.2 tests and implementations; `StagedUploads`/`StagedUploadItem` defined once (T-1.1).
- Principles: P2 (one size-constant owner, one payload builder), P3 (in-modal errors, persisted evidence), P5/P31 (`key` on item id), P19 (check at confirm AND at act), P23 (`confirming` lock + `persistError`/`error` explicit states), P32 (head-id + lock idempotency), P35 (all code coordinates grep-confirmed 2026-07-17 against the live checkouts), P38 (spec/tests/delivery aligned), R702 (bridge suite gates deploy).

---

## Appendix: Verified Claims (research pass 2026-07-17)

No externally verifiable load-bearing claims required web research. All load-bearing grounding is INTERNAL and was grep-confirmed against the live checkouts on 2026-07-17 during spec review rounds 1-5:

✓ Journal server passes `payload` through opaquely on the `send` op — verified `/opt/matron/journal/src/ws.js` ~388-402.
✓ `buildSavedMediaBlocks` returns `{ blocks, ivHandled }` and folds `ivCaption` only in the `session.iv` branch — verified `/opt/matron/bridge-journal/index.js` ~4365-4418.
✓ Live bridge default is non-iv (`MATRON_INTERACTIVE_MODE=0` in `/opt/matron/bridge-journal/.env`).
✓ `retryAttachment` branch coverage (`upload_failed`/`storage_failed` re-upload vs `blobRef`-required re-emit) — verified `client.ts` ~480-527; drives the `upload_failed` classification for archived-mid-queue items.
✓ Bridge repo merges are true merge commits (`git log --graph`), so `git revert -m 1` topology holds; plan pins `gh pr merge --merge` regardless.

? Platform idioms treated as standard (not researched): DOM `textarea.maxLength`, `isComposing || keyCode === 229` IME guard, `URL.createObjectURL`/`revokeObjectURL` lifecycle, React `key`-remount semantics. Reviewers: challenge if any is load-bearing in a way that isn't actually standard — note the existing components-test suite already exercises synthetic paste/drag events under this jest environment.
