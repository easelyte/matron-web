/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Visual-fidelity fixture entry — NOT shipped. Mounts the REAL MatronApp with a fake
 * signed-in client (mirrors test/unit-tests/journal/components-test.ts `signedInClient`)
 * so the Playwright driver in scripts/visual/ can screenshot real components — real
 * icons, real layout, real CSS pipeline (this builds through the app's own postcss-loader
 * via webpack.fixtures.mjs) — in every state, both themes, without a login or live server.
 *
 * Playwright reaches the client via window.__matron to drive states (stage a file →
 * upload modal, etc.). Theme comes from ?theme=dark on <html data-theme>.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/fira-code/latin-400.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";

import { archiveStore, favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../src/journal/client";
import { MatronApp } from "../src/journal/components";
import type { ClientState, Conversation, JournalEvent, Session } from "../src/journal/types";
import "../src/journal/shell.pcss";
import "../src/journal/journal.pcss";

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "fixture",
    deviceId: 1,
    userId: 2,
    username: "operator@easelyte.ai",
};

const conversations: Conversation[] = [
    {
        id: "c1",
        title: "matron-web · deploy",
        session_state: "running",
        last_seq: 6,
        unread_count: 0,
        snippet: "Restarted nginx; error rate steady at 0.02%",
        created_at: 1,
        read_up_to_seq: 6,
    },
    {
        id: "c2",
        title: "infra: backup rotation",
        session_state: "idle",
        last_seq: 3,
        unread_count: 3,
        snippet: "Cron entry added for 03:15 UTC daily",
        created_at: 1,
        read_up_to_seq: 0,
    },
    {
        id: "c3",
        title: "postgres upgrade dry-run",
        session_state: "idle",
        last_seq: 2,
        unread_count: 0,
        snippet: "pg_upgrade finished · 0 errors",
        created_at: 1,
        read_up_to_seq: 2,
    },
];

const events: JournalEvent[] = [
    { seq: 4, convo_id: "c1", ts: 4, sender: "user", type: "message", payload: { body: "and watch the error rate for 10 minutes after" } },
    {
        seq: 5,
        convo_id: "c1",
        ts: 5,
        sender: "agent:claude",
        type: "message",
        payload: {
            body: "Restarted. Error rate steady at **0.02%** over the last 10 minutes — dashboards clean, websocket reconnects normal.",
        },
    },
    {
        seq: 6,
        convo_id: "c1",
        ts: 6,
        sender: "agent:claude",
        type: "prompt",
        payload: { question: "Run `systemctl restart nginx` on prod?", options: ["Allow", "Always allow", "Deny"], allows_free_text: false },
    },
];

const client = new MatronJournalClient();
const state: ClientState = {
    ...client.getSnapshot(),
    phase: "signed-in",
    session: SESSION,
    conversations,
    selectedConversationId: "c1",
    events,
    pendingMessages: [],
    connection: "online",
    sessionStatus: {
        model: "claude-sonnet",
        context: { tokens: 144_000, window: 200_000, pct: 72 },
        limits: [
            { label: "Session", percent: 41, resets: "3h20" },
            { label: "Week (all models)", percent: 63, resets: "4d" },
            { label: "Week (Sonnet 5)", percent: 78, resets: "4d" },
        ],
    },
    archivedIds: archiveStore.read(SESSION).ids,
    pinnedIds: pinnedStore.read(SESSION).ids,
    favoriteIds: favoriteStore.read(SESSION).ids,
    unreadOverrideIds: unreadStore.read(SESSION).ids,
};
// The client keeps its state private; mirror the test harness's internal override.
(client as unknown as { state: ClientState }).state = state;

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "dark" ? "dark" : "light");

// Expose hooks so the Playwright driver can drive states (stage files → upload modal, etc.).
(window as unknown as { __matron: unknown }).__matron = {
    client,
    stageImage: (name = "screenshot.png") =>
        client.stageFiles([new File([new Uint8Array(1024)], name, { type: "image/png" })]),
    stageTwo: () =>
        client.stageFiles([
            new File([new Uint8Array(1024)], "Screenshot 2026-07-25 at 10.12.05.png", { type: "image/png" }),
            new File([new Uint8Array(512)], "error-log.txt", { type: "text/plain" }),
        ]),
    setTheme: (t: string) => document.documentElement.setAttribute("data-theme", t),
};

const container = document.getElementById("matron");
if (!container) throw new Error("fixture container missing");
createRoot(container).render(<MatronApp client={client} />);
