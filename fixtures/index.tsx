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
    // Subagents of the selected conversation (c1) — drive the header SUBAGENTS strip.
    {
        id: "s1",
        title: "test triage",
        session_state: "running",
        last_seq: 4,
        unread_count: 0,
        snippet: "32 tests fixed, 1 quarantined",
        created_at: 1,
        parent_convo_id: "c1",
        read_up_to_seq: 4,
    },
    {
        id: "s2",
        title: "docs sweep",
        session_state: "done",
        last_seq: 2,
        unread_count: 0,
        snippet: "swept 14 files",
        created_at: 1,
        parent_convo_id: "c1",
        read_up_to_seq: 2,
    },
];

// A representative thread that exercises EVERY content renderer so the harness shows the
// real shapes/fonts/bubbles: fenced code, plain markdown, exec tool_output card, doc-edit
// diff card, permission card, and own (user) bubbles. ts is epoch-seconds.
const T = 1_782_000_000;
const DAY_MS = 86_400_000;
const events: JournalEvent[] = [
    {
        // A prior-calendar-day event so the timeline renders TWO date dividers (one before this
        // opening turn, one when the day rolls over to the main T-day thread below).
        seq: 0,
        convo_id: "c1",
        ts: T - DAY_MS - 3600,
        sender: "user:operator",
        type: "text",
        payload: { body: "kicking this off — reskin the journal client end to end" },
    },
    {
        seq: 1,
        convo_id: "c1",
        ts: T,
        sender: "agent:claude",
        type: "text",
        payload: {
            body: "```nginx\nlocation /journal/ {\n    proxy_pass http://127.0.0.1:9810/;\n    proxy_read_timeout 3600s;  # websocket frames\n}\n```",
        },
    },
    { seq: 2, convo_id: "c1", ts: T + 60, sender: "agent:claude", type: "text", payload: { body: "To swap prod I need to restart nginx." } },
    {
        seq: 3,
        convo_id: "c1",
        ts: T + 120,
        sender: "agent:claude",
        type: "permission_request",
        payload: {
            description: "Run `systemctl restart nginx` on prod?",
            question: "Run `systemctl restart nginx` on prod?",
            options: ["Allow", "Always allow", "Deny"],
        },
    },
    { seq: 4, convo_id: "c1", ts: T + 180, sender: "user:operator", type: "text", payload: { body: "yes" } },
    { seq: 5, convo_id: "c1", ts: T + 240, sender: "user:operator", type: "text", payload: { body: "and watch the error rate for 10 minutes after" } },
    {
        seq: 6,
        convo_id: "c1",
        ts: T + 300,
        sender: "agent:claude",
        type: "tool_output",
        payload: {
            command: "systemctl restart nginx && systemctl status nginx",
            exit_code: 0,
            snippet: "● nginx.service - A high performance web server\n     Active: active (running) since Fri 10:06:02 UTC\n     Process: 24518 ExecReload (code=exited, status=0/SUCCESS)",
        },
    },
    {
        seq: 7,
        convo_id: "c1",
        ts: T + 360,
        sender: "agent:claude",
        type: "diff",
        payload: {
            tool: "Edit",
            file_path: "nginx/conf.d/journal.conf",
            added: 2,
            removed: 1,
            diff: "@@ -1,3 +1,4 @@\n location /journal/ {\n     proxy_pass http://127.0.0.1:9810/;\n-    proxy_read_timeout 60s;\n+    proxy_read_timeout 3600s;\n+    proxy_buffering off;\n }",
        },
    },
    {
        seq: 8,
        convo_id: "c1",
        ts: T + 420,
        sender: "agent:claude",
        type: "text",
        payload: {
            body: "Restarted. Error rate steady at **0.02%** over the last 10 minutes — dashboards clean, websocket reconnects normal.\n\n```nginx\nlocation /journal/ {\n    proxy_pass http://127.0.0.1:9810/;\n    proxy_read_timeout 3600s;\n}\n```\n\nBackups rotated: oldest three pruned, latest verified with a test restore. Kept [webapp.bak.20260724T100212Z](https://example.test/bak) as the rollback point.",
        },
    },
    {
        // Unrecognised event type → diagnostic .mj_Unknown card (dashed border on raised).
        seq: 9,
        convo_id: "c1",
        ts: T + 480,
        sender: "agent:claude",
        type: "telemetry_snapshot",
        payload: { cpu: 0.42, mem: "1.8GB", note: "unrecognised event → diagnostic card, never hidden" },
    },
    // A user message so the prompt below starts a NEW section (first-in-section) — this is
    // the case where a duplicate timestamp (profile row + card header) would show if the
    // card didn't own its timestamp.
    { seq: 10, convo_id: "c1", ts: T + 520, sender: "user:operator", type: "text", payload: { body: "go ahead" } },
    {
        // Question card — UNANSWERED (label+time / gutter mail icon + body / Send now·Cancel).
        seq: 11,
        convo_id: "c1",
        ts: T + 540,
        sender: "agent:claude",
        type: "prompt",
        payload: { question: "Queued (1) — send these now, or cancel and keep editing?", options: ["Send now", "Cancel"] },
    },
    {
        // Question card — ANSWERED (green check + resolution line); seq 13 reply resolves it.
        seq: 12,
        convo_id: "c1",
        ts: T + 600,
        sender: "agent:claude",
        type: "prompt",
        payload: { question: "Which environment should I deploy to?", options: ["Staging", "Production"] },
    },
    { seq: 13, convo_id: "c1", ts: T + 660, sender: "user:operator", type: "prompt_reply", payload: { target_seq: 12, choice: "Staging" } },
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

// Stub the new-session data path so a driver click on "New session" reaches the folders
// form (agent → recent folders) where the themed inputs / checkbox / Start live.
(client as unknown as { listAgents: () => Promise<unknown[]> }).listAgents = async () => [
    { device_id: "dev-local", connected: true, label: "workstation", hostname: "workstation", name: "workstation" },
];
(client as unknown as { recentFolders: () => Promise<unknown[]> }).recentFolders = async () => [
    { path: "/opt/matron/web-journal" },
    { path: "/opt/matron/journal" },
];

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
    // Drive the child (subagent) view: select the running child s1 of parent c1 → back chip +
    // ↳ header + ringed current pill. The fixture client has no database, so selectConversation
    // no-ops; patch the state directly (mirrors the client's own patch()).
    selectChild: () =>
        (client as unknown as { patch: (update: Partial<ClientState>) => void }).patch({
            selectedConversationId: "s1",
            events: [],
            pendingMessages: [],
            sessionStatus: state.sessionStatus,
        }),
};

const container = document.getElementById("matron");
if (!container) throw new Error("fixture container missing");
createRoot(container).render(<MatronApp client={client} />);
