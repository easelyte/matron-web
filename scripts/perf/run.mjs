/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Performance harness: seeds a local journal with a synthetic heavy account, serves the built
 * app in front of it and drives headless Chromium through the paths that get slow with real
 * use. Prints a table and writes JSON; with --budget, fails when a number is over budget.
 *
 *   pnpm build
 *   MATRON_JOURNAL_DIR=../matron-journal node scripts/perf/run.mjs [options]
 *
 * Options:
 *   --scale=full|ci       dataset size (default full)
 *   --data=DIR            keep the seeded journal in DIR and reuse it on the next run
 *   --only=a,b            run only these scenarios (bundle, cold, warm, switch, long, tracker,
 *                         stream, soak)
 *   --runs=N              repeat each timed scenario N times and report the median (default 3)
 *   --cpu=N               CPU throttling factor, as in DevTools (default 1)
 *   --latency=MS          add this much round-trip latency to every HTTP request, as a remote
 *                         journal would (default 0)
 *   --out=FILE            write the JSON result here (default perf-results.json)
 *   --budget=FILE         compare against a budget file and exit 1 on a breach
 *   --profile=DIR         save a CPU profile (.cpuprofile, opens in DevTools) per browser page
 *   --headed              show the browser
 *
 * See docs/perf.md for what each scenario measures.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { chromium } from "@playwright/test";

import { startJournal, login } from "./lib/journal.mjs";
import { seed, openSocket } from "./lib/seed.mjs";
import { serveApp } from "./lib/serve.mjs";
import { agentText, rng, DATASET_VERSION } from "./lib/dataset.mjs";

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, "").split("=");
        return [k, v ?? true];
    }),
);
const ROOT = process.cwd();
const WEBAPP = path.join(ROOT, "webapp");
const SCALE = args.scale ?? "full";
const RUNS = Number(args.runs ?? 3);
const CPU = Number(args.cpu ?? 1);
const LATENCY = Number(args.latency ?? 0);
const PROFILE = args.profile ? path.resolve(String(args.profile)) : null;
let currentScenario = "";
let profileCount = 0;
const ONLY = args.only ? new Set(String(args.only).split(",")) : null;
const want = (name) => !ONLY || ONLY.has(name);
const log = (...a) => console.error("[perf]", ...a);

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const p95 = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] : NaN;
};
const round = (x, d = 0) => (Number.isFinite(x) ? Number(x.toFixed(d)) : x);
const MB = (bytes) => round(bytes / 1048576, 1);
const KB = (bytes) => round(bytes / 1024, 1);

// ---------------------------------------------------------------- bundle

function bundleSizes() {
    const assets = path.join(WEBAPP, "assets");
    const html = fs.readFileSync(path.join(WEBAPP, "index.html"), "utf8");
    const files = fs.readdirSync(assets).filter((f) => /\.(m?js|css)$/.test(f));
    const entry = files.filter((f) => html.includes(f));
    const sizeOf = (list) =>
        list.reduce(
            (acc, f) => {
                const buf = fs.readFileSync(path.join(assets, f));
                acc.raw += buf.length;
                acc.gzip += zlib.gzipSync(buf, { level: 9 }).length;
                acc.brotli += zlib.brotliCompressSync(buf).length;
                return acc;
            },
            { raw: 0, gzip: 0, brotli: 0 },
        );
    const all = sizeOf(files);
    const initial = sizeOf(entry);
    return {
        initialJsCssKB: KB(initial.raw),
        initialGzipKB: KB(initial.gzip),
        initialBrotliKB: KB(initial.brotli),
        totalJsCssKB: KB(all.raw),
        totalGzipKB: KB(all.gzip),
        chunks: files.length,
        largest: files
            .map((f) => ({ file: f, KB: KB(fs.statSync(path.join(assets, f)).size), initial: entry.includes(f) }))
            .sort((a, b) => b.KB - a.KB)
            .slice(0, 6),
    };
}

// ---------------------------------------------------------------- browser helpers

const INIT_SCRIPT = () => {
    window.__perf = { longTasks: [], frames: 0 };
    try {
        new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                window.__perf.longTasks.push(e.duration);
                window.__perf.lastLongTaskEnd = e.startTime + e.duration;
            }
        }).observe({ type: "longtask", buffered: true });
    } catch {}
    const tick = () => {
        window.__perf.frames++;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
};

async function newPage(browser) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(INIT_SCRIPT);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    if (CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
    if (LATENCY > 0) {
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: LATENCY,
            downloadThroughput: -1,
            uploadThroughput: -1,
        });
    }
    if (PROFILE) {
        fs.mkdirSync(PROFILE, { recursive: true });
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
        await cdp.send("Profiler.start");
        const close = context.close.bind(context);
        context.close = async () => {
            const { profile } = await cdp.send("Profiler.stop");
            const file = path.join(PROFILE, `${currentScenario}-${++profileCount}.cpuprofile`);
            fs.writeFileSync(file, JSON.stringify(profile));
            return close();
        };
    }
    return { context, page, cdp };
}

async function metrics(cdp) {
    const { metrics: list } = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

async function heapAfterGc(cdp) {
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
    const m = await metrics(cdp);
    return { heap: m.JSHeapUsedSize, nodes: m.Nodes, listeners: m.JSEventListeners };
}

/** Wait for two animation frames after `predicate` holds, so the work it caused has painted. */
async function settled(page, predicate, arg, timeout = 60000) {
    try {
        await page.waitForFunction(predicate, arg, { timeout, polling: "raf" });
    } catch (error) {
        const shot = path.join(process.env.TMPDIR ?? "/tmp", `perf-timeout-${Date.now()}.png`);
        await page.screenshot({ path: shot }).catch(() => undefined);
        throw new Error(`${error.message}\nwaiting for: ${predicate}\nscreenshot: ${shot}`);
    }
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Resolves after the main thread has been idle (no long task) for `quietMs`. */
async function quiet(page, quietMs = 500, timeout = 60000) {
    await page.evaluate(
        ({ quietMs, timeout }) =>
            new Promise((resolve) => {
                const start = performance.now();
                let seen = window.__perf.longTasks.length;
                let since = performance.now();
                const check = () => {
                    if (window.__perf.longTasks.length !== seen) {
                        seen = window.__perf.longTasks.length;
                        since = performance.now();
                    }
                    if (performance.now() - since >= quietMs || performance.now() - start > timeout) resolve();
                    else setTimeout(check, 50);
                };
                check();
            }),
        { quietMs, timeout },
    );
}

/**
 * Run `action`, then report when `predicate` first held (ready) and when the main thread went
 * quiet afterwards (idle: the end of the last long task the action caused), both in ms.
 */
async function timed(page, action, predicate, arg) {
    const t0 = await page.evaluate(() => performance.now());
    await action();
    await settled(page, predicate, arg);
    const ready = await page.evaluate(() => performance.now());
    await quiet(page, 500);
    const lastEnd = await page.evaluate(() => window.__perf.lastLongTaskEnd ?? 0);
    return { readyMs: round(ready - t0), idleMs: round(Math.max(ready, lastEnd) - t0) };
}

const ROWS = ".mj_ConversationList [role=listitem] button[aria-label^='Open ']";
const TILES = "ol.mj_ChatView_messageList > li.mj_EventTile";

// The journal allows five sign-ins a minute per address; keep under it.
const signIns = [];
async function signInSlot() {
    for (;;) {
        const now = Date.now();
        while (signIns.length && now - signIns[0] > 61000) signIns.shift();
        if (signIns.length < 4) break;
        await new Promise((r) => setTimeout(r, 61000 - (now - signIns[0])));
    }
    signIns.push(Date.now());
}

/** Sign in through the form, as a first visit does. Returns when "Sign in" was clicked. */
async function signIn(page, appUrl, username, password) {
    await signInSlot();
    await page.goto(`${appUrl}/app/`);
    await page.fill("#mj_LoginForm_username", username);
    await page.fill("#mj_LoginForm_password", password);
    const clickedAt = Date.now();
    await page.click("button.mj_LoginSubmit");
    return clickedAt;
}

const SESSION_KEY = "matron_journal_session_v1";

/** Open the app already signed in (a stored session, empty local database). */
async function openApp(page, env) {
    await page.addInitScript(
        ({ key, value }) => {
            if (!localStorage.getItem(key)) localStorage.setItem(key, value);
        },
        { key: SESSION_KEY, value: env.session },
    );
    await page.goto(`${env.appUrl}/app/`);
    await settled(page, (sel) => document.querySelectorAll(sel).length > 0, ROWS);
}

async function longTaskStats(page, from = 0) {
    return page.evaluate((from) => {
        const tasks = window.__perf.longTasks.slice(from);
        return { count: tasks.length, totalMs: tasks.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...tasks) };
    }, from);
}

// ---------------------------------------------------------------- scenarios

async function coldLoad(browser, env) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
        const { context, page, cdp } = await newPage(browser);
        const t0 = await signIn(page, env.appUrl, env.manifest.username, env.password);
        await settled(page, (sel) => document.querySelectorAll(sel).length > 0, ROWS);
        const toList = Date.now() - t0;
        await quiet(page);
        const nav = await page.evaluate(() => {
            const fcp = performance.getEntriesByName("first-contentful-paint")[0];
            return { fcp: fcp?.startTime ?? NaN };
        });
        const m = await metrics(cdp);
        const lt = await longTaskStats(page);
        const mem = await heapAfterGc(cdp);
        runs.push({
            signInToListMs: toList,
            scriptMs: m.ScriptDuration * 1000,
            longTaskMs: lt.totalMs,
            maxLongTaskMs: lt.maxMs,
            heapMB: MB(mem.heap),
            domNodes: mem.nodes,
            rows: await page.locator(ROWS).count(),
        });
        await context.close();
    }
    return summarise(runs);
}

async function warmLoad(browser, env) {
    const { context, page } = await newPage(browser);
    await openApp(page, env);
    await quiet(page, 1500);
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
        const t0 = Date.now();
        await page.reload();
        await settled(page, (sel) => document.querySelectorAll(sel).length > 0, ROWS);
        const toList = Date.now() - t0;
        await quiet(page);
        const fcp = await page.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime);
        const lt = await longTaskStats(page);
        const m = await metrics(cdp);
        runs.push({ reloadToListMs: toList, fcpMs: fcp, scriptMs: m.ScriptDuration * 1000, longTaskMs: lt.totalMs });
        await cdp.detach();
    }
    await context.close();
    return summarise(runs);
}

async function selectById(page, id) {
    const t0 = Date.now();
    await page.evaluate((id) => window.__perfClient.selectConversation(id), id);
    await settled(
        page,
        ({ id, sel }) =>
            window.__perfClient.state.selectedConversationId === id &&
            !window.__perfClient.state.loadingHistory &&
            document.querySelectorAll(sel).length > 0,
        { id, sel: TILES },
    );
    return Date.now() - t0;
}

async function switching(browser, env) {
    const { context, page, cdp } = await newPage(browser);
    await openApp(page, env);
    await quiet(page, 1500);
    const r = rng(7);
    const ids = Array.from({ length: 20 }, () => r.pick(env.manifest.ordinaryConversations));
    // First visits fetch history from the journal; revisits read it from IndexedDB/memory.
    const first = [];
    for (const id of ids) first.push(await selectById(page, id));
    const again = [];
    for (const id of ids) again.push(await selectById(page, id));
    // Clicking the sidebar row (the real input path) for a handful, measured from the click.
    const clicks = [];
    const rows = page.locator(ROWS);
    for (let i = 0; i < 10; i++) {
        const t0 = Date.now();
        await rows.nth(i * 3 + 1).click();
        await settled(page, () => !window.__perfClient.state.loadingHistory);
        await settled(page, (sel) => document.querySelectorAll(sel).length > 0, TILES);
        clicks.push(Date.now() - t0);
    }
    const lt = await longTaskStats(page);
    const m = await metrics(cdp);
    await context.close();
    return {
        firstOpenMedianMs: median(first),
        firstOpenP95Ms: p95(first),
        revisitMedianMs: median(again),
        revisitP95Ms: p95(again),
        rowClickMedianMs: median(clicks),
        longTaskMs: round(lt.totalMs),
        scriptMs: round(m.ScriptDuration * 1000),
    };
}

async function longTranscript(browser, env) {
    const { context, page, cdp } = await newPage(browser);
    await openApp(page, env);
    await quiet(page, 1500);
    const id = env.manifest.largest;
    const openMs = await selectById(page, id);
    // Page back through history with the "Load earlier messages" control, as a reader would.
    const pages = [];
    const target = SCALE === "ci" ? 12 : 25;
    for (let i = 0; i < target; i++) {
        const more = await page.locator("button.mj_LoadHistory").count();
        if (!more) break;
        // Count loaded events rather than rows in the DOM: a windowed transcript mounts only the
        // rows near the viewport, so the DOM doesn't grow with each page.
        const before = await page.evaluate(() => window.__perfClient.state.events.length);
        const t0 = Date.now();
        await page.click("button.mj_LoadHistory");
        await settled(
            page,
            (before) => !window.__perfClient.state.loadingHistory && window.__perfClient.state.events.length > before,
            before,
        );
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        pages.push(Date.now() - t0);
    }
    const tiles = await page.locator(TILES).count();
    const eventsLoaded = await page.evaluate(() => window.__perfClient.state.events.length);
    const mem = await heapAfterGc(cdp);
    // Scroll from the top to the bottom in fixed steps and count frames against wall time.
    const scroll = await page.evaluate(async () => {
        const el = document.querySelector(".mj_ChatView_messagePanel");
        el.scrollTop = 0;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const startFrames = window.__perf.frames;
        const startTasks = window.__perf.longTasks.length;
        const t0 = performance.now();
        const step = 400;
        // Bounded, so a scroller that never reaches the bottom fails the run instead of hanging it.
        let stuck = 0;
        while (el.scrollTop + el.clientHeight < el.scrollHeight - 2) {
            const from = el.scrollTop;
            el.scrollTop += step;
            await new Promise((r) => requestAnimationFrame(r));
            stuck = el.scrollTop > from ? 0 : stuck + 1;
            if (stuck > 20 || performance.now() - t0 > 60_000) {
                throw new Error(`scrolling stopped at ${el.scrollTop} of ${el.scrollHeight}`);
            }
        }
        const ms = performance.now() - t0;
        const frames = window.__perf.frames - startFrames;
        const tasks = window.__perf.longTasks.slice(startTasks);
        return { ms, frames, fps: (frames / ms) * 1000, longTasks: tasks.length, scrollHeight: el.scrollHeight };
    });
    // One more page with everything above already loaded: this is the cost per page late in a long read.
    const lastPageMs = pages.at(-1);
    // A new event arriving while all of that is on screen.
    const appendMs = await measureAppend(page, env, id);
    await context.close();
    return {
        openMs,
        pagesLoaded: pages.length,
        firstPageMs: pages[0],
        lastPageMs,
        eventsLoaded,
        tiles,
        heapMB: MB(mem.heap),
        domNodes: mem.nodes,
        scrollFps: round(scroll.fps, 1),
        scrollLongTasks: scroll.longTasks,
        appendWithLongHistoryMs: appendMs,
    };
}

/** The journal answers a refused frame with an error frame and nothing else; fail loudly on one. */
function assertAccepted(agent, what) {
    if (agent.errors.length) throw new Error(`journal refused ${what}: ${JSON.stringify(agent.errors)}`);
}

async function measureAppend(page, env, convoId) {
    const agent = await env.agentFor(convoId);
    const key = `append:${Date.now()}`;
    const body = `One more line (${key}).`;
    const t0 = Date.now();
    agent.send({ op: "publish", convo_id: convoId, type: "text", payload: { body }, idem_key: key });
    // Done when the newest row on screen shows it.
    await settled(page, ({ sel, body }) => [...document.querySelectorAll(sel)].at(-1)?.textContent.includes(body), {
        sel: TILES,
        body,
    });
    assertAccepted(agent, "the appended message");
    return Date.now() - t0;
}

async function tracker(browser, env) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
        const { context, page, cdp } = await newPage(browser);
        await openApp(page, env);
        await quiet(page, 1500);
        const lt0 = (await page.evaluate(() => window.__perf.longTasks.length)) || 0;
        const paneReady = () =>
            !window.__perfClient.state.trackerLoading &&
            document.querySelector(".mj_TrackerPane_body")?.children.length > 0;
        const projects = await timed(page, () => page.click("[data-nav=projects]"), paneReady);
        const inbox = await timed(page, () => page.click("[data-nav=decisions]"), paneReady);
        // The mission with the most items: open it from the client, as a tracker link would.
        const mission = await timed(
            page,
            () => page.evaluate((num) => window.__perfClient.openTrackerLink("mission", num), env.biggestMissionNum),
            () =>
                !window.__perfClient.state.trackerLoading &&
                !!document.querySelector(".mj_TrackerMilestoneRow, .mj_TrackerConvoRow"),
        );
        // Back to chats and in again: the second open should be served from what is loaded.
        await page.click("[data-nav=conversations]");
        await quiet(page, 300);
        const reopen = await timed(page, () => page.click("[data-nav=projects]"), paneReady);
        const lt = await longTaskStats(page, lt0);
        const mem = await heapAfterGc(cdp);
        runs.push({
            projectsReadyMs: projects.readyMs,
            projectsIdleMs: projects.idleMs,
            inboxReadyMs: inbox.readyMs,
            inboxIdleMs: inbox.idleMs,
            missionReadyMs: mission.readyMs,
            missionIdleMs: mission.idleMs,
            reopenReadyMs: reopen.readyMs,
            longTaskMs: lt.totalMs,
            heapMB: MB(mem.heap),
            domNodes: mem.nodes,
        });
        await context.close();
    }
    return summarise(runs);
}

async function streaming(browser, env) {
    const { context, page, cdp } = await newPage(browser);
    await openApp(page, env);
    await quiet(page, 1500);
    const results = {};
    // Same stream into a short conversation and into one with ~1000 events loaded.
    for (const [label, id, pagesToLoad] of [
        ["short", env.manifest.ordinaryConversations[3], 0],
        ["long", env.manifest.largest, SCALE === "ci" ? 6 : 12],
    ]) {
        await selectById(page, id);
        for (let i = 0; i < pagesToLoad; i++) {
            if (!(await page.locator("button.mj_LoadHistory").count())) break;
            const before = await page.evaluate(() => window.__perfClient.state.events.length);
            await page.click("button.mj_LoadHistory");
            await settled(
                page,
                (before) =>
                    !window.__perfClient.state.loadingHistory && window.__perfClient.state.events.length > before,
                before,
            );
        }
        await quiet(page, 1000);
        const tiles = await page.locator(TILES).count();
        const agent = await env.agentFor(id);
        const before = await metrics(cdp);
        const lt0 = await page.evaluate(() => window.__perf.longTasks.length);
        const frames0 = await page.evaluate(() => window.__perf.frames);
        const seconds = 15;
        const r = rng(11);
        const t0 = Date.now();
        const ref0 = `perf-${t0}`;
        let ref = ref0;
        let streamed = "";
        const target = agentText(r) + "\n\n" + agentText(r) + "\n\n" + agentText(r);
        let tick = 0;
        let toolBytes = 0;
        agent.send({ op: "activity", convo_id: id, state: "thinking" });
        // ~25 token frames a second (a fast model), a tool-output stream beside it, and a
        // finished message every few seconds.
        await new Promise((resolve) => {
            const timer = setInterval(() => {
                tick++;
                const chunk = target.slice(streamed.length, streamed.length + 24);
                streamed += chunk;
                agent.send({ op: "stream", convo_id: id, message_ref: ref, text: chunk });
                if (tick % 3 === 0) {
                    const line = `ok ${tick} - ${"output ".repeat(6)}\n`;
                    agent.send({
                        op: "stream_append",
                        convo_id: id,
                        message_ref: `${ref0}-tool`,
                        offset: toolBytes,
                        chunk: line,
                        ...(toolBytes === 0 ? { meta: { tool: "Bash", command: "pnpm test" } } : {}),
                    });
                    toolBytes += Buffer.byteLength(line);
                }
                if (streamed.length >= target.length || tick % 100 === 0) {
                    agent.send({
                        op: "finalize",
                        convo_id: id,
                        message_ref: ref,
                        type: "text",
                        payload: { body: streamed },
                    });
                    ref = `perf-${Date.now()}-${tick}`;
                    streamed = "";
                }
                if (Date.now() - t0 >= seconds * 1000) {
                    clearInterval(timer);
                    resolve();
                }
            }, 40);
        });
        const wall = (Date.now() - t0) / 1000;
        assertAccepted(agent, "the streamed frames");
        const after = await metrics(cdp);
        const lt = await longTaskStats(page, lt0);
        const frames = (await page.evaluate(() => window.__perf.frames)) - frames0;
        agent.send({ op: "activity", convo_id: id, state: "idle" });
        results[label] = {
            tilesOnScreen: tiles,
            mainThreadBusyPct: round(((after.TaskDuration - before.TaskDuration) / wall) * 100, 1),
            scriptPct: round(((after.ScriptDuration - before.ScriptDuration) / wall) * 100, 1),
            layoutStylePct: round(
                ((after.LayoutDuration -
                    before.LayoutDuration +
                    after.RecalcStyleDuration -
                    before.RecalcStyleDuration) /
                    wall) *
                    100,
                1,
            ),
            fps: round(frames / wall, 1),
            longTasks: lt.count,
            maxLongTaskMs: round(lt.maxMs),
        };
    }
    await context.close();
    return results;
}

async function soak(browser, env) {
    const { context, page, cdp } = await newPage(browser);
    await openApp(page, env);
    await quiet(page, 1500);
    const r = rng(23);
    const samples = [];
    const cycles = SCALE === "ci" ? 6 : 12;
    for (let c = 0; c <= cycles; c++) {
        if (c > 0) {
            for (let i = 0; i < 10; i++) await selectById(page, r.pick(env.manifest.ordinaryConversations));
            await page.click("[data-nav=projects]");
            await settled(page, () => !window.__perfClient.state.trackerLoading);
            await page.click("[data-nav=decisions]");
            await settled(page, () => !window.__perfClient.state.trackerLoading);
            await page.click("[data-nav=conversations]");
            await quiet(page, 300);
        }
        const mem = await heapAfterGc(cdp);
        samples.push(mem);
    }
    await context.close();
    const first = samples[1] ?? samples[0];
    const last = samples.at(-1);
    return {
        cycles,
        heapStartMB: MB(samples[0].heap),
        heapAfterFirstCycleMB: MB(first.heap),
        heapEndMB: MB(last.heap),
        heapGrowthPerCycleMB: round((last.heap - first.heap) / 1048576 / Math.max(1, cycles - 1), 2),
        domNodesEnd: last.nodes,
        listenersStart: first.listeners,
        listenersEnd: last.listeners,
    };
}

function summarise(runs) {
    const out = {};
    for (const key of Object.keys(runs[0])) {
        const values = runs.map((r) => r[key]).filter((v) => typeof v === "number");
        out[key] = round(median(values), key.endsWith("MB") ? 1 : 0);
    }
    out.runs = runs.length;
    return out;
}

// ---------------------------------------------------------------- budget

function checkBudget(result, budget) {
    const breaches = [];
    for (const [scenario, limits] of Object.entries(budget)) {
        if (scenario.startsWith("_")) continue;
        for (const [metric, limit] of Object.entries(limits)) {
            if (!result.scenarios[scenario]) continue; // not run (--only)
            const value = metric.split(".").reduce((o, k) => o?.[k], result.scenarios[scenario]);
            if (typeof value !== "number" || !Number.isFinite(value)) {
                // A renamed or unmeasured metric must not pass silently.
                breaches.push(`${scenario}.${metric} was not measured`);
                continue;
            }
            const ok = limit.min !== undefined ? value >= limit.min : value <= limit.max;
            if (!ok)
                breaches.push(
                    `${scenario}.${metric} = ${value} (budget ${limit.min !== undefined ? `>= ${limit.min}` : `<= ${limit.max}`})`,
                );
        }
    }
    return breaches;
}

// ---------------------------------------------------------------- main

async function main() {
    if (!fs.existsSync(path.join(WEBAPP, "index.html"))) throw new Error("Run `pnpm build` first");
    const scenarios = {};
    if (want("bundle")) scenarios.bundle = bundleSizes();
    const needsBrowser = ["cold", "warm", "switch", "long", "tracker", "stream", "soak"].some(want);
    if (needsBrowser) {
        const dataDir = args.data ? path.resolve(String(args.data)) : undefined;
        const manifestFile = dataDir && path.join(dataDir, "manifest.json");
        const reuse = manifestFile && fs.existsSync(manifestFile) && JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        if (reuse && reuse.scale !== SCALE) throw new Error(`${dataDir} holds a ${reuse.scale} dataset`);
        if (reuse && reuse.version !== DATASET_VERSION) {
            throw new Error(`${dataDir} holds an older dataset; remove it to seed a fresh one`);
        }
        const journal = await startJournal({ dataDir });
        // An interrupted run must not leave its journal behind.
        for (const signal of ["SIGINT", "SIGTERM"]) {
            process.once(signal, () => {
                journal.stop().finally(() => process.exit(130));
            });
        }
        let manifest = reuse;
        if (!manifest) {
            const t0 = Date.now();
            log(`seeding a ${SCALE} dataset…`);
            signIns.push(Date.now()); // the seeder signs in once, as it starts
            manifest = await seed(journal, { scale: SCALE, log });
            log(`seeded in ${round((Date.now() - t0) / 1000)}s`);
            if (manifestFile) fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
        }
        const app = await serveApp({ webDir: WEBAPP, journalUrl: journal.url });
        const sockets = new Map();
        const ownerOf = new Map();
        // One signed-in device shared by every scenario that starts already signed in.
        await signInSlot();
        const device = await login(journal, manifest.username, "perf-harness");
        const env = {
            appUrl: app.url,
            session: JSON.stringify({
                serverUrl: `${app.url}/journal`,
                token: device.token,
                deviceId: device.device_id,
                userId: device.user_id,
                username: manifest.username,
            }),
            manifest,
            password: (await import("./lib/journal.mjs")).PASSWORD,
            biggestMissionNum: manifest.biggestMission.num,
            async agentFor(convoId) {
                if (!ownerOf.size) {
                    const snap = await (
                        await fetch(`${journal.url}/snapshot`, { headers: { authorization: `Bearer ${device.token}` } })
                    ).json();
                    const names = new Map((snap.agents ?? []).map((a) => [a.id ?? a.device_id, a.name]));
                    for (const c of snap.conversations) ownerOf.set(c.id, names.get(c.agent_device_id) ?? c.box);
                }
                const name = ownerOf.get(convoId);
                const agent = manifest.agents.find((a) => a.name === name) ?? manifest.agents[0];
                if (!sockets.has(agent.name)) sockets.set(agent.name, await openSocket(journal.wsUrl, agent.token));
                return sockets.get(agent.name);
            },
        };
        const browser = await chromium.launch({ headless: !args.headed, args: ["--enable-precise-memory-info"] });
        // The harness reaches the client object for a few precise waits; the app exposes nothing
        // itself, so grab it from React's root props.
        const hook = () => {
            const find = () => {
                const root = document.getElementById("matron");
                const key = root && Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
                let fiber = key && root[key];
                const stack = fiber ? [fiber] : [];
                while (stack.length) {
                    const f = stack.pop();
                    const props = f.memoizedProps;
                    if (props?.client?.selectConversation) return props.client;
                    if (f.child) stack.push(f.child);
                    if (f.sibling) stack.push(f.sibling);
                }
                return undefined;
            };
            Object.defineProperty(window, "__perfClient", {
                configurable: true,
                get() {
                    return (window.__perfClientCache ??= find());
                },
            });
        };
        const origNewContext = browser.newContext.bind(browser);
        browser.newContext = async (opts) => {
            const ctx = await origNewContext(opts);
            await ctx.addInitScript(hook);
            return ctx;
        };
        const plan = [
            ["cold", coldLoad],
            ["warm", warmLoad],
            ["switch", switching],
            ["long", longTranscript],
            ["tracker", tracker],
            ["stream", streaming],
            ["soak", soak],
        ];
        try {
            for (const [name, fn] of plan) {
                if (!want(name)) continue;
                log(`${name}…`);
                currentScenario = name;
                const t0 = Date.now();
                scenarios[name] = await fn(browser, env);
                log(`${name} done in ${round((Date.now() - t0) / 1000)}s`, JSON.stringify(scenarios[name]));
            }
        } finally {
            await browser.close();
            for (const s of sockets.values()) s.close();
            await app.close();
            await journal.stop();
        }
        scenarios.dataset = {
            scale: manifest.scale,
            conversations: manifest.conversations,
            events: manifest.events,
            items: manifest.items,
            missions: manifest.missions,
            projects: manifest.projects,
        };
    }
    const result = {
        when: new Date().toISOString(),
        cpuThrottle: CPU,
        latencyMs: LATENCY,
        runs: RUNS,
        chromium: chromium.name(),
        scenarios,
    };
    const out = String(args.out ?? "perf-results.json");
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    printTable(scenarios);
    log(`wrote ${out}`);
    const budget = args.budget ? JSON.parse(fs.readFileSync(String(args.budget), "utf8")) : null;
    if (process.env.GITHUB_STEP_SUMMARY)
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(scenarios, budget));
    if (budget) {
        const breaches = checkBudget(result, budget);
        if (breaches.length) {
            console.error(`\nOver budget:\n  ${breaches.join("\n  ")}`);
            process.exit(1);
        }
        console.error("\nWithin budget.");
    }
}

function flatten(values, prefix = "", out = []) {
    for (const [k, v] of Object.entries(values)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
        else if (!Array.isArray(v)) out.push([key, v]);
    }
    return out;
}

function markdown(scenarios, budget) {
    const rows = ["| Scenario | Metric | Value | Budget |", "|---|---|---|---|"];
    for (const [name, values] of Object.entries(scenarios)) {
        for (const [metric, value] of flatten(values)) {
            const limit = budget?.[name]?.[metric];
            const text = limit ? (limit.min !== undefined ? `>= ${limit.min}` : `<= ${limit.max}`) : "";
            rows.push(`| ${name} | ${metric} | ${value} | ${text} |`);
        }
    }
    return `## Performance (${SCALE} dataset)\n\n${rows.join("\n")}\n`;
}

function printTable(scenarios) {
    const lines = [];
    for (const [name, values] of Object.entries(scenarios)) {
        const flat = [];
        const walk = (prefix, v) => {
            if (v && typeof v === "object" && !Array.isArray(v))
                for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}.${k}` : k, x);
            else if (!Array.isArray(v)) flat.push(`${prefix}=${v}`);
        };
        walk("", values);
        lines.push(`${name.padEnd(8)} ${flat.join("  ")}`);
    }
    console.log(lines.join("\n"));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
