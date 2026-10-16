/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Fills a local journal with a synthetic account through the public protocol, the same way
 * bridges and apps write: agent `convo_upsert`/`publish` and client `send` over the WebSocket,
 * and the HTTP tracker routes for projects, missions, milestones, items and comments.
 */

import crypto from "node:crypto";
import { conversationEvents, rng, words, agentText, userText, SCALES, DATASET_VERSION } from "./dataset.mjs";
import { provision, login } from "./journal.mjs";

/** A WebSocket that resolves sends against the journal frame they produce. */
export async function openSocket(wsUrl, token) {
    // Node's built-in WebSocket: the harness adds no dependency for the seeder.
    const ws = new WebSocket(wsUrl);
    const waiters = new Map();
    let head = 0;
    let onError;
    const errors = [];
    ws.addEventListener("message", (message) => {
        let frame;
        try {
            frame = JSON.parse(String(message.data));
        } catch {
            return;
        }
        if (frame.kind === "control" && frame.op === "hello_ok") {
            head = frame.seq;
            waiters.get("hello")?.(frame);
            return;
        }
        if (frame.kind === "control" && frame.op === "error") {
            errors.push(frame);
            onError?.(frame);
            return;
        }
        if (frame.kind === "journal") {
            head = Math.max(head, frame.seq);
            const key = frame.type === "convo_meta" ? `meta:${frame.convo_id}` : frame.payload?.__perf_key;
            if (key && waiters.has(key)) {
                waiters.get(key)(frame);
                waiters.delete(key);
            }
        }
    });
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
    });
    const hello = new Promise((resolve) => waiters.set("hello", resolve));
    ws.send(JSON.stringify({ op: "hello", token, cursor: null }));
    await hello;
    waiters.delete("hello");
    const send = (frame) => ws.send(JSON.stringify(frame));
    return {
        ws,
        send,
        errors,
        head: () => head,
        set onError(fn) {
            onError = fn;
        },
        /** Send a frame and wait for the journal frame carrying `key`. */
        expect(key, frame, timeoutMs = 30000) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`timed out waiting for ${key}`)), timeoutMs);
                waiters.set(key, (f) => {
                    clearTimeout(timer);
                    resolve(f);
                });
                send(frame);
            });
        },
        close: () => ws.close(),
    };
}

async function http(journal, token, method, path, body) {
    for (let attempt = 0; ; attempt++) {
        const response = await fetch(`${journal.url}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (response.status === 429 && attempt < 20) {
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            continue;
        }
        if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
        return response.json();
    }
}

const uuid = (r) => {
    const hex = Array.from({ length: 32 }, () => Math.floor(r.next() * 16).toString(16)).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Seed the account. Returns a manifest of what was made (ids the scenarios open), which run.mjs
 * keeps next to the database so a seeded journal can be reused.
 */
export async function seed(journal, { scale = "full", seed: seedValue = 1, log = () => {} } = {}) {
    const size = SCALES[scale];
    if (!size) throw new Error(`unknown scale ${scale}`);
    const r = rng(seedValue);
    const boxes = Array.from({ length: size.boxes }, (_, i) => `box-${String.fromCharCode(97 + i)}`);
    const { username, agents } = provision(journal, { boxes });
    const client = await login(journal, username, "perf-seeder");
    const userSocket = await openSocket(journal.wsUrl, client.token);
    const agentSockets = await Promise.all(agents.map((a) => openSocket(journal.wsUrl, a.token)));
    for (const s of [userSocket, ...agentSockets]) {
        s.onError = (f) => {
            throw new Error(`journal refused a seed frame: ${JSON.stringify(f)}`);
        };
    }

    // Conversations: a long tail of ordinary sessions, a few very long ones, and sub-chats.
    const conversations = [];
    const longIds = [];
    let published = 0;
    const plan = [
        ...size.longConversations.map((count) => ({ count, long: true })),
        ...Array.from({ length: size.conversations }, () => ({
            count: r.int(...size.eventsPerConversation),
            long: false,
        })),
    ];
    for (const [index, entry] of plan.entries()) {
        const agentIndex = index % agents.length;
        const agent = agentSockets[agentIndex];
        const id = uuid(r);
        const title = `${words(r, r.int(2, 6))}`;
        // A titled upsert appends a convo_meta frame; wait for it so the user's first message
        // (sent on another socket) never reaches the journal before the conversation exists.
        await agent.expect(`meta:${id}`, {
            op: "convo_upsert",
            convo_id: id,
            title,
            session_state: r.pick(["running", "waiting", "done", "done", "done"]),
        });
        const events = conversationEvents(r, entry.count);
        for (const [n, event] of events.entries()) {
            const key = `${id}:${n}`;
            if (event.by === "user") {
                // Wait for the user's message to land so the transcript keeps its order.
                await userSocket.expect(key, {
                    op: "send",
                    convo_id: id,
                    type: "text",
                    payload: { ...event.payload, __perf_key: key },
                    local_id: key,
                });
            } else if (events[n + 1]?.by === "user") {
                // The user's next message goes over another socket: wait for the agent's turn to
                // land first. Earlier frames on this socket are handled before this one.
                await agent.expect(key, {
                    op: "publish",
                    convo_id: id,
                    type: event.type,
                    payload: { ...event.payload, __perf_key: key },
                    idem_key: key,
                });
            } else {
                agent.send({ op: "publish", convo_id: id, type: event.type, payload: event.payload, idem_key: key });
            }
            published++;
        }
        conversations.push({ id, title, box: boxes[agentIndex], events: entry.count });
        if (entry.long) longIds.push(id);
        if (index % 100 === 0) log(`conversations ${index}/${plan.length}, ${published} events`);
    }
    const subchats = [];
    for (let i = 0; i < size.subchats; i++) {
        const parent = conversations[size.longConversations.length + i];
        const agentIndex = boxes.indexOf(parent.box);
        const id = uuid(r);
        agentSockets[agentIndex].send({
            op: "convo_upsert",
            convo_id: id,
            parent_convo_id: parent.id,
            title: `Subagent: ${words(r, 3)}`,
            session_state: "done",
        });
        for (const [n, event] of conversationEvents(r, r.int(5, 30)).entries()) {
            if (event.by === "user") continue;
            agentSockets[agentIndex].send({
                op: "publish",
                convo_id: id,
                type: event.type,
                payload: event.payload,
                idem_key: `${id}:${n}`,
            });
        }
        subchats.push(id);
    }
    // Drain: each socket's frames are handled in order, so a marker frame echoing back means
    // everything sent before it on that socket has landed.
    await Promise.all(
        agentSockets.map((s, i) => {
            const convo = conversations.find((c) => c.box === boxes[i]);
            const key = `drain:${i}`;
            return s.expect(key, {
                op: "publish",
                convo_id: convo.id,
                type: "text",
                payload: { body: "Done.", __perf_key: key },
                idem_key: key,
            });
        }),
    );
    log(`published ${published} events in ${conversations.length} conversations, ${subchats.length} sub-chats`);

    // Tracker: projects, missions (each born in its own conversation), milestones, items, comments.
    const tokenOf = (convo) => agents[boxes.indexOf(convo.box)].token;
    const projects = [];
    for (let i = 0; i < size.projects; i++) {
        const { project } = await http(journal, client.token, "POST", "/projects", {
            title: words(r, r.int(2, 6)),
            body: agentText(r),
        });
        projects.push(project);
    }
    const missions = [];
    const missionConvos = conversations.slice(0, size.missions);
    for (const convo of missionConvos) {
        const { mission } = await http(journal, tokenOf(convo), "POST", "/missions", {
            title: words(r, r.int(4, 12)),
            name: words(r, 3).slice(0, 40),
            body: agentText(r),
            convo_id: convo.id,
            project: projects.length ? r.pick(projects).id : undefined,
        });
        if (r.chance(0.7)) {
            await http(journal, tokenOf(convo), "PATCH", `/missions/${mission.id}`, {
                status: words(r, r.int(15, 40)).slice(0, 600),
                convo_id: convo.id,
            });
        }
        for (let m = 0, n = r.int(...size.milestonesPerMission); m < n; m++) {
            await http(journal, tokenOf(convo), "POST", "/milestones", {
                convo_id: convo.id,
                kind: r.chance(0.3) ? "user_input" : "progress",
                title: words(r, r.int(4, 12)),
                body: r.chance(0.6) ? agentText(r) : undefined,
            });
        }
        missions.push({ id: mission.id, num: mission.num, convo: convo.id });
    }
    log(`${projects.length} projects, ${missions.length} missions`);
    const items = [];
    const itemsPerConvo = new Map();
    for (let i = 0; i < size.items; i++) {
        // Most items sit in mission conversations, so mission pages carry dozens of them.
        const convo = r.chance(0.8) ? r.pick(missionConvos) : r.pick(conversations);
        const token = tokenOf(convo);
        const kind = r.pick(["task", "task", "question", "decision", "notice"]);
        const { item } = await http(journal, token, "POST", "/items", {
            kind,
            title: words(r, r.int(4, 14)),
            body: agentText(r),
            convo_id: convo.id,
            labels: r.chance(0.3) ? [r.pick(["perf", "web", "bridge", "journal"])] : undefined,
            actions: kind === "question" && r.chance(0.5) ? ["Go", "Hold"] : undefined,
        });
        for (let c = 0, n = r.int(...size.commentsPerItem); c < n; c++) {
            const fromUser = r.chance(0.4);
            await http(journal, fromUser ? client.token : token, "POST", `/items/${item.id}/comments`, {
                body: fromUser ? userText(r) : agentText(r),
            });
        }
        if (!r.chance(size.openItemShare)) {
            await http(journal, client.token, "POST", `/items/${item.id}/close`, {
                resolution: kind === "question" ? "answered" : kind === "decision" ? "decided" : "done",
            }).catch(() => undefined);
        }
        items.push({ id: item.id, num: item.num });
        itemsPerConvo.set(convo.id, (itemsPerConvo.get(convo.id) ?? 0) + 1);
        if (i % 500 === 0) log(`items ${i}/${size.items}`);
    }
    log(`${items.length} items`);

    userSocket.close();
    for (const s of agentSockets) s.close();
    const sorted = [...conversations].sort((a, b) => b.events - a.events);
    return {
        version: DATASET_VERSION,
        scale,
        seed: seedValue,
        username,
        agents,
        conversations: conversations.length,
        events: published,
        longConversations: longIds,
        ordinaryConversations: conversations.filter((c) => !longIds.includes(c.id)).map((c) => c.id),
        // Items filed in a mission's conversation belong to that mission.
        biggestMission: missions.reduce((best, m) =>
            (itemsPerConvo.get(m.convo) ?? 0) > (itemsPerConvo.get(best.convo) ?? 0) ? m : best,
        ),
        largest: sorted[0].id,
        projects: projects.length,
        missions: missions.length,
        items: items.length,
        createdAt: new Date().toISOString(),
        id: crypto.randomUUID(),
    };
}
