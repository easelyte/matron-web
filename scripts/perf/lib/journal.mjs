/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Starts a throwaway matron-journal from a local checkout (MATRON_JOURNAL_DIR), with its own
 * temporary database, and provisions a user and agent boxes through its admin CLI. Nothing here
 * talks to a real deployment.
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const PASSWORD = "perf-harness-password";

export function journalDir() {
    const dir = process.env.MATRON_JOURNAL_DIR;
    if (!dir || !fs.existsSync(path.join(dir, "src/server.js"))) {
        throw new Error("Set MATRON_JOURNAL_DIR to a matron-journal checkout with its dependencies installed");
    }
    return path.resolve(dir);
}

export function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function waitForHttp(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await fetch(url);
            return;
        } catch (error) {
            if (Date.now() > deadline) throw new Error(`journal did not start: ${error}`);
            await new Promise((r) => setTimeout(r, 100));
        }
    }
}

/**
 * Start a journal on a free port. `dataDir` keeps the database between runs (a seeded dataset is
 * reused); without it the database lives in a temporary directory removed on stop().
 */
export async function startJournal({ dataDir } = {}) {
    const dir = journalDir();
    const tmp = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "matron-perf-"));
    fs.mkdirSync(tmp, { recursive: true });
    const db = path.join(tmp, "journal.db");
    const port = await freePort();
    const env = {
        ...process.env,
        MATRON_DB: db,
        MATRON_PORT: String(port),
        MATRON_BIND: "127.0.0.1",
        MATRON_SEMANTIC_SEARCH: "off",
        // Keep the startup backfills out of the measurements.
        MATRON_BACKGROUND_DELAY_MS: "86400000",
        MATRON_GITHUB_CLIENT_ID: "",
        MATRON_MAX_REPLAY: "1000000",
    };
    const child = spawn(process.execPath, ["src/server.js"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    const exited = new Promise((r) => child.once("exit", r));
    const url = `http://127.0.0.1:${port}`;
    try {
        await waitForHttp(url, 15000);
    } catch (error) {
        child.kill();
        throw new Error(`${error.message}\n${log}`);
    }
    const admin = (args, input) =>
        execFileSync(process.execPath, ["bin/matron-admin.js", ...args], {
            cwd: dir,
            env: { ...env, MATRON_PASSWORD: undefined },
            input,
            encoding: "utf8",
        });
    return {
        url,
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        db,
        dataDir: tmp,
        admin,
        log: () => log,
        async stop() {
            child.kill("SIGTERM");
            await exited;
            if (!dataDir) fs.rmSync(tmp, { recursive: true, force: true });
        },
    };
}

/** Create the user and its agent boxes; returns `{ username, agents: [{ name, token }] }`. */
export function provision(journal, { username = "alice", boxes }) {
    journal.admin(["user", "add", username, "--password-stdin"], PASSWORD);
    const agents = boxes.map((name) => {
        const out = journal.admin(["agent", "add", username, name]);
        const match = /token: ([0-9a-f]+)/.exec(out);
        if (!match) throw new Error(`no token in: ${out}`);
        return { name, token: match[1] };
    });
    return { username, agents };
}

/** Sign in as a client device over HTTP, the way the web app does. */
export async function login(journal, username, deviceName = "perf-harness") {
    const response = await fetch(`${journal.url}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: PASSWORD, device_name: deviceName }),
    });
    if (!response.ok) throw new Error(`login failed: ${response.status} ${await response.text()}`);
    return response.json();
}
