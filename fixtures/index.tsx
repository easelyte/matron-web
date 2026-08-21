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

import { JournalApiError } from "../src/journal/api";
import { archiveStore, favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../src/journal/client";
import { MatronApp } from "../src/journal/components";
import type { FileEntry, FileListing, FileMeta, FilesApiLike } from "../src/journal/files/filesApi";
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
// diff card, permission card, agent-spawn card + its resolved spawn_outcome row, and own
// (user) bubbles. ts is epoch-seconds.
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
    {
        seq: 2,
        convo_id: "c1",
        ts: T + 60,
        sender: "agent:claude",
        type: "text",
        payload: { body: "To swap prod I need to restart nginx." },
    },
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
    {
        seq: 5,
        convo_id: "c1",
        ts: T + 240,
        sender: "user:operator",
        type: "text",
        payload: { body: "and watch the error rate for 10 minutes after" },
    },
    {
        seq: 6,
        convo_id: "c1",
        ts: T + 300,
        sender: "agent:claude",
        type: "tool_output",
        payload: {
            command: "systemctl restart nginx && systemctl status nginx",
            exit_code: 0,
            snippet:
                "● nginx.service - A high performance web server\n     Active: active (running) since Fri 10:06:02 UTC\n     Process: 24518 ExecReload (code=exited, status=0/SUCCESS)",
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
        payload: {
            question: "Queued (1) — send these now, or cancel and keep editing?",
            options: ["Send now", "Cancel"],
        },
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
    {
        seq: 13,
        convo_id: "c1",
        ts: T + 660,
        sender: "user:operator",
        type: "prompt_reply",
        payload: { target_seq: 12, choice: "Staging" },
    },
    {
        // Agent-spawn consent card, resolved (see seq 15's spawn_outcome below) — Started +
        // Open chrome. room_id points at s1, an existing fixture conversation, so the Open
        // button is a genuine navigable target in the harness.
        seq: 14,
        convo_id: "c1",
        ts: T + 720,
        sender: "agent:claude",
        type: "permission_request",
        payload: {
            kind: "agent_spawn",
            request_id: "spawn-fixture-1",
            from_device_id: 1,
            from_name: "claude",
            from_convo_id: "c1",
            from_convo_title: "matron-web · deploy",
            target_device_id: 4,
            target_name: "eric",
            workdir: "/opt/matron/web-journal",
            task: "Chase down the flaky upload-timeout test and either fix it or quarantine it with a linked issue.",
            topic: "Flaky test triage",
        },
    },
    {
        // Durable resolution of the ask above. Renders twice: the card at seq 14 flips to its
        // resolved Started+Open state, and this event itself renders the standalone
        // spawn_outcome timeline row (for once the card has scrolled out of view).
        seq: 15,
        convo_id: "c1",
        ts: T + 780,
        sender: "journal",
        type: "spawn_outcome",
        payload: { request_id: "spawn-fixture-1", outcome: "started", room_id: "s1", child_convo_id: "s1" },
    },
    {
        // Surface B — an inline message from another AI session (durable .mj_PeerMessage block).
        seq: 20,
        convo_id: "c1",
        ts: T + 820,
        sender: "peer:design",
        type: "peer_message",
        payload: {
            from_convo: "peer-design",
            from_name: "Design Session",
            from_kind: "claude",
            body: "Landed the pinned-summary surface — migrating the peer block off inline styles next.",
        },
    },
    {
        // Same peer session speaking again — each peer message keeps its own full header
        // (from_convo-aware continuation grouping is a follow-up; see journal.pcss note).
        seq: 21,
        convo_id: "c1",
        ts: T + 840,
        sender: "peer:design",
        type: "peer_message",
        payload: {
            from_convo: "peer-design",
            from_name: "Design Session",
            from_kind: "claude",
            body: "Continuation line: same session, tightened top, no repeated header.",
        },
    },
    {
        // Surface B priority variant (loop #688) — louder marker, never a focus steal.
        seq: 22,
        convo_id: "c1",
        ts: T + 860,
        sender: "peer:release",
        type: "peer_message",
        payload: {
            from_convo: "peer-release",
            from_name: "Release Bot",
            from_kind: "codex",
            body: "Priority: prod error rate crossed 1% — needs a look before the next deploy.",
            priority: true,
        },
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
        // id-driven limits (v5+ bridge): ctx is synthesized from context; the rest carry
        // stable ids → short tags 5h/fbl/wk/cpu/ram + column-first 3×2 grid order.
        limits: [
            { id: "week_all", label: "Week (all models)", percent: 63, resets: "4d" },
            { id: "session_5h", label: "Session", percent: 41, resets: "3h20" },
            // host_ram: FRESH sample (10s old) → renders normally. host_cpu: STALE (4m old,
            // past HOST_VITALS_STALE_MS=60s) → renders dimmed with "last sampled 4m ago" in the
            // accessible name. Contact sheet shows the fresh vs stale host-vital states together.
            { id: "host_ram", label: "Host RAM", percent: 55, unit: "%", sampled_at_ms: Date.now() - 10_000 },
            { id: "week_fable", label: "Week (Fable)", percent: 22, resets: "4d" },
            { id: "host_cpu", label: "Host CPU", percent: 34, unit: "%", sampled_at_ms: Date.now() - 240_000 },
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

// A real (decodable) 8x8 PNG so the harness image-preview path renders a true thumbnail
// instead of a broken-image glyph (garbage bytes don't decode).
const PNG_8X8 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVR42mNkYPhfz0AEYBxVSF+Fo25EGwUAaOQF/S2Q6iEAAAAASUVORK5CYII=";
const imageFile = (name: string): File =>
    new File([Uint8Array.from(atob(PNG_8X8), (c) => c.charCodeAt(0))], name, { type: "image/png" });

// Stub mediaUrl for the §6 thread media events: image tiles decode this data URL (the frame
// reserves its box from the payload dims regardless of the decoded pixels), file tiles only
// call mediaUrl on click so their tiles render icon-first without hitting the network.
(client as unknown as { mediaUrl: (id: string) => Promise<string> }).mediaUrl = async (id: string) =>
    id.startsWith("img") ? `data:image/png;base64,${PNG_8X8}` : `data:application/octet-stream;base64,`;

// ── Files pane fixture (Phase 1b) ─────────────────────────────────────────────────────────────
// A mock FilesApi returning canned data so the harness can shoot every Files state (list, each
// preview kind, empty, error/denied, truncated) in both themes without a live backend. Mirrors
// how mediaUrl is stubbed above.
const FILES_ROOT = "/root/.openclaw/workspace";
const MIME: Record<string, string> = {
    md: "text/markdown",
    ts: "text/plain",
    png: "image/png",
    pdf: "application/pdf",
    txt: "text/plain",
    css: "text/css",
    zip: "application/zip",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
};
const TEXT_EXT = new Set(["md", "ts", "txt", "css"]);
const extOf = (name: string): string => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
const MINIMAL_PDF =
    "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAyMDAgMjAwXT4+CmVuZG9iagp4cmVmCjAgNAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA0L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMTkwCiUlRU9GCg==";
const ROOT_ENTRIES: FileEntry[] = [
    { name: "src", kind: "dir", size: 0, mtime: T * 1000, mime: "" },
    { name: "docs", kind: "dir", size: 0, mtime: T * 1000, mime: "" },
    { name: "big-dir", kind: "dir", size: 0, mtime: T * 1000, mime: "" },
    { name: "empty-dir", kind: "dir", size: 0, mtime: T * 1000, mime: "" },
    { name: "denied-dir", kind: "dir", size: 0, mtime: T * 1000, mime: "" },
    { name: ".gitignore", kind: "file", size: 84, mtime: T * 1000, mime: "text/plain" },
    { name: "README.md", kind: "file", size: 4310, mtime: T * 1000 - 3_600_000, mime: "text/markdown" },
    { name: "client.ts", kind: "file", size: 10_240, mtime: T * 1000 - 86_400_000, mime: "text/plain" },
    { name: "theme.css", kind: "file", size: 2048, mtime: T * 1000 - 200_000_000, mime: "text/css" },
    { name: "diagram.png", kind: "file", size: 18_224, mtime: T * 1000 - 5_000_000, mime: "image/png" },
    { name: "report.pdf", kind: "file", size: 240_512, mtime: T * 1000 - 9_000_000, mime: "application/pdf" },
    { name: "notes.txt", kind: "file", size: 512, mtime: T * 1000 - 600_000, mime: "text/plain" },
    { name: "archive.zip", kind: "file", size: 5_242_880, mtime: T * 1000 - 400_000_000, mime: "application/zip" },
];
const CODE_SAMPLE = [
    "export function greet(name: string): string {",
    "    // A short sample so CodePreview shows real highlighting.",
    "    const parts = [`Hello, ${name}!`, 'Welcome to Matron.'];",
    "    return parts.join(' ');",
    "}",
    "",
    "const answer = 42;",
].join("\n");
const README_SAMPLE = [
    "# Matron File Explorer",
    "",
    "Browse the working tree from **desktop or phone**, with inline preview.",
    "",
    "- Markdown, code, images, PDF, media",
    "- Path-jailed server-side; secrets never served",
    "",
    "```bash",
    "curl -s /journal/files/list?path=/root/.openclaw/workspace",
    "```",
].join("\n");

const mockFilesApi: FilesApiLike = {
    listDir: async (path: string, all?: boolean): Promise<FileListing> => {
        if (path.endsWith("denied-dir")) throw new JournalApiError("denied", 403, "forbidden");
        const base = { path, parent: path === FILES_ROOT ? null : FILES_ROOT };
        if (path.endsWith("empty-dir")) return { ...base, entries: [], truncated: false };
        if (path.endsWith("big-dir")) {
            const entries: FileEntry[] = Array.from({ length: 2000 }, (_unused, index) => ({
                name: `file-${String(index).padStart(4, "0")}.log`,
                kind: "file" as const,
                size: 1024 + index,
                mtime: T * 1000 - index * 1000,
                mime: "text/plain",
            }));
            return { ...base, entries, truncated: true };
        }
        const entries = all ? ROOT_ENTRIES : ROOT_ENTRIES.filter((entry) => !entry.name.startsWith("."));
        return { ...base, entries, truncated: false };
    },
    fileMeta: async (path: string): Promise<FileMeta> => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        const ext = extOf(name);
        const match = ROOT_ENTRIES.find((entry) => entry.name === name);
        return {
            kind: "file",
            size: match?.size ?? 1024,
            mtime: match?.mtime ?? T * 1000,
            mime: MIME[ext] ?? "application/octet-stream",
            isText: TEXT_EXT.has(ext),
        };
    },
    textContent: async (path: string): Promise<string> => {
        if (path.endsWith(".md")) return README_SAMPLE;
        if (path.endsWith(".ts")) return CODE_SAMPLE;
        if (path.endsWith(".css")) return ":root {\n    --brand: #ffe500;\n}\n";
        return "Plain text notes.\nSecond line.\n";
    },
    contentUrl: async (path: string): Promise<string> => {
        if (path.endsWith(".png")) return `data:image/png;base64,${PNG_8X8}`;
        if (path.endsWith(".pdf")) return MINIMAL_PDF;
        if (path.endsWith(".mp3")) return "data:audio/mpeg;base64,";
        if (path.endsWith(".mp4")) return "data:video/mp4;base64,";
        return "data:application/octet-stream;base64,";
    },
    download: async (): Promise<void> => {},
    revokeAll: (): void => {},
};
(client as unknown as { filesApi: () => FilesApiLike }).filesApi = () => mockFilesApi;
const patchState = (client as unknown as { patch: (update: Partial<ClientState>) => void }).patch.bind(client);

// Expose hooks so the Playwright driver can drive states (stage files → upload modal, etc.).
(window as unknown as { __matron: unknown }).__matron = {
    client,
    openFiles: (path: string = FILES_ROOT) => patchState({ filesView: { open: true, path } }),
    closeFiles: () => patchState({ filesView: undefined }),
    stageImage: (name = "screenshot.png") => client.stageFiles([imageFile(name)]),
    // Single NON-image file → hatched "image preview" placeholder + the single-file case
    // (no thumbnail strip, no "n of N" pill).
    stageDoc: () =>
        client.stageFiles([new File([new Uint8Array(1024)], "deploy-runbook.pdf", { type: "application/pdf" })]),
    stageTwo: () =>
        client.stageFiles([
            imageFile("Screenshot 2026-07-25 at 10.12.05.png"),
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
