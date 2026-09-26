/*
Copyright 2026 Matron Contributors.
SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
*/

/* Redesign-v6 auto-diff (HANDOFF §3 step 9). Runs docs/design/redesign-v6/tools/probe.js on
 * the design prototype (design mode, [data-spec]) and on the live fixtures build (live mode,
 * window.MAP = component-map.json), then compares each spec's compare-props within the map's
 * tolerances. Writes probe-design.json, probe-live.json and diff.json to V6_OUT.
 *
 *   pnpm build:fixtures && V6_OUT=/tmp/vf/v6/probe node scripts/visual/probe-v6.mjs
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const ROOT = process.cwd();
const DESIGN = path.join(ROOT, "docs/design/redesign-v6");
const DIST = path.join(ROOT, ".fixtures-dist");
const OUT = process.env.V6_OUT || "/tmp/vf/v6/probe";
fs.mkdirSync(OUT, { recursive: true });
const PROBE = fs.readFileSync(path.join(DESIGN, "tools/probe.js"), "utf8");
const MAP = JSON.parse(fs.readFileSync(path.join(DESIGN, "component-map.json"), "utf8"));

const MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".json": "application/json",
};
function serve(dir) {
    const root = path.resolve(dir);
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]).replace(/^\/+/, "") || "index.html";
            const file = path.resolve(root, rel);
            if (!file.startsWith(root)) return res.writeHead(403).end();
            fs.readFile(file, (err, data) => {
                if (err) return res.writeHead(404).end();
                res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
                res.end(data);
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
}

// design preset → how to reach the same state on the live fixtures build
const openCard = async (page) => page.locator(".mj_TurnCard_toggle").last().click();
const openGroup = (text) => async (page) => {
    await openCard(page);
    await page.locator(".mj_TurnCard_groupRow", { hasText: text }).last().click();
};
const PAIRS = [
    ["card-collapsed-done", "v6=t1"],
    ["card-expanded-done", "v6=t1", openCard],
    ["card-group-open", "v6=t1", openGroup("Looked through")],
    [
        "card-deep-command",
        "v6=t1",
        async (page) => {
            await openGroup("Checked the types")(page);
            await page.locator(".mj_TurnCard_step").first().click();
        },
    ],
    [
        "card-deep-diff",
        "v6=t1",
        async (page) => {
            await openCard(page);
            await page.locator(".mj_TurnCard_file").first().click();
        },
    ],
    ["card-collapsed-running", "v6=run"],
    ["card-waiting", "v6=wait"],
    ["card-turn-error", "v6=t5"],
    ["thread-off", "v6=full"],
    ["settings-on", "v6=t1&work=on", async (page) => page.locator('button[aria-label="Settings"]').click()],
    ["browser-idle", "v6=t1", async (page) => page.locator('button[aria-label="Conversation actions"]').click()],
    [
        "browser-confirm-busy",
        "v6=run",
        async (page) => {
            await page.locator('button[aria-label="Conversation actions"]').click();
            await page.locator(".mj_RoomItemMenu_item", { hasText: "Enable browser tools" }).click();
        },
    ],
    ["browser-queued", "v6=run&browser=queued"],
    ["split-idle", "v6=t1"],
    ["sheet-default", "v6=t1", async (page) => page.locator('button[aria-label="New session options"]').click()],
];

const runProbe = async (page, live) =>
    page.evaluate(
        ([probe, map, isLive]) => {
            window.MAP = isLive ? map : undefined;
            if (!isLive) delete window.MAP;
            // The probe is an IIFE expression statement: indirect eval returns its value.
            return (0, eval)(probe);
        },
        [PROBE, MAP, live],
    );

const design = await serve(DESIGN);
const live = await serve(DIST);
const browser = await chromium.launch();
const designOut = {};
const liveOut = {};
for (const theme of ["light", "dark"]) {
    for (const [preset, query, setup] of PAIRS) {
        const key = `${preset}__${theme}`;
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        try {
            await page.goto(
                `http://127.0.0.1:${design.port}/Matron%20Redesign%20v6.html#state=${preset}&theme=${theme}`,
            );
            await page.waitForTimeout(500);
            designOut[key] = await runProbe(page, false);
        } catch (error) {
            designOut[key] = { error: error.message.split("\n")[0] };
        }
        await page.close();
        const livePage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        try {
            await livePage.goto(`http://127.0.0.1:${live.port}/?theme=${theme}&${query}`, { waitUntil: "networkidle" });
            await livePage.evaluate(() => document.fonts.ready);
            if (setup) await setup(livePage);
            await livePage.waitForTimeout(400);
            liveOut[key] = await runProbe(livePage, true);
        } catch (error) {
            liveOut[key] = { error: error.message.split("\n")[0] };
        }
        await livePage.close();
    }
}
await browser.close();
design.server.close();
live.server.close();

// ---- diff: per spec, first design specimen vs the live map selector, on the compare props ----
const PX = (value) => (typeof value === "string" && /^-?[\d.]+px$/.test(value) ? parseFloat(value) : null);
const equalWithin = (a, b, tolerance) => {
    if (a === b) return true;
    const pa = String(a ?? "").split(/\s+/);
    const pb = String(b ?? "").split(/\s+/);
    if (pa.length !== pb.length) return false;
    return pa.every((part, index) => {
        const x = PX(part);
        const y = PX(pb[index]);
        return x !== null && y !== null ? Math.abs(x - y) <= tolerance : part === pb[index];
    });
};
const diff = {};
let compared = 0;
let matched = 0;
for (const key of Object.keys(liveOut)) {
    const liveSpecimens = liveOut[key]?.specimens ?? [];
    const designSpecimens = designOut[key]?.specimens ?? [];
    for (const entry of liveSpecimens) {
        if (!entry.found) continue;
        const counterpart = designSpecimens.find((specimen) => specimen.spec === entry.spec);
        if (!counterpart) continue;
        const component = MAP.components.find((candidate) => candidate.spec === entry.spec);
        const tolerance = component?.tolerance?.px ?? MAP.defaults.tolerance.px;
        const props = entry.compare ?? MAP.defaults.compare;
        const deltas = {};
        for (const prop of props) {
            const want = counterpart.computed?.[prop];
            const got = entry.computed?.[prop];
            compared += 1;
            if (equalWithin(want, got, tolerance)) matched += 1;
            else deltas[prop] = { design: want ?? null, live: got ?? null };
        }
        if (Object.keys(deltas).length) (diff[key] ??= {})[entry.spec] = deltas;
    }
}
fs.writeFileSync(path.join(OUT, "probe-design.json"), JSON.stringify(designOut, null, 2));
fs.writeFileSync(path.join(OUT, "probe-live.json"), JSON.stringify(liveOut, null, 2));
fs.writeFileSync(path.join(OUT, "diff.json"), JSON.stringify({ compared, matched, deltas: diff }, null, 2));
console.log(`compared ${compared} props, ${matched} within tolerance → ${OUT}`);
