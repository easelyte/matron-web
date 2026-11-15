/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// Replays the decoder extracts of the pinned conformance package: every sample frame
// goes through the app's decoder, and its store effect is checked against the real
// store and client. No server is involved. Set MATRON_CONFORMANCE_TARBALL (the packed
// .tgz) or MATRON_CONFORMANCE_DIR (an extracted copy); without either the suite is
// skipped. `pnpm conformance` is the strict entry point and fails when the package is missing.

import "fake-indexeddb/auto";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { MatronJournalClient } from "../../../src/journal/client";
import { JournalDatabase } from "../../../src/journal/database";
import { decodeServerFrame } from "../../../src/journal/frame-decode";
import type { JournalEvent, ServerFrame, SnapshotResponse } from "../../../src/journal/types";
import pin from "../../conformance/package-pin.json";

interface Extract {
    type: string;
    surface: string;
    samples: Array<{ source: string; frame: Record<string, unknown> }>;
}

function packageDir(): string | undefined {
    let dir = process.env.MATRON_CONFORMANCE_DIR;
    const tarball = process.env.MATRON_CONFORMANCE_TARBALL;
    if (!dir && tarball) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "matron-conformance-"));
        execFileSync("tar", ["-xzf", tarball, "-C", dir, "--strip-components=1"]);
    }
    if (!dir) return undefined;
    const digest = crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(dir, "manifest.json")))
        .digest("hex");
    if (digest !== pin.manifestSha256) {
        throw new Error(`conformance package ${digest} does not match the pin ${pin.manifestSha256} (${pin.version})`);
    }
    return dir;
}

// Frame kinds the package covers that the app passes through without handling (the decoder
// forwards unknown kinds on purpose). Each one is a gap to close, not a pass.
const UNHANDLED_KINDS = new Set(["summary"]);

const dir = packageDir();
const extracts: Extract[] = dir
    ? fs
          .readdirSync(path.join(dir, "payloads"))
          .sort()
          .map((name) => JSON.parse(fs.readFileSync(path.join(dir, "payloads", name), "utf8")) as Extract)
    : [];

const describeWithPackage = dir ? describe : describe.skip;

function conversationRow(id: string, lastSeq: number): SnapshotResponse["conversations"][number] {
    return {
        id,
        title: "Sample",
        session_state: "running",
        last_seq: lastSeq,
        unread_count: 0,
        snippet: "",
        created_at: 1,
    };
}

async function freshDatabase(snapshot: SnapshotResponse): Promise<JournalDatabase> {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    const database = await JournalDatabase.open("https://journal.example", 1, "alice");
    await database.replaceWithSnapshot(snapshot);
    return database;
}

describeWithPackage(`conformance extracts (package ${pin.version})`, () => {
    it("has extracts to replay", () => {
        expect(extracts.length).toBeGreaterThan(0);
    });

    describe("decode", () => {
        const ws = extracts.filter((extract) => extract.surface === "ws");
        for (const extract of ws) {
            it(`${extract.type}: the decoder keeps every sample frame as it is`, () => {
                for (const sample of extract.samples) {
                    const decoded = decodeServerFrame(sample.frame);
                    if (!decoded.ok) throw new Error(`${sample.source}: dropped (${decoded.reason})`);
                    // A narrowed sub-shape or an unknown kind means the app reads the frame differently
                    // from the journal's wire shape.
                    expect({
                        source: sample.source,
                        narrowed: decoded.narrowed,
                        unknownKind: decoded.unknownKind,
                    }).toEqual({
                        source: sample.source,
                        narrowed: undefined,
                        unknownKind:
                            decoded.unknownKind && UNHANDLED_KINDS.has(decoded.unknownKind)
                                ? decoded.unknownKind
                                : undefined,
                    });
                    expect(decoded.frame).toEqual(sample.frame);
                }
            });
        }
    });

    describe("store effect", () => {
        const journalFrames = extracts.filter((extract) => extract.type.startsWith("ws.journal."));
        for (const extract of journalFrames) {
            it(`${extract.type}: a journal row is applied and moves the cursor`, async () => {
                for (const sample of extract.samples) {
                    const event = sample.frame as unknown as JournalEvent;
                    const database = await freshDatabase({
                        seq: event.seq - 1,
                        conversations: [conversationRow(event.convo_id, event.seq - 1)],
                    });
                    expect({ source: sample.source, applied: await database.applyJournal(event) }).toEqual({
                        source: sample.source,
                        applied: true,
                    });
                    expect(await database.cursor()).toBe(event.seq);
                    if (event.type === "text") {
                        const stored = await database.events(event.convo_id);
                        expect(stored.map((row) => row.payload.body)).toContain(event.payload.body);
                    }
                    database.close();
                }
            });
        }

        it("http.get.snapshot.200: a snapshot replaces the store", async () => {
            const snapshots = extracts.find((extract) => extract.type === "http.get.snapshot.200");
            expect(snapshots).toBeDefined();
            for (const sample of snapshots!.samples) {
                const snapshot = sample.frame as unknown as SnapshotResponse;
                const database = await freshDatabase(snapshot);
                expect({ source: sample.source, cursor: await database.cursor() }).toEqual({
                    source: sample.source,
                    cursor: snapshot.seq,
                });
                const rows = await database.conversations();
                expect(rows.map((row) => row.id).sort()).toEqual(snapshot.conversations.map((row) => row.id).sort());
                database.close();
            }
        });

        it("ws.ephemeral.tool_stream: the client builds the live tool card from the frames", async () => {
            const toolStreams = extracts.find((extract) => extract.type === "ws.ephemeral.tool_stream");
            expect(toolStreams).toBeDefined();
            for (const sample of toolStreams!.samples) {
                const frame = sample.frame as {
                    convo_id: string;
                    message_ref: string;
                    tool_stream: Record<string, unknown>;
                };
                const client = new MatronJournalClient();
                const internals = client as unknown as {
                    database?: JournalDatabase;
                    handleFrame(frame: ServerFrame): Promise<void>;
                    toolStreams: Map<string, Record<string, { content: string; offset: number }>>;
                };
                internals.database = await freshDatabase({ seq: 0, conversations: [] });
                await internals.handleFrame(frame as unknown as ServerFrame);
                const card = internals.toolStreams.get(frame.convo_id)?.[frame.message_ref];
                const expected = (
                    frame.tool_stream.event === "sync" ? frame.tool_stream.content : frame.tool_stream.chunk
                ) as string;
                expect({ source: sample.source, content: card?.content }).toEqual({
                    source: sample.source,
                    content: expected,
                });
                internals.database.close();
            }
        });
    });
});
