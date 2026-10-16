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
 * attachment tray, etc.). Theme comes from ?theme=dark on <html data-theme>.
 */

import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/fira-code/latin-400.css";
import "@fontsource/inter/latin-400.css";
// Inter 500 (labels, menu rows, card titles): without it the browser matches 500 to 400.
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";

import { JournalApi, JournalApiError } from "../src/journal/api";
import { archiveStore, favoriteStore, MatronJournalClient, pinnedStore, unreadStore } from "../src/journal/client";
import { MatronApp } from "../src/journal/components";
import type { FileEntry, FileListing, FileMeta, FilesApiLike } from "../src/journal/files/filesApi";
import type { Routine } from "../src/journal/routines";
import type {
    ClientState,
    Conversation,
    JournalEvent,
    Mission,
    MissionDetail,
    Session,
    SessionStatus,
    TrackerComment,
    TrackerItem,
} from "../src/journal/types";
import { SHOW_THE_WORK_KEY } from "../src/journal/show-the-work";
import { v6Fixture, type V6Scenario } from "./v6-thread";
import { workFixture, type WorkFixtureMode } from "./work";
import { opsDevices, opsMetrics, opsReply, type OpsFixtureMode } from "./ops";
import { parseBoxStatus, parseMetrics, sectionStateFromReply, type OpsSection } from "../src/journal/ops/model";
import { REAL_STATUS, subagentFixture, type SubagentScenario } from "./subagents";
import "../src/journal/shell.pcss";
import "../src/journal/controls.pcss";
import "../src/journal/journal.pcss";
import "../src/journal/tracker.pcss";
import "../src/journal/work.pcss";
import "../src/journal/ops.pcss";
import "../src/journal/subagents.pcss";
import "../src/journal/mobile.pcss";
import "../src/journal/coordinator.pcss";

const SESSION: Session = {
    serverUrl: "https://journal.example",
    token: "fixture",
    deviceId: 1,
    userId: 2,
    username: "operator@example.com",
};

// The pinned digest arrives as the bridge's raw wire text: one "\u2022 "-prefixed
// line per pass. The last bullet is deliberately >160 chars so the fixture shows the clamp +
// Expand affordance alongside short ones. c2/c3 carry none, which is the "renders nothing" case.
const PINNED_SUMMARY_TEXT = [
    "\u2022 Reskinned the journal client end to end; bubbles, sidebar and header now share one scale.",
    "\u2022 Cut the deploy to a versioned release dir with a current-release pointer, so rollback is a repoint.",
    "\u2022 Restarted nginx after the cert rotation and watched the error rate for ten minutes: it held at 0.02% with no 5xx spike, no upstream resets, and no change to p99 latency, so the rotation is considered clean.",
].join("\n");

const conversations: Conversation[] = [
    {
        id: "c1",
        title: "🐣 [dc] matron-web · deploy",
        agent_device_id: 1,
        session_state: "running",
        last_seq: 6,
        unread_count: 0,
        snippet: "Restarted nginx; error rate steady at 0.02%",
        created_at: 1,
        read_up_to_seq: 6,
        summary: PINNED_SUMMARY_TEXT,
        summary_updated_at: Date.now() - 7 * 60_000,
    },
    {
        id: "c2",
        title: "🐣 [b2] infra: backup rotation",
        agent_device_id: 2,
        session_state: "idle",
        last_seq: 3,
        unread_count: 3,
        snippet: "Cron entry added for 03:15 UTC daily",
        created_at: 1,
        read_up_to_seq: 0,
    },
    {
        id: "c3",
        title: "🐣 [e9] postgres upgrade dry-run",
        agent_device_id: 2,
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
        title: "🐣 [7a] test triage",
        agent_device_id: 1,
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
            target_name: "elm",
            workdir: "/srv/app/web",
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
    // Coordinator notices: one quiet line each, never the raw-JSON fallback. The rolling
    // `summary` event is bookkeeping and never occupies a row.
    {
        seq: 16,
        convo_id: "c1",
        ts: T + 800,
        sender: "journal",
        type: "coordinator",
        payload: { role: "assigned" },
    },
    {
        seq: 17,
        convo_id: "c1",
        ts: T + 810,
        sender: "journal",
        type: "consent_decision",
        payload: {
            kind: "spawn",
            decision: "approve",
            request_id: "spawn-fixture-1",
            reason: "Test triage on box-a follows the box rules",
        },
    },
    {
        seq: 18,
        convo_id: "c1",
        ts: T + 820,
        sender: "journal",
        type: "routine",
        payload: { routine_id: "r-1", name: "morning-sweep", action: "fired", outcome: "applied now" },
    },
    {
        seq: 19,
        convo_id: "c1",
        ts: T + 830,
        sender: "journal",
        type: "routine",
        payload: { routine_id: "r-2", name: "evening-sweep", action: "fired", outcome: "failed agent_unreachable" },
    },
    {
        seq: 20,
        convo_id: "c1",
        ts: T + 835,
        sender: "journal",
        type: "summary",
        payload: { text: "Rolling summary of this conversation" },
    },
    {
        // File events as the bridge and the native apps send them: the name rides in `name`
        // (the media-send key), not the older `filename`.
        seq: 21,
        convo_id: "c1",
        ts: T + 840,
        sender: "agent:claude",
        type: "file",
        payload: { blob_ref: "fixture-log", name: "deploy-2026-07-25.log", content_type: "text/plain", size: 18_432 },
    },
    {
        seq: 22,
        convo_id: "c1",
        ts: T + 860,
        sender: "agent:claude",
        type: "file",
        payload: { blob_ref: "fixture-pdf", name: "rollback-runbook.pdf", size: 96_256 },
    },
    // Tracker item markers. Each item shows ONE card, at its latest created/closed marker, in its
    // latest state: #41 was asked, answered and closed, so only the closing "Closed · Answered"
    // card shows (no stale "Needs you" card above it); #42 was filed for the agent and then handed
    // to the user in a reply, so its one card now reads "Needs you".
    {
        seq: 23,
        convo_id: "c1",
        ts: T + 870,
        sender: "journal",
        type: "item",
        payload: {
            item_id: "it_41",
            num: 41,
            kind: "question",
            title: "Which region should the staging bucket use?",
            action: "created",
            by: "agent",
            awaiting: "user",
        },
    },
    {
        seq: 24,
        convo_id: "c1",
        ts: T + 875,
        sender: "journal",
        type: "item",
        payload: {
            item_id: "it_42",
            num: 42,
            kind: "task",
            title: "Rotate the staging deploy key",
            action: "created",
            by: "agent",
            awaiting: "agent",
        },
    },
    {
        seq: 25,
        convo_id: "c1",
        ts: T + 880,
        sender: "journal",
        type: "item",
        payload: {
            item_id: "it_41",
            num: 41,
            kind: "question",
            title: "Which region should the staging bucket use?",
            action: "commented",
            by: "user",
            awaiting: "agent",
            comment: { id: "cm_1", body: "Same region as production." },
        },
    },
    {
        seq: 26,
        convo_id: "c1",
        ts: T + 890,
        sender: "journal",
        type: "item",
        payload: {
            item_id: "it_41",
            num: 41,
            kind: "question",
            title: "Which region should the staging bucket use?",
            action: "closed",
            by: "agent",
            resolution: "answered",
            comment: { id: "cm_2", body: "Created the bucket in the production region." },
        },
    },
    {
        seq: 27,
        convo_id: "c1",
        ts: T + 900,
        sender: "journal",
        type: "item",
        payload: {
            item_id: "it_42",
            num: 42,
            kind: "task",
            title: "Rotate the staging deploy key",
            action: "commented",
            by: "agent",
            awaiting: "user",
            comment: { id: "cm_3", body: "Needs an admin to approve the new key." },
        },
    },
    // Agent-chat consent card, waiting on the user: who asks whom, about what and why, with
    // Decline / Approve answered over the journal's answer route.
    {
        seq: 28,
        convo_id: "c1",
        ts: T + 910,
        sender: "agent:claude",
        type: "permission_request",
        payload: {
            kind: "agent_chat",
            request: "invite",
            room_id: "room-fixture-1",
            from_device_id: 1,
            from_name: "box-a",
            from_convo_id: "c1",
            from_convo_title: "matron-web · deploy",
            target_device_id: 2,
            to_name: "box-b",
            to_convo_id: "c2",
            to_convo_title: "infra: backup rotation",
            topic: "Rotate the backup credentials",
            justification: "box-b owns the backup job and needs the new nginx config path.",
        },
    },
    // A chat card already decided — settled by its consent item's closing marker (seq 30).
    {
        seq: 29,
        convo_id: "c1",
        ts: T + 960,
        sender: "agent:claude",
        type: "permission_request",
        payload: {
            kind: "agent_chat",
            request: "invite",
            room_id: "room-fixture-2",
            from_device_id: 1,
            from_name: "box-a",
            from_convo_id: "c1",
            from_convo_title: "matron-web · deploy",
            target_device_id: 2,
            to_name: "box-b",
            to_convo_id: "c2",
            to_convo_title: "infra: backup rotation",
            topic: "Share the deploy checklist",
            justification: "",
        },
    },
    {
        seq: 30,
        convo_id: "c1",
        ts: T + 990,
        sender: "agent:claude",
        type: "item",
        payload: {
            item_id: "it_fixture_chat",
            num: 12,
            kind: "question",
            title: "box-a wants to start a chat with box-b",
            action: "closed",
            by: "user",
            resolution: "decided",
            consent: "chat",
            consent_ask: "room-fixture-2/2",
            consent_outcome: "denied",
            comment: { id: "cm_fixture_chat", body: "Declined." },
        },
    },
    {
        // A malformed agent-chat payload (no room_id) → an inert notice, never dead buttons.
        seq: 31,
        convo_id: "c1",
        ts: T + 1020,
        sender: "agent:claude",
        type: "permission_request",
        payload: { kind: "agent_chat", request: "invite", topic: "Compare the test logs" },
    },
    {
        // A voice note: plays in the inline audio player (blob stubbed below).
        seq: 32,
        convo_id: "c1",
        ts: T + 1040,
        sender: "user:operator",
        type: "file",
        payload: { blob_ref: "fixture-voice", filename: "voice-note.m4a", content_type: "audio/mp4", size: 48_128 },
    },
    {
        // Reaped by the server's media reaper: payload tombstone.
        seq: 33,
        convo_id: "c1",
        ts: T + 1060,
        sender: "agent:claude",
        type: "image",
        payload: { blob_ref: "fixture-reaped-image", content_type: "image/png", expired: true },
    },
    {
        seq: 34,
        convo_id: "c1",
        ts: T + 1080,
        sender: "agent:claude",
        type: "file",
        payload: { blob_ref: null, filename: "deploy-2026-07-01.log", size: 18_432, expired: true },
    },
    {
        // Synced before the reap (no tombstone): the 404 on fetch flips it to expired.
        seq: 35,
        convo_id: "c1",
        ts: T + 1100,
        sender: "agent:claude",
        type: "image",
        payload: { blob_ref: "fixture-gone", content_type: "image/png" },
    },
    {
        // Multi-select question (mode: pick_many): options toggle, one Send answers with them all.
        seq: 36,
        convo_id: "c1",
        ts: T + 1120,
        sender: "agent:claude",
        type: "prompt",
        payload: {
            question: "Which checks should I run before the deploy?",
            mode: "pick_many",
            options: [
                { id: "opt_a", label: "Lint", value: "Lint" },
                { id: "opt_b", label: "Unit tests", value: "Unit tests" },
                { id: "opt_c", label: "Visual screenshots", value: "Visual screenshots" },
                { id: "opt_d", label: "Smoke test on staging", value: "Smoke test on staging" },
            ],
        },
    },
    // A chat card the Coordinator answered: the consent_decision (seq 38) settles it, and the
    // card's outcome line carries the Coordinator's reason. (The spawn card at seq 14 is answered
    // the same way by seq 17, and offers Stop session for the session it started.)
    {
        seq: 37,
        convo_id: "c1",
        ts: T + 1140,
        sender: "agent:claude",
        type: "permission_request",
        payload: {
            kind: "agent_chat",
            request: "invite",
            room_id: "room-fixture-3",
            from_device_id: 1,
            from_name: "box-a",
            from_convo_id: "c1",
            from_convo_title: "matron-web · deploy",
            target_device_id: 2,
            to_name: "box-b",
            to_convo_id: "c2",
            to_convo_title: "infra: backup rotation",
            topic: "Compare the nginx configs",
            justification: "box-b runs the same proxy and changed its timeouts last week.",
        },
    },
    {
        seq: 38,
        convo_id: "c1",
        ts: T + 1160,
        sender: "journal",
        type: "consent_decision",
        payload: {
            kind: "chat",
            room_id: "room-fixture-3",
            target_device_id: 2,
            decision: "approve",
            by: "coordinator",
            convo_id: "c1",
            reason: "Both boxes work on the same deploy",
        },
    },
    {
        // Surface B — an inline message from another AI session (durable .mj_PeerMessage block).
        seq: 39,
        convo_id: "c1",
        ts: T + 1180,
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
        seq: 40,
        convo_id: "c1",
        ts: T + 1200,
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
        // Surface B priority variant — louder marker, never a focus steal.
        seq: 41,
        convo_id: "c1",
        ts: T + 1220,
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

// ?notices swaps c1's thread for a Coordinator-style one: the bridge's tagged notices about the
// turns it injected (payload.notice) between the agent's own replies.
if (new URLSearchParams(window.location.search).has("notices")) {
    const at = (
        seq: number,
        minutes: number,
        payload: Record<string, unknown>,
        sender = "agent:ash",
    ): JournalEvent => ({
        seq,
        convo_id: "c1",
        ts: T + minutes * 60_000,
        sender,
        type: "text",
        payload: { from: "assistant", ...payload },
    });
    events.splice(
        0,
        events.length,
        at(1, 0, { body: "Run the morning sweep when it fires.", from: "user" }, "user:operator"),
        at(2, 1, {
            body: "🔔 Routine morning-sweep: Morning status sweep",
            notice: { kind: "routine", icon: "🔔", summary: "Routine morning-sweep: Morning status sweep" },
        }),
        at(3, 2, { body: "Sweep done: two missions moved, nothing waiting on you." }),
        at(4, 5, {
            body:
                "🤝 A consent request is waiting for the user: \n" +
                'chat ch_8f2 (tracker #12) — just now: alice — session "Release prep" [c_9] asks to chat with birch about "artwork render" (box awake)\n' +
                "  why, in alice's words: needs the render settings before the export\n" +
                '  consent_decide(kind: "chat", id: "ch_8f2", decision: approve|decline, reason: …)\n' +
                "The user has the card too and may answer first. Decide with consent_decide if it follows your rules and give your reason; otherwise leave it, or decline with a reason. Say in one line what you did.",
            notice: { kind: "consent", icon: "🤝", summary: "alice → birch chat · artwork render · #12" },
        }),
        at(5, 6, { body: "Approved alice's chat with birch: both boxes are ours and the topic is the release." }),
        at(6, 9, {
            body: '💬 "birch" in "ash ↔️ birch — disk": Disk clean-up done: 41 GB free, nothing in use was touched.',
            notice: {
                kind: "room",
                icon: "💬",
                summary: "birch: Disk clean-up done: 41 GB free, nothing in use was touched.",
            },
        }),
        at(7, 10, {
            body: "🚀 Spawn approved — started a session on birch (detached).",
            notice: { kind: "spawn", icon: "🚀", summary: "Spawn approved — started a session on birch (detached)." },
        }),
        at(8, 11, { body: "Noted: the clean-up on birch finished and the new session is running." }),
    );
}

// ?toolstream adds a running tool_stream tile with more output than its collapsed pane shows.
const toolStreams: ClientState["toolStreams"] = {};
if (new URLSearchParams(window.location.search).has("toolstream")) {
    toolStreams["stream-1"] = {
        messageRef: "stream-1",
        command: "pnpm lint",
        content: Array.from({ length: 40 }, (_, i) => `\x1b[90m[${i + 1}/40]\x1b[0m checked src/file-${i + 1}.ts`).join(
            "\n",
        ),
        offset: 0,
        headTruncated: false,
    };
}

const client = new MatronJournalClient();
const state: ClientState = {
    ...client.getSnapshot(),
    phase: "signed-in",
    session: SESSION,
    conversations,
    // Two boxes so the Mac-style box letters render ahead of titles.
    agents: [
        { device_id: 1, name: "ash", tag_char: null },
        { device_id: 2, name: "birch", tag_char: "B" },
    ],
    selectedConversationId: "c1",
    events,
    toolStreams,
    pendingMessages: [],
    connection: "online",
    // Needs-you badge on the header tracker button (desktop) and the mobile nav Tracker tab.
    trackerNeedsYou: 2,
    sessionStatus: {
        model: "claude-sonnet",
        // A current bridge reporting no MCP extras: the browser-tools row shows "Enable".
        extras: [],
        effort: "high",
        // The composer's /model and /effort arguments, as the bridge offers them.
        model_options: [
            { value: "default", label: "Default" },
            { value: "opus", label: "Opus" },
            { value: "opus[1m]", label: "Opus 1M" },
            { value: "sonnet", label: "Sonnet" },
            { value: "haiku", label: "Haiku" },
        ],
        effort_levels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "X-High" },
            { value: "max", label: "Max" },
        ],
        workdir: "/srv/app/web",
        email: "alice@example.com",
        context: { tokens: 144_000, window: 200_000, pct: 72 },
        // id-driven limits (v5+ bridge): ctx is synthesized from context; the rest carry
        // stable ids → short tags 5h/fbl/wk/cpu/ram + column-first 3×2 grid order.
        limits: [
            {
                id: "week_all",
                label: "Week (all models)",
                percent: 63,
                resets: "4d",
                resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString(),
            },
            {
                id: "session",
                label: "Session",
                percent: 41,
                resets: "3h20",
                resets_at: new Date(Date.now() + 200 * 60_000 + 30_000).toISOString(),
            },
            // host_ram: FRESH sample (10s old) → renders normally. host_cpu: STALE (4m old,
            // past HOST_VITALS_STALE_MS=60s) → renders dimmed with "last sampled 4m ago" in the
            // accessible name. Contact sheet shows the fresh vs stale host-vital states together.
            { id: "host_ram", label: "Host RAM", percent: 55, unit: "%", sampled_at_ms: Date.now() - 10_000 },
            {
                id: "week_fable",
                label: "Week (Fable)",
                percent: 22,
                resets: "4d",
                resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString(),
            },
            { id: "host_cpu", label: "Host CPU", percent: 34, unit: "%", sampled_at_ms: Date.now() - 240_000 },
        ],
    },
    archivedIds: archiveStore.read(SESSION).ids,
    pinnedIds: pinnedStore.read(SESSION).ids,
    favoriteIds: favoriteStore.read(SESSION).ids,
    unreadOverrideIds: unreadStore.read(SESSION).ids,
};
// Redesign v6: `?v6=<scenario>` swaps in the design's six-turn thread built from real journal
// shapes; `?work=on` turns Show the work on (the pre-v6 rendering).
const v6Params = new URLSearchParams(window.location.search);
const v6Scenario = v6Params.get("v6") as V6Scenario | null;
if (v6Params.get("work") === "on") localStorage.setItem(SHOW_THE_WORK_KEY, "true");
else localStorage.removeItem(SHOW_THE_WORK_KEY);
if (v6Scenario) {
    const fixture = v6Fixture(v6Scenario);
    state.events = fixture.events;
    state.toolStreams = fixture.toolStreams;
    state.activity = fixture.activity;
    state.conversations = state.conversations.map((conversation) =>
        conversation.id === "c1" ? { ...conversation, session_state: fixture.sessionState, summary: "" } : conversation,
    );
    // `&browser=queued|restarting|on|codex` layers a browser-tools restart onto the scenario.
    const browser = v6Params.get("browser");
    if (browser) {
        const last = state.events.at(-1)!;
        const text = (offset: number, sender: string, body: string): JournalEvent => ({
            seq: last.seq + offset,
            convo_id: "c1",
            ts: last.ts + offset * 1000,
            sender,
            type: "text",
            payload: { body },
        });
        if (browser !== "codex") state.events = [...state.events, text(1, "user:operator", "/restart --browser")];
        if (browser === "restarting")
            state.events = [...state.events, text(2, "agent:claude", "🔄 Restarting Claude session...")];
        if (browser === "on")
            state.events = [
                ...state.events,
                text(2, "agent:claude", "🔄 Restarting Claude session..."),
                text(
                    3,
                    "agent:claude",
                    "Claude session restarted.\nSession: 1a2b3c4d...\nWorkdir: /repo\nExtras: browser",
                ),
            ];
        // On/off is read from the status frame's extras, not the restart notice above.
        if (browser === "on" && state.sessionStatus)
            state.sessionStatus = { ...state.sessionStatus, extras: ["browser"] };
        state.conversations = state.conversations.map((conversation) =>
            conversation.id === "c1"
                ? {
                      ...conversation,
                      session_state: browser === "queued" ? "running" : conversation.session_state,
                      agent_kind: browser === "codex" ? "codex" : conversation.agent_kind,
                  }
                : conversation,
        );
    }
}

// Subagent cards + sidebar child rows: `?sub=thread|child|codex` swaps in a parent session with
// Claude subagents and a Codex exec child (fixtures/subagents.ts).
const subScenario = v6Params.get("sub") as SubagentScenario | null;
if (subScenario) {
    const fixture = subagentFixture(subScenario);
    state.conversations = fixture.conversations;
    state.selectedConversationId = fixture.selected;
    state.events = fixture.events;
    state.activity = fixture.activity;
    state.toolStreams = {};
    (client as unknown as { conversationEvents: (id: string) => Promise<JournalEvent[]> }).conversationEvents = async (
        id: string,
    ) => fixture.childEvents[id] ?? [];
    (client as unknown as { refreshConversationTail: () => Promise<boolean> }).refreshConversationTail = async () =>
        false;
}

// ?screen=login mounts the signed-out sign-in screen instead (unify step 2); ?fixed adds a
// config.json-style fixed server so the hidden-server-field variant can be shot too.
const fixtureParams = new URLSearchParams(window.location.search);
const signedOutState: ClientState = {
    ...client.getSnapshot(),
    phase: "signed-out",
    config: fixtureParams.has("fixed") ? { journal_server_url: "/" } : {},
};
// The client keeps its state private; mirror the test harness's internal override.
(client as unknown as { state: ClientState }).state = fixtureParams.get("screen") === "login" ? signedOutState : state;

// ?missions=1 puts the selected conversation on missions, so the header shows its mission chip
// (current one, +2 for an also-on and an earlier one).
{
    const stub = client as unknown as Record<string, unknown>;
    stub.loadConversationMissions = async () => undefined;
    if (fixtureParams.get("missions") === "1") {
        const now = Date.now();
        const link = (
            num: number,
            title: string,
            over: { current?: boolean; active?: boolean; state?: string; joinedDaysAgo: number; endedDaysAgo?: number },
        ) => ({
            id: `ms_${num}`,
            num,
            state: over.state ?? "open",
            title,
            body: "",
            close_summary: null,
            closed_by: null,
            closed_over_open_items: 0,
            origin_convo_id: "c1",
            created_by: "agent",
            created_at: now - 30 * 86_400_000,
            updated_at: now,
            last_milestone_at: now,
            closed_at:
                over.endedDaysAgo != null && over.state === "closed" ? now - over.endedDaysAgo * 86_400_000 : null,
            open_items: 1,
            needs_you: 0,
            conversations: 1,
            milestones: 3,
            last_milestone: null,
            current: over.current ?? false,
            active: over.active ?? true,
            how: "joined",
            joined_at: now - over.joinedDaysAgo * 86_400_000,
            ended_at: over.active === false && over.endedDaysAgo != null ? now - over.endedDaysAgo * 86_400_000 : null,
        });
        (state as unknown as Record<string, unknown>).conversationMissions = {
            convoId: "c1",
            links: [
                link(1594, "Deploy matron-web to chat.example.com", { current: true, joinedDaysAgo: 2 }),
                link(1706, "Unify matron-web and the Mac app design", { joinedDaysAgo: 6 }),
                link(1311, "Log retention clean-up", { active: false, joinedDaysAgo: 20, endedDaysAgo: 12 }),
            ],
        };
    }
}

// ?tasks=1 opens the chat's Tasks & decisions pane beside the conversation on canned items
// (?tasks=all on the All scope, ?tasks=empty with nothing filed yet).
{
    const tasksMode = fixtureParams.get("tasks");
    if (tasksMode) {
        const hour = 3_600_000;
        const now = Date.now();
        const base = {
            state: "open",
            resolution: null,
            body: "",
            labels: [],
            links: [],
            supersedes: null,
            origin_convo_id: "c1",
            created_by: "agent",
            closed_at: null,
            mission_id: null,
            mission_num: null,
            comment_count: 0,
            last_comment_at: null,
            attachments: [],
            has_image: false,
            created_at: now - 5 * hour,
            updated_at: now - 2 * hour,
        } as const;
        const task = (num: number, rank: number, title: string, over: Record<string, unknown> = {}) => ({
            ...base,
            id: `it_${num}`,
            num,
            kind: "task",
            awaiting: "agent",
            rank,
            title,
            ...over,
        });
        const items =
            tasksMode === "empty"
                ? []
                : [
                      {
                          ...base,
                          id: "it_214",
                          num: 214,
                          kind: "question",
                          awaiting: "user",
                          rank: 0,
                          title: "Keep the old redirect for a week?",
                          body: "The new route is live; the old one can go now or after the weekly report.",
                          comment_count: 1,
                      },
                      task(210, 100, "Add a health check to the deploy script"),
                      task(211, 200, "Roll the staging certificate", { body: "Expires in nine days." }),
                      task(212, 300, "Write the rollback runbook", { awaiting: null }),
                      {
                          ...base,
                          id: "it_208",
                          num: 208,
                          kind: "decision",
                          awaiting: null,
                          rank: 0,
                          title: "Deploy from tags, not from main",
                          created_at: now - 26 * hour,
                      },
                      ...(tasksMode === "all"
                          ? [
                                task(305, 150, "Prune backups older than 30 days", { origin_convo_id: "c2" }),
                                {
                                    ...base,
                                    id: "it_306",
                                    num: 306,
                                    kind: "question",
                                    awaiting: "user",
                                    rank: 0,
                                    title: "Run the dry-run against a copy of last night's dump?",
                                    origin_convo_id: "c3",
                                    updated_at: now - hour,
                                },
                            ]
                          : []),
                      task(205, 50, "Tag the release", {
                          state: "closed",
                          resolution: "done",
                          awaiting: null,
                          closed_at: now - 30 * hour,
                      }),
                  ];
        const stub = client as unknown as Record<string, unknown>;
        stub.loadChatTasks = async () => undefined;
        stub.createChatItem = async () => ({ ok: true });
        (state as unknown as Record<string, unknown>).chatTasks = {
            open: true,
            scope: tasksMode === "all" ? "all" : "c1",
            ...(tasksMode === "all" ? { allFor: "c1" } : {}),
            items,
        };
        (state as unknown as Record<string, unknown>).inboxItems = items.filter(
            (item) => item.state === "open" && item.awaiting === "user",
        );
    }
}

// ?tracker=inbox | ?tracker=item opens the tracker pane on canned data (unify step 5); the
// network loads are stubbed so the fixture stays offline.
const trackerMode = fixtureParams.get("tracker");
if (trackerMode === "projects" || trackerMode === "project" || trackerMode === "mission") {
    const now = Date.now();
    const project = (
        num: number,
        title: string,
        status: string | null,
        needs: number,
        running: number,
        ago: number,
    ) => ({
        id: `pj_${num}`,
        num,
        state: "open",
        title,
        body: "",
        status,
        status_by: "agent",
        status_updated_at: now - ago,
        created_at: now - 30 * 86_400_000,
        updated_at: now - ago,
        missions: { running, waiting: needs > 0 ? 1 : 0, idle: 1, quiet: 0, closed: 2 },
        needs_you: needs,
        open_items: needs + 3,
        last_activity_at: now - ago,
    });
    const projects = [
        project(
            2645,
            "Web/Mac design unification",
            "Phase 2 running: tokens merged and deploying; sign-in waits on your merge; sidebar, chat, tracker and settings are up for review.",
            1,
            1,
            6 * 60_000,
        ),
        project(
            2512,
            "Docs site launch",
            "On track for Wednesday morning. The branch is green; your approvals of the landing page and the changelog gate Sunday's checkpoint.",
            3,
            2,
            20 * 60_000,
        ),
        project(2301, "Billing export", null, 0, 0, 2 * 86_400_000),
    ];
    const mission = (num: number, title: string, status: string | null, activity: string, needs: number) => ({
        id: `ms_${num}`,
        num,
        state: "open",
        title,
        body: "",
        close_summary: null,
        closed_by: null,
        closed_over_open_items: 0,
        origin_convo_id: "c1",
        created_by: "agent",
        created_at: now - 86_400_000,
        updated_at: now,
        last_milestone_at: now,
        closed_at: null,
        open_items: 3,
        needs_you: needs,
        conversations: 1,
        milestones: 4,
        last_milestone: null,
        status,
        activity,
    });
    const stub = client as unknown as Record<string, unknown>;
    for (const name of [
        "loadInbox",
        "loadMissions",
        "loadItem",
        "loadMemories",
        "loadMission",
        "loadProjects",
        "loadProject",
    ]) {
        stub[name] = async () => undefined;
    }
    const tracker = state as unknown as Record<string, unknown>;
    tracker.projects = projects;
    // Missions filed in no project, shown below the cards: one active, two quiet for over a week
    // (folded under "Quiet for over a week").
    tracker.missions = [
        { ...mission(1311, "Log retention clean-up", null, "idle", 0), project_id: null },
        { ...mission(1187, "Try a smaller base image", null, "quiet", 0), project_id: null },
        { ...mission(1102, "Archive the old status page", null, "quiet", 0), project_id: null },
    ];
    tracker.trackerView =
        trackerMode === "project"
            ? { open: true, view: "missions", selectedProjectId: 2645 }
            : { open: true, view: "missions" };
    // ?tracker=mission: a mission page with a status, both item groups and enough milestones to page.
    if (trackerMode === "mission") {
        tracker.trackerView = { open: true, view: "missions", selectedMissionId: 1706 };
        const steps = [
            "Projects dashboard and project page merged",
            "Settings sheet follows the Mac layout",
            "User: run phase 2 all the way through, missions included",
            "Tracker pane restyled with the new tokens",
            "Chat header and composer aligned",
            "Sidebar groups and session tags landed",
        ];
        const milestones = Array.from({ length: 24 }, (_, index) => ({
            id: `ml_${index}`,
            mission_id: "ms_1706",
            num: 3990 - index,
            kind: index % 6 === 2 ? "user_input" : "progress",
            title: index < steps.length ? steps[index] : `Review round ${24 - index} addressed`,
            body: index === 0 ? "Both pages read from the same project rollups." : "",
            convo_id: "c1",
            seq: 24 - index,
            device_id: 1,
            created_by: "agent",
            created_at: now - (index + 1) * 3 * 3_600_000,
        }));
        const ref = (num: number, kind: string, awaiting: string | null, title: string) => ({
            id: `it_${num}`,
            num,
            kind,
            state: "open",
            awaiting,
            title,
            origin_convo_id: "c1",
            updated_at: now - 3_600_000,
        });
        tracker.trackerMission = {
            mission: {
                ...mission(1706, "Unify matron-web and the Mac app design", null, "running", 1),
                body: "Bring the web client in line with the Mac app, one surface at a time.",
                status: "Step 7 (projects) in progress; steps 2 to 6 are open PRs waiting on **review**.",
                status_by: "agent",
                status_updated_at: now - 12 * 60_000,
                project_id: "pj_2645",
                project_num: 2645,
                open_items: 3,
                milestones: milestones.length,
            },
            milestones,
            items: [
                ref(3939, "question", "user", "Merge unify step 2: sign-in follows the Mac app?"),
                ref(3951, "task", "agent", "Screenshot every themed surface in dark mode"),
                ref(3944, "decision", null, "Tokens come from the Mac palette, not the old theme"),
            ],
            conversations: [
                { id: "c1", title: "Unify matron-web and the Mac app design", state: "running", box: "box-a" },
            ],
        };
        stub.fetchMissionClosedItems = async () => ({
            items: [
                { num: 3901, kind: "task", resolution: "done", title: "Audit every web surface against the Mac app" },
                { num: 3912, kind: "question", resolution: "answered", title: "Keep the old accent colour?" },
                { num: 3920, kind: "decision", resolution: "decided", title: "One design token file for both themes" },
            ].map((row) => ({
                id: `it_${row.num}`,
                state: "closed",
                awaiting: null,
                mission_id: "ms_1706",
                mission_num: 1706,
                origin_convo_id: "c1",
                updated_at: now - 86_400_000,
                ...row,
            })),
            cursor: null,
        });
    }
    if (trackerMode === "project") {
        tracker.trackerProject = {
            project: { ...projects[0], body: "Audit first, then the Mac app sets the direction and the web follows." },
            missions: [
                mission(
                    1706,
                    "Unify matron-web and the Mac app design",
                    "Step 7 (projects) in progress; steps 2 to 6 are open PRs.",
                    "running",
                    1,
                ),
                mission(1594, "Deploy matron-web to chat.example.com", null, "quiet", 0),
            ],
            needs_you: [
                {
                    id: "it_3939",
                    num: 3939,
                    kind: "question",
                    state: "open",
                    awaiting: "user",
                    title: "Merge unify step 2: sign-in follows the Mac app?",
                    origin_convo_id: "c1",
                    updated_at: now,
                    mission_id: "ms_1706",
                    mission_num: 1706,
                },
            ],
            recent_milestones: [
                {
                    id: "ml_1",
                    mission_id: "ms_1706",
                    num: 3946,
                    kind: "progress",
                    title: "Token PR merged and its deploy PR opened",
                    body: "",
                    convo_id: "c1",
                    seq: 1,
                    device_id: 1,
                    created_by: "agent",
                    created_at: now - 3_600_000,
                    mission_num: 1706,
                },
                {
                    id: "ml_2",
                    mission_id: "ms_1706",
                    num: 3668,
                    kind: "user_input",
                    title: "User: run phase 2 all the way through, missions included",
                    body: "",
                    convo_id: "c1",
                    seq: 2,
                    device_id: 1,
                    created_by: "agent",
                    created_at: now - 20 * 3_600_000,
                    mission_num: 1706,
                },
            ],
            sessions_by_box: { ash: 1, "build-box": 1 },
        };
    }
}

if (trackerMode === "memories" || trackerMode === "memory") {
    const now = Date.now();
    const memory = (name: string, type: string, description: string, body: string, ago: number) => ({
        id: `me_${name}`,
        name,
        type,
        description,
        body,
        origin_convo_id: "c1",
        origin_device_id: 1,
        created_by: "agent",
        updated_by: "agent",
        created_at: now - ago,
        updated_at: now - ago,
    });
    const memories = [
        memory(
            "full-pr-urls",
            "feedback",
            "In chat and in item bodies, give PRs as full URLs and items as links, never a bare number.",
            "**Why:** bare numbers are dead text in the apps.\n\n**How to apply:** every PR mention.",
            3_600_000,
        ),
        memory(
            "read-replica-only",
            "reference",
            "Answer production data questions from the read replica, never the primary database.",
            "",
            86_400_000,
        ),
        memory(
            "leave-local-snapshots",
            "feedback",
            "Never delete or thin local backup snapshots on the build machine.",
            "",
            2 * 86_400_000,
        ),
    ];
    const stub = client as unknown as Record<string, unknown>;
    for (const name of ["loadInbox", "loadMissions", "loadItem", "loadMemories", "loadMission"]) {
        stub[name] = async () => undefined;
    }
    const tracker = state as unknown as Record<string, unknown>;
    tracker.memories = memories;
    tracker.trackerView =
        trackerMode === "memory"
            ? { open: true, view: "memories", selectedMemoryName: "full-pr-urls" }
            : { open: true, view: "memories" };
}

if (trackerMode === "inbox" || trackerMode === "item") {
    const day = 86_400_000;
    const now = Date.now();
    const baseItem = {
        state: "open",
        resolution: null,
        rank: 0,
        body: "",
        labels: [],
        links: [],
        supersedes: null,
        origin_convo_id: "c1",
        created_by: "agent",
        closed_at: null,
        mission_id: null,
        mission_num: null,
        comment_count: 0,
        last_comment_at: null,
        attachments: [],
        has_image: false,
    } as const;
    const items = [
        {
            ...baseItem,
            id: "it_1755",
            num: 1755,
            kind: "question",
            awaiting: "user",
            title: "Design audit done: confirm the phase 2 order and the five open design calls",
            body: "The side-by-side audit of matron-web against the Mac app is on a draft PR.",
            // Filed from another conversation than the selected one, so the context block shows
            // both the mission and the owner conversation.
            origin_convo_id: "c2",
            origin_device_id: 2,
            mission_id: "ms_1706",
            mission_num: 1706,
            comment_count: 2,
            has_image: true,
            created_at: now - 2 * 3_600_000,
            updated_at: now - 3_600_000,
        },
        {
            ...baseItem,
            id: "it_1694",
            num: 1694,
            kind: "task",
            awaiting: "agent",
            title: "matron-web: sign-in inputs overflow the card",
            body: "The inputs are wider than their panel: missing border-box sizing.",
            mission_id: "ms_1706",
            mission_num: 1706,
            created_at: now - day,
            updated_at: now - day,
        },
        {
            ...baseItem,
            id: "it_3646",
            num: 3646,
            kind: "decision",
            awaiting: null,
            title: "Warm dark ladder; teal button fills stay #0B6E7D in dark",
            body: "Three calls made to start phase 2 step 1.",
            created_at: now - 3 * day,
            updated_at: now - 3 * day,
        },
    ];
    const stub = client as unknown as Record<string, unknown>;
    for (const name of ["loadInbox", "loadMissions", "loadItem", "loadMemories", "loadMission"]) {
        stub[name] = async () => undefined;
    }
    const tracker = state as unknown as Record<string, unknown>;
    tracker.inboxItems = items;
    tracker.missions = [
        {
            id: "ms_1706",
            num: 1706,
            state: "open",
            title: "Unify matron-web and the Mac app",
            name: "Web/Mac unify",
            body: "",
            close_summary: null,
            closed_by: null,
            closed_over_open_items: 0,
            origin_convo_id: "c1",
            created_by: "agent",
            created_at: now - 9 * day,
            updated_at: now - day,
            last_milestone_at: null,
            closed_at: null,
            open_items: 2,
            needs_you: 1,
            conversations: 6,
            milestones: 0,
            last_milestone: null,
        },
    ];
    tracker.trackerView =
        trackerMode === "item" ? { open: true, view: "inbox", selectedItemId: 1755 } : { open: true, view: "inbox" };
    if (trackerMode === "item") {
        // ?working=running|queued: the indicator at the foot of the thread while the owning
        // session is mid-turn, or between the user's tap and the turn starting.
        const workingParam = fixtureParams.get("working");
        const working =
            workingParam === "running"
                ? { state: "running", since: now - 20_000, until: null }
                : workingParam === "queued"
                  ? { state: "queued", since: now - 2_000, until: now + 10 * 60_000 }
                  : null;
        // ?actions=offered|chosen: the item's own one-tap answers under its body, untapped or with
        // the user's choice marked (the item then waits on the agent).
        const actionsParam = fixtureParams.get("actions");
        const itemActions =
            actionsParam === "offered" || actionsParam === "chosen"
                ? {
                      actions: ["Confirm the order", "Discuss first"],
                      chosen_action: actionsParam === "chosen" ? "Confirm the order" : null,
                      awaiting: actionsParam === "chosen" ? "agent" : "user",
                  }
                : {};
        tracker.trackerItem = {
            item: { ...items[0], working, ...itemActions },
            comments: [
                {
                    id: "cm_1",
                    item_id: "it_1755",
                    author: "user",
                    device_id: 1,
                    kind: "comment",
                    body: "looks good, but leave the missions view until the desktop card layout is settled",
                    attachments: [],
                    meta: null,
                    created_at: now - 90 * 60_000,
                },
                {
                    id: "cm_2",
                    item_id: "it_1755",
                    author: "agent",
                    device_id: 2,
                    kind: "comment",
                    body: "Recorded. Phase 2 order and the five recommendations stand as proposed, with **missions on hold** until the Mac card dashboard is settled.",
                    attachments: [],
                    meta: null,
                    created_at: now - 88 * 60_000,
                    device_name: "workstation",
                    convo_id: "c1",
                    convo_title: "Web and Mac unify plan",
                },
                // A second session on another box in the same thread: the header tells them apart.
                {
                    id: "cm_3",
                    item_id: "it_1755",
                    author: "agent",
                    device_id: 3,
                    kind: "comment",
                    body: "The Mac card layout is on a branch; I will post here when it is ready to compare.",
                    attachments: [],
                    meta: null,
                    created_at: now - 40 * 60_000,
                    device_name: "build-box",
                    convo_id: "c-mac-cards",
                    convo_title: "Mac card dashboard: settle the layout before the missions view",
                },
                {
                    id: "cm_4",
                    item_id: "it_1755",
                    author: "agent",
                    device_id: 3,
                    kind: "comment",
                    body: "A comment whose session is not named shows the box alone.",
                    attachments: [],
                    meta: null,
                    created_at: now - 20 * 60_000,
                    device_name: "build-box",
                },
            ],
        };
        // ?consent=waiting|missing|started|elsewhere: a spawn consent item with the ask's card
        // answerable inside it, its card not synced yet, started (closed, with the outcome), or
        // closed with no outcome here (answered on another device). Approve never settles, so a
        // click shows the sending state.
        const consentParam = fixtureParams.get("consent");
        if (consentParam) {
            const closed = consentParam === "started" || consentParam === "elsewhere";
            const consentItem = {
                ...baseItem,
                id: "it_42",
                num: 42,
                kind: "question",
                state: closed ? "closed" : "open",
                resolution: closed ? "decided" : null,
                awaiting: closed ? null : "user",
                title: "Start a session on box-a to run the test suite?",
                body: "box-b asks to start a session on **box-a** in `/srv/app`. Sessions in this folder follow the box rules.",
                labels: ["consent"],
                links: [{ url: "matron://consent/spawn/sp_42", title: "Spawn request" }],
                origin_convo_id: "c2",
                origin_device_id: 2,
                created_at: now - 6 * 60_000,
                updated_at: now - 5 * 60_000,
                closed_at: closed ? now - 60_000 : null,
            };
            const request = {
                seq: 900,
                convo_id: "c2",
                ts: now - 6 * 60_000,
                sender: "agent:box-b",
                type: "permission_request",
                payload: {
                    kind: "agent_spawn",
                    request_id: "sp_42",
                    from_name: "box-b",
                    from_convo_title: "Fix the flaky tests",
                    target_name: "box-a",
                    workdir: "/srv/app",
                    topic: "Run the suite and fix flakes",
                    task: "Run the full test suite on box-a, find the three flaky tests in the sync module and fix them.\nOpen a pull request with the fixes.",
                    agent: "claude",
                    model: "opus",
                    effort: "high",
                    effort_source: "box_default",
                },
            };
            const outcome =
                consentParam === "started" ? { request_id: "sp_42", outcome: "started", room_id: "c1" } : null;
            stub.spawnConsentRows = async () => ({ request: consentParam === "missing" ? null : request, outcome });
            stub.answerAgentSpawn = () => new Promise(() => undefined);
            tracker.inboxItems = [consentItem, ...items];
            tracker.trackerView = { open: true, view: "inbox", selectedItemId: 42 };
            tracker.trackerItem = { item: consentItem, comments: [] };
        }
    }
}

// A real helper thread (`?sub=real-*`): the header's context gauge goes through the client's own
// helper correction (statusFor), from the statuses a pre-#81 bridge publishes.
if (subScenario === "real-claude" || subScenario === "real-tests") {
    const internals = client as unknown as {
        statuses: Map<string, SessionStatus>;
        statusFor: (id: string) => SessionStatus | undefined;
    };
    internals.statuses.set("p1", REAL_STATUS.parent);
    internals.statuses.set(state.selectedConversationId!, REAL_STATUS.child);
    state.sessionStatus =
        typeof internals.statusFor !== "function" || new URLSearchParams(location.search).has("rawctx")
            ? REAL_STATUS.child
            : internals.statusFor.call(client, state.selectedConversationId!);
}

// ?rooms=1 puts the selected conversation in two agent-chat rooms (the header's "Rooms · 2") and
// answers the journal's notification settings: one room silenced, the selected chat muted for an
// hour, so the bell, the rooms list and Settings → Notifications show their states.
if (fixtureParams.get("rooms") === "1") {
    const now = Date.now();
    state.conversations = [
        ...state.conversations,
        {
            id: "r1",
            title: "↔️ [r1] Release checklist",
            agent_device_id: 1,
            session_state: "running",
            last_seq: 9,
            unread_count: 0,
            snippet: "box-b: migrations are green on staging",
            created_at: now - 3 * 3600_000,
            last_ts: now - 4 * 60_000,
            read_up_to_seq: 9,
            participants: [1, 2],
            participant_convos: ["c1", "c3"],
        },
        {
            id: "r2",
            title: "🔗 [r2] Schema review",
            agent_device_id: 2,
            session_state: "waiting",
            last_seq: 4,
            unread_count: 0,
            snippet: "Agreed: keep the old column for one release",
            created_at: now - 26 * 3600_000,
            last_ts: now - 5 * 3600_000,
            read_up_to_seq: 4,
            participants: [1, 2],
            participant_convos: ["c2", "c1"],
        },
    ];
    const notify = {
        mode: "coordinator",
        events: {
            prompts: true,
            questions: true,
            notices: true,
            coordinator_done: true,
            other_done: false,
            stopped: false,
            rooms: false,
            activity: false,
        },
        has_coordinator: true,
        device_level: "all",
        convos: [
            { convo_id: "c1", level: "needs_me", mute_until: now + 3600_000 },
            { convo_id: "r2", level: "none", mute_until: null },
        ],
    };
    const api = JournalApi.prototype as unknown as Record<string, unknown>;
    api.notifySettings = async () => notify;
    api.coordinator = async () => ({ convo_id: "c2", consent: true });
    // A save is accepted; the shots do not change anything.
    api.updateNotify = async () => notify;
}

// ?badges=1: the conversation list's needs-you counts and "New" marker, and the Projects badge in
// the rail. Two questions from c2 and one from c1 wait on the user (two of them on a mission), and
// c3 arrived without the user starting it and has not been opened.
if (fixtureParams.get("badges") === "1") {
    const now = Date.now();
    const question = (id: string, origin: string, missionId: string | null): Record<string, unknown> => ({
        id,
        num: 0,
        kind: "question",
        state: "open",
        resolution: null,
        awaiting: "user",
        rank: 0,
        title: "Pick one",
        body: "",
        labels: [],
        links: [],
        supersedes: null,
        origin_convo_id: origin,
        created_by: "agent",
        created_at: now,
        updated_at: now,
        closed_at: null,
        mission_id: missionId,
        mission_num: null,
        comment_count: 0,
        last_comment_at: null,
        attachments: [],
        has_image: false,
    });
    const tracker = state as unknown as Record<string, unknown>;
    tracker.inboxItems = [question("it_a", "c2", "ms_a"), question("it_b", "c2", null), question("it_c", "c1", "ms_b")];
    state.newConversationIds = new Set(["c3"]);
}

// Stub the new-session data path so a driver click on "New session" reaches the folders
// form (agent → recent folders) where the themed inputs / checkbox / Start live.
// The Ops page (`openOps(mode)`) swaps in its own box roster, parsed exactly as GET /devices is.
let opsMode: OpsFixtureMode | null = null;
(client as unknown as { listAgents: () => Promise<unknown[]> }).listAgents = async () =>
    opsMode
        ? opsDevices(opsMode).map((d) => {
              const raw = d as Record<string, unknown>;
              const status = parseBoxStatus(raw.status);
              return status ? { ...raw, status } : raw;
          })
        : [
              {
                  device_id: "dev-local",
                  connected: true,
                  label: "workstation",
                  hostname: "workstation",
                  name: "workstation",
              },
          ];
(client as unknown as { journalMetrics: () => Promise<unknown> }).journalMetrics = async () =>
    parseMetrics({
        user: { head_seq: opsMetrics.head_seq, devices: opsMetrics.devices },
        sockets_connected: opsMetrics.sockets_connected,
        journal_row_count: opsMetrics.journal_row_count,
        db_file_size_bytes: opsMetrics.db_file_size_bytes,
    });
(client as unknown as { opsSnapshot: (id: number, section: OpsSection) => Promise<unknown> }).opsSnapshot = async (
    id,
    section,
) => sectionStateFromReply(section, await opsReply(opsMode ?? "ok", id, section));
// The offer carries the agent switch and the model / effort pickers; `?newSessionAgents=1`
// offers Claude only (no switch), as a box without Codex does.
(client as unknown as { newSessionOffer: () => Promise<unknown> }).newSessionOffer = async () => ({
    folders: [
        { path: "/srv/app/web", last_used: Date.now() - 150 * 60_000 },
        { path: "/srv/app/api", last_used: Date.now() - 3 * 24 * 60 * 60_000 },
        { path: "/srv/app", last_used: null },
    ],
    agentOptions:
        new URLSearchParams(window.location.search).get("newSessionAgents") === "1"
            ? [{ value: "claude", label: "Claude" }]
            : [
                  { value: "claude", label: "Claude" },
                  { value: "codex", label: "Codex" },
              ],
    defaultAgent: "claude",
    modelOptions: [
        { value: "opus", label: "Opus" },
        { value: "sonnet", label: "Sonnet" },
        { value: "haiku", label: "Haiku" },
    ],
    defaultModel: "opus",
    effortOptions: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "X-High" },
        { value: "max", label: "Max" },
    ],
    defaultEffort: "high",
});

// Settings → Coordinator shows the consent-approval switch (on); a flip just moves it. Stop session
// on a Coordinator-approved spawn "sends" at once, or fails with ?stop=fail.
{
    const stub = client as unknown as Record<string, unknown>;
    const patch = (update: Partial<ClientState>): void =>
        (client as unknown as { patch: (update: Partial<ClientState>) => void }).patch(update);
    state.coordinatorConsent = { enabled: true };
    stub.loadCoordinatorConsent = async () => undefined;
    stub.setCoordinatorConsent = async (enabled: boolean) => patch({ coordinatorConsent: { enabled } });
    const stopFails = fixtureParams.get("stop") === "fail";
    stub.sendMessage = async () => !stopFails;
}

// The Coordinator is c2 (its unread count badges the rail entry); ?coordinator=none leaves it
// unset, so the rail entry and Settings offer the chooser. The Routines sheet lists the starter
// set: a pause flips the row, Run now is accepted, and saves and deletes land in the list.
{
    const stub = client as unknown as Record<string, unknown>;
    const patch = (update: Partial<ClientState>): void =>
        (client as unknown as { patch: (update: Partial<ClientState>) => void }).patch(update);
    const now = Date.now();
    const day = new Date(now);
    const at = (offsetDays: number, hour: number, minute: number): number =>
        new Date(day.getFullYear(), day.getMonth(), day.getDate() + offsetDays, hour, minute).getTime();
    const base = { tz: "Europe/London", origin: "seed", created_at: now - 9 * 86_400_000, updated_at: now };
    const routines: Routine[] = [
        {
            ...base,
            id: "rt_1",
            name: "daily-sweep",
            title: "Daily sweep",
            schedule: "5 7 * * *",
            trigger: null,
            prompt: "Follow the daily-sweep section of the playbook.",
            enabled: true,
            next_at: at(1, 7, 5),
            last_fired_at: now - 5 * 3_600_000,
            last_outcome: "applied now",
        },
        {
            ...base,
            id: "rt_2",
            name: "deploy-window",
            title: "Deploy window",
            schedule: "30 18 * * 1-5",
            trigger: null,
            prompt: "Follow the deploy-window section of the playbook.",
            enabled: false,
            next_at: null,
            last_fired_at: now - 2 * 86_400_000,
            last_outcome: "applied deferred",
        },
        {
            ...base,
            id: "rt_3",
            name: "disk-low",
            title: "Disk low",
            schedule: null,
            trigger: { kind: "disk_under", threshold: 20 },
            prompt: "Follow the disk-low section of the playbook.",
            enabled: true,
            next_at: null,
            last_fired_at: now - 40 * 60_000,
            last_outcome: "failed agent_unreachable",
        },
        {
            ...base,
            id: "rt_4",
            name: "project-status",
            title: "Project status",
            schedule: "0 8,17 * * *",
            trigger: null,
            prompt: "Follow the project-status section of the playbook.",
            enabled: true,
            next_at: at(0, 17, 0) > now ? at(0, 17, 0) : at(1, 8, 0),
            last_fired_at: null,
            last_outcome: null,
        },
        {
            ...base,
            id: "rt_5",
            name: "stalled-session",
            title: "Stalled session",
            schedule: null,
            trigger: { kind: "stalled", threshold: 120 },
            prompt: "Follow the stalled-session section of the playbook.",
            enabled: true,
            next_at: null,
            last_fired_at: null,
            last_outcome: null,
        },
    ];
    state.coordinatorConvoId = fixtureParams.get("coordinator") === "none" ? null : "c2";
    const current = (): Routine[] => client.getSnapshot().routines?.list ?? routines;
    const setList = (list: Routine[]): void =>
        patch({ routines: { list: [...list].sort((a, b) => a.name.localeCompare(b.name)), unsupported: false } });
    stub.coordinatorConversationId = async () => client.getSnapshot().coordinatorConvoId ?? null;
    stub.setCoordinator = async (convoId: string | null) => {
        patch({ coordinatorConvoId: convoId });
        return undefined;
    };
    stub.loadRoutines = async () => setList(current());
    stub.watchRoutines = () => {
        setList(current());
        return () => undefined;
    };
    stub.setRoutineEnabled = async (id: string, enabled: boolean) => {
        setList(
            current().map((row) => (row.id === id ? { ...row, enabled, next_at: enabled ? row.next_at : null } : row)),
        );
        return undefined;
    };
    stub.runRoutine = async () => null;
    stub.deleteRoutine = async (id: string) => {
        setList(current().filter((row) => row.id !== id));
        return undefined;
    };
}

// Settings → Devices: a made-up roster (this browser, a phone, two agent boxes). Rename, tag and
// revoke edit it in place. Add Agent previews any full code as a request from a fixture host and
// the box "connects" on the first poll; Link a Device shows a fixed code, and with ?link=claimed a
// device asks to sign in on the first poll.
{
    const stub = client as unknown as Record<string, unknown>;
    const now = Date.now();
    let roster = [
        {
            device_id: 1,
            kind: "client",
            name: "Browser",
            created_at: now - 9 * DAY_MS,
            lag: 0,
            last_seen_at: now,
            connected: true,
            is_self: true,
        },
        {
            device_id: 3,
            kind: "client",
            name: "Phone",
            created_at: now - 4 * DAY_MS,
            lag: 12,
            last_seen_at: now - 2 * 3600_000,
            connected: false,
            is_self: false,
        },
        {
            device_id: 2,
            kind: "agent",
            name: "box-a",
            tag_char: "a",
            created_at: now - 30 * DAY_MS,
            lag: 0,
            last_seen_at: now - 60_000,
            connected: true,
            is_self: false,
        },
        {
            device_id: 4,
            kind: "agent",
            name: "box-b",
            tag_char: null,
            created_at: now - 20 * DAY_MS,
            lag: 0,
            last_seen_at: now - 3 * DAY_MS,
            connected: false,
            is_self: false,
        },
    ];
    const edit = (id: number, change: Record<string, unknown>): void => {
        roster = roster.map((device) => (device.device_id === id ? { ...device, ...change } : device));
    };
    stub.listDevices = async () => roster;
    stub.renameDevice = async (id: number, name: string) => edit(id, { name });
    stub.setDeviceTag = async (id: number, tag: string | null) => edit(id, { tag_char: tag });
    stub.revokeDevice = async (device: { device_id: number }) => {
        roster = roster.filter((entry) => entry.device_id !== device.device_id);
    };
    stub.pairPreview = async () => ({ requester_ip: "box-c.example.com", expires_in: 540 });
    stub.pairApprove = async (_code: string, name: string, tag: string | null) => {
        roster = [
            ...roster,
            {
                device_id: 5,
                kind: "agent",
                name,
                tag_char: tag,
                created_at: Date.now(),
                lag: 0,
                last_seen_at: Date.now(),
                connected: true,
                is_self: false,
            },
        ];
    };
    stub.linkStart = async () => ({ link_code: "KTNM-3VQ8", expires_in: 300 });
    stub.linkStatus = async () =>
        fixtureParams.get("link") === "claimed"
            ? { status: "claimed", device_name: "Laptop", requester_ip: "laptop.example.com", expires_in: 280 }
            : { status: "waiting", expires_in: 290 };
    stub.linkApprove = async () => undefined;
    stub.linkDeny = async () => undefined;
}

// Media stubs: a short generated tone for the voice note, a 404 for the reaped blob.
function toneWav(seconds = 2, rate = 8000): Blob {
    const samples = seconds * rate;
    const view = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (offset: number, value: string): void =>
        [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
    text(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * 440) * 8000, true);
    return new Blob([view.buffer], { type: "audio/wav" });
}
// A generated "photo" (a gradient with a few shapes) for the media browser's thumbnails.
function fixturePhoto(seed: number): Promise<Blob> {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d")!;
    const hue = (seed * 47) % 360;
    const gradient = ctx.createLinearGradient(0, 0, 320, 240);
    gradient.addColorStop(0, `hsl(${hue} 60% 62%)`);
    gradient.addColorStop(1, `hsl(${(hue + 60) % 360} 55% 38%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = "rgb(255 255 255 / 35%)";
    for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(((seed + 1) * 70 * (i + 1)) % 320, ((seed + 3) * 40 * (i + 2)) % 240, 18 + i * 9, 0, Math.PI * 2);
        ctx.fill();
    }
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
}

// ?subchats=1: a "Subtask" line in the deploy chat that opens its subagent, which has a transcript
// of its own for the pane beside the chat. ?media=1: photos, files and links for the media
// browser. ?pane=1 opens the subagent pane on load.
const subagentEvents: JournalEvent[] = [];
if (fixtureParams.get("subchats") === "1") {
    conversations.push({
        id: "s3",
        title: "audit auth call sites",
        agent_device_id: 1,
        session_state: "running",
        last_seq: 3,
        unread_count: 0,
        snippet: "11 of 14 handlers checked",
        created_at: 2,
        parent_convo_id: "c1",
        read_up_to_seq: 3,
    });
    const at = events[events.length - 1].ts;
    events.push(
        {
            seq: 900,
            convo_id: "c1",
            ts: at + 60_000,
            sender: "agent:claude",
            type: "text",
            payload: { body: "Checking every handler before the swap." },
        },
        {
            seq: 901,
            convo_id: "c1",
            ts: at + 61_000,
            sender: "agent:claude",
            type: "text",
            payload: { body: "🔀 Subtask: audit auth call sites" },
        },
        {
            seq: 902,
            convo_id: "c1",
            ts: at + 62_000,
            sender: "agent:claude",
            type: "text",
            payload: { body: "🔀 Subtask: docs sweep" },
        },
    );
    subagentEvents.push(
        {
            seq: 1,
            convo_id: "s3",
            ts: at + 61_500,
            sender: "agent:claude",
            type: "text",
            payload: { body: "Listing every route that reads the session cookie." },
        },
        {
            seq: 2,
            convo_id: "s3",
            ts: at + 62_500,
            sender: "agent:claude",
            type: "tool_output",
            payload: {
                command: "rg -l 'requireSession' src/routes",
                exit_code: 0,
                snippet: "src/routes/admin.ts\nsrc/routes/export.ts\nsrc/routes/upload.ts",
            },
        },
        {
            seq: 3,
            convo_id: "s3",
            ts: at + 63_500,
            sender: "agent:claude",
            type: "text",
            payload: {
                body: "11 of 14 handlers checked. `export.ts` skips the check on its **HEAD** route — flagging it for the parent.",
            },
        },
    );
}
if (fixtureParams.get("media") === "1") {
    const at = events[0].ts;
    for (let i = 0; i < 7; i++) {
        events.push({
            seq: 800 + i,
            convo_id: "c1",
            ts: at + i * 3_600_000,
            sender: i % 3 ? "agent:claude" : "user:operator",
            type: "image",
            payload: { blob_ref: `fixture-photo-${i}`, content_type: "image/png", caption: `Screenshot ${i + 1}` },
        });
    }
    events.push(
        {
            seq: 810,
            convo_id: "c1",
            ts: at + 8 * 3_600_000,
            sender: "agent:claude",
            type: "text",
            payload: {
                body: "Release notes are up: https://example.com/releases/1.12 — and the status page is https://status.example.com.",
            },
        },
        {
            seq: 811,
            convo_id: "c1",
            ts: at + 9 * 3_600_000,
            sender: "user:operator",
            type: "text",
            payload: { body: "Compare with [last week's run](https://example.com/runs/412)." },
        },
    );
    events.sort((left, right) => left.ts - right.ts);
}
{
    const stub = client as unknown as Record<string, unknown>;
    stub.conversationEvents = async (convoId: string): Promise<JournalEvent[]> =>
        convoId === "s3" ? subagentEvents : convoId === "c1" ? events : [];
    if (fixtureParams.get("pane") === "1") state.subChatPane = { parentId: "c1", childId: "s3" };
}

const realMediaUrl = client.mediaUrl.bind(client);
client.mediaUrl = async (mediaId: string): Promise<string> => {
    const photo = /^fixture-photo-(\d+)$/.exec(mediaId);
    if (photo) return URL.createObjectURL(await fixturePhoto(Number(photo[1])));
    if (mediaId === "fixture-voice") return URL.createObjectURL(toneWav());
    if (mediaId === "fixture-gone") throw new JournalApiError("Not found", 404);
    return realMediaUrl(mediaId);
};

// ?notify=default|granted|denied: a stand-in for the browser's Notification API, so the
// Settings → Notifications group can be shot in each permission state.
const notifyParam = new URLSearchParams(window.location.search).get("notify");
if (notifyParam === "default" || notifyParam === "granted" || notifyParam === "denied") {
    class FixtureNotification {
        public static permission: NotificationPermission = notifyParam as NotificationPermission;
        public static requestPermission = async (): Promise<NotificationPermission> => {
            FixtureNotification.permission = "granted";
            return "granted";
        };
        public onclick: (() => void) | null = null;
        public close(): void {}
    }
    Object.defineProperty(window, "Notification", { value: FixtureNotification, configurable: true });
}

// ?context=large puts the open conversation past the compact threshold, so the
// "Large conversation" nudge shows under the header.
if (new URLSearchParams(window.location.search).get("context") === "large") {
    state.sessionStatus = {
        ...state.sessionStatus,
        context: { tokens: 512_300, window: 1_000_000, pct: 51 },
    };
}

// v6 options sheet: the box's start options (bridge recent_folders reply, parsed).
(client as unknown as { sessionOptions: () => Promise<unknown> }).sessionOptions = async () => ({
    folders: [
        { path: "/opt/matron/web-journal", last_used: 3 },
        { path: "/home/user/workspace", last_used: 2 },
        { path: "/opt/matron/journal", last_used: 1 },
    ],
    models: [
        { value: "opus", label: "Opus 4.5" },
        { value: "sonnet", label: "Sonnet 4.5" },
        { value: "haiku", label: "Haiku 4.5" },
    ],
    defaultModel: "opus",
    agents: ["claude", "codex"],
    defaultAgent: "claude",
});
// One tap never resolves in the harness, so the split's "Starting…" state can be captured.
(client as unknown as { startSessionRpc: () => Promise<unknown> }).startSessionRpc = () => new Promise(() => undefined);
if (new URLSearchParams(window.location.search).get("remember") === "1")
    localStorage.setItem(
        "matron.newSessionDefaults.dev-local",
        JSON.stringify({ folder: "/home/user/workspace", model: "opus", agent: "claude" }),
    );

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
const FILES_ROOT = "/home/user/workspace";
// Global write switch for the harness: `openFilesReadOnly()` flips it off to shoot the dormant
// (MATRON_FILE_ENABLE_WRITES=0 / dry-run) deploy, where the pane must look exactly like Phase 1.
let filesWritable = true;
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
    { name: "readonly-dir", kind: "dir", size: 0, mtime: T * 1000, mime: "" },
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
    "curl -s /journal/files/list?path=/home/user/workspace",
    "```",
].join("\n");

const PDF_BYTES = Uint8Array.from(atob(MINIMAL_PDF.split(",")[1]), (c) => c.charCodeAt(0));
const mockFilesApi: FilesApiLike = {
    listDir: async (requested: string | undefined, all?: boolean): Promise<FileListing> => {
        // No path = the server's default folder (the mock's only read root).
        const path = requested ?? FILES_ROOT;
        if (path.endsWith("denied-dir")) throw new JournalApiError("denied", 403, "forbidden");
        // `root` per the F4 contract: the read-root containing `path`. Breadcrumbs never go above it.
        // `writable` is the Phase-2 capability flag: true everywhere EXCEPT read-only-dir, which
        // stands in for a directory outside MATRON_FILE_WRITE_ROOTS (or a writes-off / dry-run
        // server) so the harness can shoot the "no write affordances at all" state.
        const base = {
            path,
            root: FILES_ROOT,
            parent: path === FILES_ROOT ? null : FILES_ROOT,
            writable: filesWritable && !path.endsWith("readonly-dir"),
        };
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
    fileBytes: async (path: string): Promise<ArrayBuffer> => {
        // The PDF preview wants real PDF bytes; the inline EDITOR reads through here too (strict
        // UTF-8 decode), so a text path must return the same sample its preview shows.
        if (TEXT_EXT.has(extOf(path))) {
            return new TextEncoder().encode(await mockFilesApi.textContent(path)).buffer as ArrayBuffer;
        }
        const copy = new Uint8Array(PDF_BYTES.length);
        copy.set(PDF_BYTES);
        return copy.buffer;
    },
    contentUrl: async (path: string): Promise<string> => {
        if (path.endsWith(".png")) return `data:image/png;base64,${PNG_8X8}`;
        if (path.endsWith(".mp3")) return "data:audio/mpeg;base64,";
        if (path.endsWith(".mp4")) return "data:video/mp4;base64,";
        return "data:application/octet-stream;base64,";
    },
    download: async (): Promise<void> => {},
    // Phase-2 writes. The harness never touches a real filesystem: each write resolves with the
    // shape the server contract promises, so the confirm dialogs, the post-write refresh, and the
    // outcome notice can all be shot without a backend.
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
        trashed: `${FILES_ROOT}/.matron-trash/20260821T101500Z-7f3a-${path.slice(path.lastIndexOf("/") + 1)}`,
        alreadyMissing: false,
        dryRun: false,
    }),
    dispose: (): void => {},
};
(client as unknown as { filesApi: () => FilesApiLike }).filesApi = () => mockFilesApi;
const patchState = (client as unknown as { patch: (update: Partial<ClientState>) => void }).patch.bind(client);

// ── Tracker pane fixture (Phase 4) ──────────────────────────────────────────────────────────────
// Canned missions / inbox items / a mission detail / an item detail so the harness can shoot the
// four tracker surfaces (missions list, mission detail, inbox, item detail) in both themes without
// a live server. The fake client has no `api`, so the pane's load* effects no-op and this
// pre-patched store data is what renders (mirrors how the Files pane is driven above).
const H = 3_600_000;
const trackerMissions: Mission[] = [
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
        created_at: Date.now() - 40 * H,
        updated_at: Date.now() - 2 * H,
        last_milestone_at: Date.now() - 2 * H,
        closed_at: null,
        open_items: 3,
        needs_you: 2,
        conversations: 2,
        milestones: 4,
        last_milestone: {
            num: 11,
            title: "Approved the visual language",
            kind: "user_input",
            created_at: Date.now() - 2 * H,
        },
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
        created_at: Date.now() - 90 * H,
        updated_at: Date.now() - 26 * H,
        last_milestone_at: Date.now() - 26 * H,
        closed_at: null,
        open_items: 0,
        needs_you: 0,
        conversations: 1,
        milestones: 2,
        last_milestone: { num: 8, title: "Cron entry verified", kind: "progress", created_at: Date.now() - 26 * H },
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
        created_at: Date.now() - 200 * H,
        updated_at: Date.now() - 120 * H,
        last_milestone_at: Date.now() - 130 * H,
        closed_at: Date.now() - 120 * H,
        open_items: 0,
        needs_you: 0,
        conversations: 1,
        milestones: 3,
        last_milestone: { num: 5, title: "Dry-run clean", kind: "progress", created_at: Date.now() - 130 * H },
    },
];

const trackerInboxItems: TrackerItem[] = [
    {
        id: "it_12",
        num: 12,
        kind: "question",
        state: "open",
        resolution: null,
        awaiting: "user",
        rank: 0,
        title: "Which brand colour for the tracker accent?",
        body: "Yellow reads as the needs-you signal already — do we reuse it or introduce a second accent?",
        labels: ["design"],
        links: [],
        supersedes: null,
        origin_convo_id: "c1",
        created_by: "agent",
        created_at: Date.now() - 5 * H,
        updated_at: Date.now() - 1 * H,
        closed_at: null,
        mission_id: "ms_5",
        mission_num: 5,
        comment_count: 2,
        last_comment_at: Date.now() - 1 * H,
        attachments: [],
        has_image: false,
    },
    {
        id: "it_13",
        num: 13,
        kind: "decision",
        state: "open",
        resolution: null,
        awaiting: "user",
        rank: 0,
        title: "Fold plug revenue into the dashboard balance?",
        body: "",
        labels: [],
        links: [],
        supersedes: null,
        origin_convo_id: "c2",
        created_by: "agent",
        created_at: Date.now() - 8 * H,
        updated_at: Date.now() - 3 * H,
        closed_at: null,
        mission_id: null,
        mission_num: null,
        comment_count: 0,
        last_comment_at: null,
        attachments: [],
        has_image: false,
    },
    {
        id: "it_14",
        num: 14,
        kind: "task",
        state: "open",
        resolution: null,
        awaiting: "agent",
        rank: 0,
        title: "Wire the WS invalidation for tracker markers",
        body: "Refetch only the loaded surface on item/mission/milestone frames.",
        labels: [],
        links: [],
        supersedes: null,
        origin_convo_id: "c1",
        created_by: "agent",
        created_at: Date.now() - 10 * H,
        updated_at: Date.now() - 6 * H,
        closed_at: null,
        mission_id: "ms_5",
        mission_num: 5,
        comment_count: 1,
        last_comment_at: Date.now() - 6 * H,
        attachments: [],
        has_image: false,
    },
];

const trackerItemDetail: { item: TrackerItem; comments: TrackerComment[] } = {
    item: trackerInboxItems[0],
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
            created_at: Date.now() - 4 * H,
        },
        {
            id: "cm_2",
            item_id: "it_12",
            author: "user",
            device_id: 2,
            kind: "comment",
            body: "Agreed — keep orange for needs-you only. Use the teal accent for the tracker chrome.",
            attachments: [],
            meta: null,
            created_at: Date.now() - 1 * H,
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
            created_at: Date.now() - 1 * H,
        },
    ],
};

const trackerMissionDetail: MissionDetail = {
    mission: trackerMissions[0],
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
            created_at: Date.now() - 2 * H,
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
            created_at: Date.now() - 20 * H,
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
            updated_at: Date.now() - 1 * H,
        },
        {
            id: "it_14",
            num: 14,
            kind: "task",
            state: "open",
            awaiting: "agent",
            title: "Wire the WS invalidation for tracker markers",
            origin_convo_id: "c1",
            updated_at: Date.now() - 6 * H,
        },
    ],
    conversations: [
        { id: "c1", title: "matron-web · deploy", state: "running", box: "vps" },
        { id: "s1", title: "test triage", state: "running", box: "vps" },
    ],
};

// Expose hooks so the Playwright driver can drive states (stage files → upload modal, etc.).
// Work tab: replace the fake client's `work()` so the REAL WorkView (list, filters, detail) renders
// a canned loop store. `openWork(mode)` picks the payload; reload between modes, since a mounted
// Work view only refetches on its own interval.
let workMode: WorkFixtureMode = "ok";
(client as unknown as { work: (groupBy: "repo" | "domain") => Promise<unknown> }).work = (groupBy) =>
    workFixture(workMode, groupBy);

const runbook = (): File => new File([new Uint8Array(1024)], "deploy-runbook.pdf", { type: "application/pdf" });
const errorLog = (): File => new File([new Uint8Array(512)], "error-log.txt", { type: "text/plain" });
(window as unknown as { __matron: unknown }).__matron = {
    client,
    openFiles: (path: string = FILES_ROOT) => {
        filesWritable = true;
        patchState({ filesView: { open: true, path } });
    },
    // The dormant/dry-run server: `writable:false` everywhere, so zero write affordances render.
    openFilesReadOnly: (path: string = FILES_ROOT) => {
        filesWritable = false;
        patchState({ filesView: { open: true, path } });
    },
    // Stage a Files-pane upload without a real file picker (Playwright can't drive the native one).
    stageFileUpload: () => {
        const input = document.querySelector(".mj_FilesToolbar_file") as HTMLInputElement | null;
        if (!input) return;
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(2048)], "contact-sheet.png", { type: "image/png" }));
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    closeFiles: () => patchState({ filesView: undefined }),
    // Tracker: the four surfaces. The pane's load* effects no-op (no api), so pre-patch the store.
    openTrackerMissions: () =>
        patchState({
            filesView: undefined,
            trackerView: { open: true, view: "missions" },
            missions: trackerMissions,
            inboxItems: trackerInboxItems,
        }),
    openTrackerMission: () =>
        patchState({
            filesView: undefined,
            trackerView: { open: true, view: "missions", selectedMissionId: 5 },
            missions: trackerMissions,
            trackerMission: trackerMissionDetail,
        }),
    openTrackerInbox: () =>
        patchState({
            filesView: undefined,
            trackerView: { open: true, view: "inbox" },
            missions: trackerMissions,
            inboxItems: trackerInboxItems,
        }),
    openTrackerItem: () =>
        patchState({
            filesView: undefined,
            trackerView: { open: true, view: "inbox", selectedItemId: 12 },
            inboxItems: trackerInboxItems,
            trackerItem: trackerItemDetail,
        }),
    closeTracker: () => patchState({ trackerView: undefined }),
    openWork: (mode: WorkFixtureMode = "ok") => {
        workMode = mode;
        patchState({ filesView: undefined, trackerView: { open: true, view: "work" } });
    },
    openWorkLoop: (id: number, mode: WorkFixtureMode = "ok") => {
        workMode = mode;
        patchState({ filesView: undefined, trackerView: { open: true, view: "work", selectedLoopId: id } });
    },
    openOps: (mode: OpsFixtureMode = "ok") => {
        opsMode = mode;
        patchState({ filesView: undefined, trackerView: undefined, opsView: { open: true } });
    },
    stageImage: (name = "screenshot.png") => client.stageFiles([imageFile(name)]),
    stageDoc: () => client.stageFiles([runbook()]),
    stageTwo: () => client.stageFiles([imageFile("Screenshot 2026-07-25 at 10.12.05.png"), errorLog()]),
    // A send in flight: the first file uploading, the rest waiting their turn.
    trayUploading: () =>
        patchState({
            composerAttachments: {
                c1: [
                    { id: "t1", file: imageFile("screenshot.png"), state: "uploading", progress: 0.62 },
                    { id: "t2", file: runbook(), state: "queued" },
                    { id: "t3", file: errorLog(), state: "queued" },
                ],
            },
        }),
    // A send that stopped at a failed upload: the reason on the chip, a retry beside remove.
    trayFailed: () =>
        patchState({
            composerAttachments: {
                c1: [
                    { id: "t2", file: runbook(), state: "failed", error: "File too large." },
                    { id: "t3", file: errorLog(), state: "staged" },
                ],
            },
        }),
    setTheme: (t: string) => document.documentElement.setAttribute("data-theme", t),
    // Switch conversation (or none, for the home page) the way the client's own select would.
    // A voice note recording in one conversation keeps going, with the app-wide bar elsewhere.
    selectConversation: (id?: string) =>
        patchState({ selectedConversationId: id, events: id === "c1" ? state.events : [], pendingMessages: [] }),
    // Drive the child (subagent) view: select the running child s1 of parent c1 → back chip +
    // ↳ header + ringed current pill. The fixture client has no database, so selectConversation
    // no-ops; patch the state directly (mirrors the client's own patch()).
    selectChild: () =>
        patchState({
            selectedConversationId: "s1",
            events: [],
            pendingMessages: [],
            sessionStatus: state.sessionStatus,
        }),
    // Drive the pinned summary by rewriting the selected conversation's stored
    // digest, which is exactly how the real feed reaches it (snapshot row / convo_meta).
    // "none" is the renders-nothing case; the empty-state box and the "updating" shimmer have
    // no wire representation by design and are covered by unit tests instead.
    setSummary: (kind: "full" | "short" | "none" = "full") =>
        patchState({
            conversations: conversations.map((conversation) =>
                conversation.id === "c1"
                    ? {
                          ...conversation,
                          summary:
                              kind === "none"
                                  ? ""
                                  : kind === "short"
                                    ? PINNED_SUMMARY_TEXT.split("\n").slice(0, 2).join("\n")
                                    : PINNED_SUMMARY_TEXT,
                      }
                    : conversation,
            ),
        }),
};

const container = document.getElementById("matron");
if (!container) throw new Error("fixture container missing");
createRoot(container).render(<MatronApp client={client} />);
