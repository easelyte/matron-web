// design-sync fixture data + a fake signed-in client for the claude.ai/design bundle.
//
// build-pkg.mjs copies this directory to .ds-sync/pkg/src/ds/, next to the package copy of
// src/journal/, so the relative imports below resolve against ../journal/ in that layout (they
// do not resolve from .design-sync/src/ itself). Nothing here ships in the app.
//
// Mirrors fixtures/index.tsx (the repo's Playwright visual-fidelity entry), which mounts the
// real MatronApp with a patched MatronJournalClient. That file is a side-effecting script, so the
// data is re-authored here as pure exports: createFixtureClient() builds a client whose store is
// pre-patched to one of the app's surfaces, with every network edge (media URLs, the Files API,
// agent listing, recent folders) stubbed to canned data. No client here is ever initialised, so
// nothing connects, and the connection/database modules are shimmed inert on top of that.
import { JournalApiError } from "../journal/api";
import { MatronJournalClient } from "../journal/client";
import type { FileEntry, FileListing, FileMeta, FilesApiLike } from "../journal/files/filesApi";
import type {
    ClientState,
    Conversation,
    JournalEvent,
    Mission,
    MissionDetail,
    Session,
    TrackerComment,
    TrackerItem,
} from "../journal/types";
import type { WorkViewLoader } from "../journal/use-work-view";
import type { WorkViewEnvelope } from "../journal/work-view";
import workViewOk from "../journal/__tests__/fixtures/work-view-ok.json";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Anchor for every fixture timestamp: "now", so relative labels read Today / 2h ago. */
const NOW = Date.now();

export const fixtureSession: Session = {
    serverUrl: "https://journal.example",
    token: "fixture",
    deviceId: 1,
    userId: 2,
    username: "operator@example.com",
};

const PINNED_SUMMARY = [
    "• Reskinned the journal client end to end; bubbles, sidebar and header now share one scale.",
    "• Cut the deploy to a versioned release dir with a current-release pointer, so rollback is a repoint.",
    "• Restarted nginx after the cert rotation and watched the error rate for ten minutes: it held at 0.02% with no 5xx spike, no upstream resets, and no change to p99 latency, so the rotation is considered clean.",
].join("\n");

export const fixtureConversations: Conversation[] = [
    {
        id: "c1",
        title: "matron-web · deploy",
        session_state: "running",
        last_seq: 22,
        unread_count: 0,
        snippet: "Restarted nginx; error rate steady at 0.02%",
        created_at: NOW - 2 * DAY,
        last_ts: NOW - 4 * MIN,
        read_up_to_seq: 22,
        agent_kind: "claude",
        summary: PINNED_SUMMARY,
        summary_updated_at: NOW - 7 * MIN,
    },
    {
        id: "c2",
        title: "infra: backup rotation",
        session_state: "idle",
        last_seq: 3,
        unread_count: 3,
        snippet: "Cron entry added for 03:15 UTC daily",
        created_at: NOW - 3 * DAY,
        last_ts: NOW - 40 * MIN,
        read_up_to_seq: 0,
        agent_kind: "codex",
    },
    {
        id: "c3",
        title: "postgres upgrade dry-run",
        session_state: "idle",
        last_seq: 2,
        unread_count: 0,
        snippet: "pg_upgrade finished · 0 errors",
        created_at: NOW - 5 * DAY,
        last_ts: NOW - 26 * HOUR,
        read_up_to_seq: 2,
        agent_kind: "claude",
    },
    {
        id: "c4",
        title: "billing-app · invoice export",
        session_state: "done",
        session_outcome: "completed",
        last_seq: 9,
        unread_count: 0,
        snippet: "CSV export merged; totals match the ledger",
        created_at: NOW - 6 * DAY,
        last_ts: NOW - 3 * DAY,
        read_up_to_seq: 9,
        agent_kind: "claude",
    },
    // Subagents of c1: drive the SUBAGENTS strip in the header and the nested sidebar rows.
    {
        id: "s1",
        title: "test triage",
        session_state: "running",
        last_seq: 4,
        unread_count: 0,
        snippet: "32 tests fixed, 1 quarantined",
        created_at: NOW - HOUR,
        last_ts: NOW - 6 * MIN,
        parent_convo_id: "c1",
        read_up_to_seq: 4,
        agent_kind: "claude",
    },
    {
        id: "s2",
        title: "docs sweep",
        session_state: "done",
        last_seq: 2,
        unread_count: 0,
        snippet: "swept 14 files",
        created_at: NOW - 2 * HOUR,
        last_ts: NOW - 50 * MIN,
        parent_convo_id: "c1",
        read_up_to_seq: 2,
        agent_kind: "codex",
    },
];

const T = NOW - 3 * HOUR;
/** A representative thread that exercises every timeline renderer (see EventContent). */
export const fixtureEvents: JournalEvent[] = [
    {
        seq: 0,
        convo_id: "c1",
        ts: T - DAY,
        sender: "user:operator",
        type: "text",
        payload: { body: "Kicking this off: reskin the journal client end to end, then ship it." },
    },
    {
        seq: 1,
        convo_id: "c1",
        ts: T,
        sender: "agent:claude",
        type: "text",
        payload: {
            body: "Here is the proxy block I am about to deploy:\n\n```nginx\nlocation /journal/ {\n    proxy_pass http://127.0.0.1:9810/;\n    proxy_read_timeout 3600s;  # websocket frames\n}\n```",
        },
    },
    {
        seq: 2,
        convo_id: "c1",
        ts: T + MIN,
        sender: "agent:claude",
        type: "text",
        payload: { body: "To swap prod I need to restart nginx." },
    },
    {
        seq: 3,
        convo_id: "c1",
        ts: T + 2 * MIN,
        sender: "agent:claude",
        type: "permission_request",
        payload: {
            description: "Run `systemctl restart nginx` on prod?",
            question: "Run `systemctl restart nginx` on prod?",
            options: ["Allow", "Always allow", "Deny"],
        },
    },
    { seq: 4, convo_id: "c1", ts: T + 3 * MIN, sender: "user:operator", type: "text", payload: { body: "yes" } },
    {
        seq: 5,
        convo_id: "c1",
        ts: T + 4 * MIN,
        sender: "user:operator",
        type: "text",
        payload: { body: "and watch the error rate for 10 minutes after" },
    },
    {
        seq: 6,
        convo_id: "c1",
        ts: T + 5 * MIN,
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
        ts: T + 6 * MIN,
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
        ts: T + 7 * MIN,
        sender: "agent:claude",
        type: "text",
        payload: {
            body: "Restarted. Error rate steady at **0.02%** over the last 10 minutes; dashboards clean, websocket reconnects normal.\n\n- Backups rotated: oldest three pruned\n- Latest verified with a test restore\n\nKept [webapp.bak.20260724T100212Z](https://example.test/bak) as the rollback point.",
        },
    },
    {
        seq: 9,
        convo_id: "c1",
        ts: T + 8 * MIN,
        sender: "agent:claude",
        type: "image",
        payload: {
            blob_ref: "img-dashboard",
            caption: "Error rate, last 30 minutes",
            content_type: "image/png",
            dims: { w: 640, h: 360 },
        },
    },
    { seq: 10, convo_id: "c1", ts: T + 9 * MIN, sender: "user:operator", type: "text", payload: { body: "go ahead" } },
    {
        seq: 11,
        convo_id: "c1",
        ts: T + 10 * MIN,
        sender: "agent:claude",
        type: "prompt",
        payload: { question: "Which environment should I deploy to?", options: ["Staging", "Production"] },
    },
    {
        seq: 12,
        convo_id: "c1",
        ts: T + 11 * MIN,
        sender: "user:operator",
        type: "prompt_reply",
        payload: { target_seq: 11, choice: "Staging" },
    },
    {
        seq: 13,
        convo_id: "c1",
        ts: T + 12 * MIN,
        sender: "agent:claude",
        type: "item",
        payload: {
            num: 12,
            kind: "question",
            title: "Which brand colour for the tracker accent?",
            action: "created",
            awaiting: "user",
        },
    },
    {
        seq: 14,
        convo_id: "c1",
        ts: T + 13 * MIN,
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
        seq: 15,
        convo_id: "c1",
        ts: T + 14 * MIN,
        sender: "journal",
        type: "spawn_outcome",
        payload: { request_id: "spawn-fixture-1", outcome: "started", room_id: "s1", child_convo_id: "s1" },
    },
    {
        seq: 16,
        convo_id: "c1",
        ts: T + 15 * MIN,
        sender: "agent:claude",
        type: "milestone",
        payload: {
            num: 11,
            mission_num: 5,
            mission_title: "Ship the tracker web port",
            kind: "progress",
            title: "Deployed the reskin to staging",
        },
    },
    {
        seq: 20,
        convo_id: "c1",
        ts: T + 16 * MIN,
        sender: "peer:design",
        type: "peer_message",
        payload: {
            from_convo: "peer-design",
            from_name: "Design Session",
            from_kind: "claude",
            body: "Landed the pinned-summary surface; migrating the peer block off inline styles next.",
        },
    },
    {
        seq: 22,
        convo_id: "c1",
        ts: T + 18 * MIN,
        sender: "peer:release",
        type: "peer_message",
        payload: {
            from_convo: "peer-release",
            from_name: "Release Bot",
            from_kind: "codex",
            body: "Priority: prod error rate crossed 1%. Needs a look before the next deploy.",
            priority: true,
        },
    },
];

export const fixtureSessionStatus: NonNullable<ClientState["sessionStatus"]> = {
    model: "claude-opus-5",
    workdir: "/opt/matron/web-journal",
    context: { tokens: 144_000, window: 200_000, pct: 72 },
    limits: [
        { id: "week_all", label: "Week (all models)", percent: 63, resets: "4d" },
        { id: "session", label: "Session", percent: 41, resets: "3h20" },
        { id: "host_ram", label: "Host RAM", percent: 55, unit: "%", sampled_at_ms: NOW - 10_000 },
        { id: "week_fable", label: "Week (Fable)", percent: 22, resets: "4d" },
        { id: "host_cpu", label: "Host CPU", percent: 34, unit: "%", sampled_at_ms: NOW - 240_000 },
    ],
};

// ---- Tracker ------------------------------------------------------------------------------------

export const fixtureMissions: Mission[] = [
    {
        id: "ms_5",
        num: 5,
        state: "open",
        title: "Ship the tracker web port",
        body: "Port the Missions / Milestones / Decisions-Inbox surfaces onto the journal web client.",
        close_summary: null,
        closed_by: null,
        closed_over_open_items: 0,
        origin_convo_id: "c1",
        created_by: "agent",
        created_at: NOW - 40 * HOUR,
        updated_at: NOW - 2 * HOUR,
        last_milestone_at: NOW - 2 * HOUR,
        closed_at: null,
        open_items: 3,
        needs_you: 2,
        conversations: 2,
        milestones: 4,
        last_milestone: { num: 11, title: "Approved the visual language", kind: "user_input", created_at: NOW - 2 * HOUR },
    },
    {
        id: "ms_6",
        num: 6,
        state: "open",
        title: "Backup rotation hardening",
        body: "",
        close_summary: null,
        closed_by: null,
        closed_over_open_items: 0,
        origin_convo_id: "c2",
        created_by: "agent",
        created_at: NOW - 90 * HOUR,
        updated_at: NOW - 26 * HOUR,
        last_milestone_at: NOW - 26 * HOUR,
        closed_at: null,
        open_items: 0,
        needs_you: 0,
        conversations: 1,
        milestones: 2,
        last_milestone: { num: 8, title: "Cron entry verified", kind: "progress", created_at: NOW - 26 * HOUR },
    },
    {
        id: "ms_4",
        num: 4,
        state: "closed",
        title: "Migrate to Postgres 17",
        body: "",
        close_summary: "pg_upgrade completed with zero errors; rollback point retained for a week.",
        closed_by: "user",
        closed_over_open_items: 1,
        origin_convo_id: "c3",
        created_by: "agent",
        created_at: NOW - 200 * HOUR,
        updated_at: NOW - 120 * HOUR,
        last_milestone_at: NOW - 130 * HOUR,
        closed_at: NOW - 120 * HOUR,
        open_items: 0,
        needs_you: 0,
        conversations: 1,
        milestones: 3,
        last_milestone: { num: 5, title: "Dry-run clean", kind: "progress", created_at: NOW - 130 * HOUR },
    },
];

function item(over: Partial<TrackerItem> & Pick<TrackerItem, "id" | "num" | "kind" | "title">): TrackerItem {
    return {
        state: "open",
        resolution: null,
        awaiting: "user",
        rank: 0,
        body: "",
        labels: [],
        links: [],
        supersedes: null,
        origin_convo_id: "c1",
        origin_convo_title: "matron-web · deploy",
        created_by: "agent",
        created_at: NOW - 5 * HOUR,
        updated_at: NOW - HOUR,
        closed_at: null,
        mission_id: null,
        mission_num: null,
        comment_count: 0,
        last_comment_at: null,
        attachments: [],
        has_image: false,
        ...over,
    };
}

export const fixtureItems: TrackerItem[] = [
    item({
        id: "it_12",
        num: 12,
        kind: "question",
        title: "Which brand colour for the tracker accent?",
        body: "Orange already reads as the needs-you signal. Do we reuse it or introduce a second accent?",
        labels: ["design"],
        mission_id: "ms_5",
        mission_num: 5,
        comment_count: 2,
        last_comment_at: NOW - HOUR,
    }),
    item({
        id: "it_13",
        num: 13,
        kind: "decision",
        title: "Fold plug revenue into the dashboard balance?",
        origin_convo_id: "c2",
        origin_convo_title: "infra: backup rotation",
        created_at: NOW - 8 * HOUR,
        updated_at: NOW - 3 * HOUR,
        has_image: true,
    }),
    item({
        id: "it_14",
        num: 14,
        kind: "task",
        title: "Wire the WS invalidation for tracker markers",
        body: "Refetch only the loaded surface on item/mission/milestone frames.",
        awaiting: "agent",
        mission_id: "ms_5",
        mission_num: 5,
        comment_count: 1,
        created_at: NOW - 10 * HOUR,
        updated_at: NOW - 6 * HOUR,
        last_comment_at: NOW - 6 * HOUR,
    }),
    item({
        id: "it_9",
        num: 9,
        kind: "decision",
        title: "Keep releases for seven days before pruning",
        state: "closed",
        resolution: "decided",
        awaiting: null,
        closed_at: NOW - 30 * HOUR,
        updated_at: NOW - 30 * HOUR,
    }),
];

export const fixtureItemDetail: { item: TrackerItem; comments: TrackerComment[] } = {
    item: fixtureItems[0],
    comments: [
        {
            id: "cm_1",
            item_id: "it_12",
            author: "agent",
            device_id: 1,
            kind: "comment",
            body: "The needs-you orange is `#FFB020`. Reusing it for the accent risks diluting the urgency signal.",
            attachments: [],
            meta: null,
            created_at: NOW - 4 * HOUR,
        },
        {
            id: "cm_2",
            item_id: "it_12",
            author: "user",
            device_id: 2,
            kind: "comment",
            body: "Agreed. Keep orange for needs-you only and use the teal accent for the tracker chrome.",
            attachments: [],
            meta: null,
            created_at: NOW - HOUR,
        },
        {
            id: "cm_3",
            item_id: "it_12",
            author: "user",
            device_id: 2,
            kind: "status",
            body: "",
            attachments: [],
            meta: {
                from: { state: "open", resolution: null, awaiting: "user" },
                to: { state: "open", resolution: null, awaiting: "agent" },
            },
            created_at: NOW - HOUR,
        },
    ],
};

export const fixtureMissionDetail: MissionDetail = {
    mission: fixtureMissions[0],
    milestones: [
        {
            id: "ml_11",
            mission_id: "ms_5",
            num: 11,
            kind: "user_input",
            title: "Approved the visual language",
            body: "Orange = needs-you only; teal for chrome; purple for decisions.",
            convo_id: "c1",
            seq: 42,
            device_id: 2,
            created_by: "user",
            created_at: NOW - 2 * HOUR,
        },
        {
            id: "ml_10",
            mission_id: "ms_5",
            num: 10,
            kind: "progress",
            title: "Landed the tracker spine (types + api + client)",
            body: "",
            convo_id: "c1",
            seq: 30,
            device_id: 1,
            created_by: "agent",
            created_at: NOW - 20 * HOUR,
        },
    ],
    items: [
        {
            id: "it_12",
            num: 12,
            kind: "question",
            state: "open",
            awaiting: "user",
            title: "Which brand colour for the tracker accent?",
            origin_convo_id: "c1",
            updated_at: NOW - HOUR,
        },
        {
            id: "it_14",
            num: 14,
            kind: "task",
            state: "open",
            awaiting: "agent",
            title: "Wire the WS invalidation for tracker markers",
            origin_convo_id: "c1",
            updated_at: NOW - 6 * HOUR,
        },
    ],
    conversations: [
        { id: "c1", title: "matron-web · deploy", state: "running", box: "vps" },
        { id: "s1", title: "test triage", state: "running", box: "vps" },
    ],
};

/** A Work-view loader answering with the repo's recorded producer output (work-view-ok.json). */
export const fixtureWorkViewLoader: WorkViewLoader = {
    work: async () => workViewOk as unknown as WorkViewEnvelope,
};

// ---- Files --------------------------------------------------------------------------------------

export const FIXTURE_FILES_ROOT = "/srv/workspace";
const PNG_8X8 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVR42mNkYPhfz0AEYBxVSF+Fo25EGwUAaOQF/S2Q6iEAAAAASUVORK5CYII=";
/** A 640x360 chart-like SVG used wherever a fixture needs a real, decodable image. */
export const FIXTURE_IMAGE_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">' +
        '<rect width="640" height="360" fill="#faf8f4"/>' +
        '<g stroke="#e7e2d9">' +
        [60, 120, 180, 240, 300].map((y) => `<line x1="40" x2="620" y1="${y}" y2="${y}"/>`).join("") +
        "</g>" +
        '<polyline fill="none" stroke="#0d9488" stroke-width="3" points="40,250 100,240 160,262 220,200 280,210 340,150 400,170 460,120 520,132 580,96 620,104"/>' +
        '<text x="40" y="36" font-family="Inter, sans-serif" font-size="16" fill="#1b1815">5xx rate · last 30 min</text>' +
        "</svg>",
)}`;
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

export const fixtureFileEntries: FileEntry[] = [
    { name: "src", kind: "dir", size: 0, mtime: NOW - HOUR, mime: "" },
    { name: "docs", kind: "dir", size: 0, mtime: NOW - 3 * HOUR, mime: "" },
    { name: "empty-dir", kind: "dir", size: 0, mtime: NOW - DAY, mime: "" },
    { name: "denied-dir", kind: "dir", size: 0, mtime: NOW - DAY, mime: "" },
    { name: ".gitignore", kind: "file", size: 84, mtime: NOW - 9 * DAY, mime: "text/plain" },
    { name: "README.md", kind: "file", size: 4310, mtime: NOW - HOUR, mime: "text/markdown" },
    { name: "client.ts", kind: "file", size: 10_240, mtime: NOW - DAY, mime: "text/plain" },
    { name: "theme.css", kind: "file", size: 2048, mtime: NOW - 2 * DAY, mime: "text/css" },
    { name: "diagram.png", kind: "file", size: 18_224, mtime: NOW - 5 * HOUR, mime: "image/png" },
    { name: "report.pdf", kind: "file", size: 240_512, mtime: NOW - 9 * HOUR, mime: "application/pdf" },
    { name: "notes.txt", kind: "file", size: 512, mtime: NOW - 10 * MIN, mime: "text/plain" },
    { name: "standup.mp3", kind: "file", size: 1_842_112, mtime: NOW - 2 * DAY, mime: "audio/mpeg" },
    { name: "archive.zip", kind: "file", size: 5_242_880, mtime: NOW - 4 * DAY, mime: "application/zip" },
];

export const FIXTURE_CODE_SAMPLE = [
    "export function greet(name: string): string {",
    "    // A short sample so CodePreview shows real highlighting.",
    "    const parts = [`Hello, ${name}!`, 'Welcome to Matron.'];",
    "    return parts.join(' ');",
    "}",
    "",
    "const answer = 42;",
].join("\n");

export const FIXTURE_README_SAMPLE = [
    "# Matron File Explorer",
    "",
    "Browse the working tree from **desktop or phone**, with inline preview.",
    "",
    "- Markdown, code, images, PDF, media",
    "- Path-jailed server-side; secrets never served",
    "",
    "```bash",
    "curl -s /journal/files/list?path=/srv/workspace",
    "```",
].join("\n");

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

/**
 * A canned FilesApiLike: every read resolves immediately with fixture data and every write
 * resolves with the success shape the server contract promises. `writable: false` stands in for
 * a read-only root (no write affordances render).
 */
export function createFixtureFilesApi(options: { writable?: boolean } = {}): FilesApiLike {
    const writable = options.writable ?? true;
    const api: FilesApiLike = {
        listDir: async (path: string, all?: boolean): Promise<FileListing> => {
            if (path.endsWith("denied-dir")) throw new JournalApiError("denied", 403, "forbidden");
            const base = {
                path,
                root: FIXTURE_FILES_ROOT,
                parent: path === FIXTURE_FILES_ROOT ? null : FIXTURE_FILES_ROOT,
                writable,
            };
            if (path.endsWith("empty-dir")) return { ...base, entries: [], truncated: false };
            const entries = all ? fixtureFileEntries : fixtureFileEntries.filter((entry) => !entry.name.startsWith("."));
            return { ...base, entries, truncated: false };
        },
        fileMeta: async (path: string): Promise<FileMeta> => {
            const name = path.slice(path.lastIndexOf("/") + 1);
            const ext = extOf(name);
            const match = fixtureFileEntries.find((entry) => entry.name === name);
            return {
                kind: "file",
                size: match?.size ?? 1024,
                mtime: match?.mtime ?? NOW,
                mime: MIME[ext] ?? "application/octet-stream",
                isText: TEXT_EXT.has(ext),
            };
        },
        textContent: async (path: string): Promise<string> => {
            if (path.endsWith(".md")) return FIXTURE_README_SAMPLE;
            if (path.endsWith(".ts")) return FIXTURE_CODE_SAMPLE;
            if (path.endsWith(".css")) return ":root {\n    --brand: #0d9488;\n}\n";
            return "Standup notes\n- deploy went out at 10:06\n- follow up on the flaky upload test\n";
        },
        fileBytes: async (path: string): Promise<ArrayBuffer> => {
            if (TEXT_EXT.has(extOf(path))) {
                return new TextEncoder().encode(await api.textContent(path)).buffer as ArrayBuffer;
            }
            return PDF_BYTES.slice().buffer as ArrayBuffer;
        },
        contentUrl: async (path: string): Promise<string> => {
            if (path.endsWith(".png")) return FIXTURE_IMAGE_URL;
            if (path.endsWith(".mp3")) return "data:audio/mpeg;base64,";
            if (path.endsWith(".mp4")) return "data:video/mp4;base64,";
            return "data:application/octet-stream;base64,";
        },
        download: async (): Promise<void> => {},
        upload: async (file: File, opts: { targetDir: string; name?: string }) => ({
            path: `${opts.targetDir}/${opts.name ?? file.name}`,
            bytes: file.size,
            dryRun: false,
        }),
        mkdir: async (path: string) => ({ path, dryRun: false }),
        move: async (from: string, to: string) => ({ from, to, dryRun: false }),
        writeFile: async (path: string, content: string) => ({ path, bytes: content.length, dryRun: false }),
        deleteEntry: async (path: string) => ({
            path,
            trashed: `${FIXTURE_FILES_ROOT}/.matron-trash/20260821T101500Z-7f3a-${path.slice(path.lastIndexOf("/") + 1)}`,
            alreadyMissing: false,
            dryRun: false,
        }),
        dispose: (): void => {},
    };
    return api;
}

// ---- The fake client ----------------------------------------------------------------------------

/** Which surface a fixture client's store is pre-patched to. */
export type FixtureScreen =
    | "chat"
    | "subagent"
    | "list"
    | "files"
    | "files-preview"
    | "tracker-missions"
    | "tracker-mission"
    | "tracker-inbox"
    | "tracker-item"
    | "tracker-work"
    | "search"
    | "upload"
    | "offline"
    | "signed-out";

export interface FixtureClientOptions {
    /** The surface to open. Default "chat" (conversation c1 selected). */
    screen?: FixtureScreen;
    /** Shallow overrides applied last, for any state the named screens don't cover. */
    state?: Partial<ClientState>;
    /** Files API variant: false = read-only root (no write affordances). Default true. */
    filesWritable?: boolean;
}

function screenPatch(screen: FixtureScreen): Partial<ClientState> {
    switch (screen) {
        case "chat":
            return {};
        case "subagent":
            return { selectedConversationId: "s1", events: [] };
        case "list":
            return { selectedConversationId: undefined, events: [] };
        case "files":
            return { filesView: { open: true, path: FIXTURE_FILES_ROOT } };
        case "files-preview":
            return {
                filesView: { open: true, path: FIXTURE_FILES_ROOT, targetFile: `${FIXTURE_FILES_ROOT}/README.md`, targetToken: 1 },
            };
        case "tracker-missions":
            return { trackerView: { open: true, view: "missions" } };
        case "tracker-mission":
            return {
                trackerView: { open: true, view: "missions", selectedMissionId: 5 },
                trackerMission: fixtureMissionDetail,
            };
        case "tracker-inbox":
            return { trackerView: { open: true, view: "inbox" } };
        case "tracker-item":
            return {
                trackerView: { open: true, view: "inbox", selectedItemId: 12 },
                trackerItem: fixtureItemDetail,
            };
        case "tracker-work":
            return { trackerView: { open: true, view: "work" } };
        case "search":
            return {
                selectedConversationId: undefined,
                events: [],
                messageSearch: {
                    query: "nginx",
                    loading: false,
                    failed: false,
                    hits: [
                        {
                            convo_id: "c1",
                            title: "matron-web · deploy",
                            live: true,
                            seq: 2,
                            ts: T + MIN,
                            sender: "agent:claude",
                            snippet: "To swap prod I need to restart **nginx**.",
                        },
                        {
                            convo_id: "c1",
                            title: "matron-web · deploy",
                            live: true,
                            seq: 6,
                            ts: T + 5 * MIN,
                            sender: "agent:claude",
                            snippet: "systemctl restart **nginx** && systemctl status **nginx**",
                        },
                        {
                            convo_id: "c3",
                            title: "postgres upgrade dry-run",
                            live: true,
                            seq: 1,
                            ts: NOW - 26 * HOUR,
                            sender: "user:operator",
                            snippet: "after the upgrade, reload **nginx** so the new socket path is picked up",
                        },
                    ],
                },
            };
        case "upload":
            return {};
        case "offline":
            return { connection: "offline", selectedConversationId: undefined, events: [] };
        case "signed-out":
            return { phase: "signed-out", session: undefined };
    }
}

type Patchable = { state: ClientState; patch(update: Partial<ClientState>): void };

/**
 * A real MatronJournalClient whose store is pre-patched to a signed-in fixture account on the
 * requested screen. Never initialised: it holds no session transport, so actions that would hit
 * the server are no-ops (or surface their normal error UI). Pass it anywhere a component takes
 * `client` (and `client.getSnapshot()` wherever one takes `state`).
 */
export function createFixtureClient(options: FixtureClientOptions = {}): MatronJournalClient {
    const client = new MatronJournalClient();
    const screen = options.screen ?? "chat";
    const filesApi = createFixtureFilesApi({ writable: options.filesWritable });
    const base: ClientState = {
        ...client.getSnapshot(),
        phase: "signed-in",
        session: fixtureSession,
        conversations: fixtureConversations,
        selectedConversationId: "c1",
        events: fixtureEvents,
        pendingMessages: [],
        connection: "online",
        sessionStatus: fixtureSessionStatus,
        trackerNeedsYou: 2,
        missions: fixtureMissions,
        inboxItems: fixtureItems,
    };
    (client as unknown as Patchable).state = { ...base, ...screenPatch(screen), ...(options.state ?? {}) };

    const stub = client as unknown as Record<string, unknown>;
    stub.listAgents = async () => [
        { device_id: "dev-vps", connected: true, label: "vps", hostname: "build-host", name: "vps" },
        { device_id: "dev-mac", connected: false, label: "macbook", hostname: "laptop", name: "macbook" },
    ];
    stub.recentFolders = async () => [
        { path: "/opt/matron/web-journal" },
        { path: "/opt/matron/journal" },
        { path: "/srv/workspace" },
    ];
    stub.mediaUrl = async (id: string) =>
        id.startsWith("img") ? FIXTURE_IMAGE_URL : "data:application/octet-stream;base64,";
    stub.filesApi = () => filesApi;
    stub.work = fixtureWorkViewLoader.work;

    if (screen === "upload") {
        const png = Uint8Array.from(atob(PNG_8X8), (c) => c.charCodeAt(0));
        client.stageFiles([
            new File([png], "Screenshot 2026-09-25 at 10.12.05.png", { type: "image/png" }),
            new File([new Uint8Array(512)], "error-log.txt", { type: "text/plain" }),
        ]);
    }
    return client;
}
