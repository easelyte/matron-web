/*
Copyright 2026 Matron Contributors.
SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
*/

/* Redesign-v6 verification shots. Serves the fixtures build and captures every v6 state in
 * both themes at desktop (1280), phone (390) and a 420px chat pane (desktop viewport with a
 * wide sidebar), plus a tools/probe.js dump per state when V6_PROBE is set.
 *
 *   pnpm build:fixtures && V6_OUT=/tmp/vf/v6/after node scripts/visual/shoot-v6.mjs
 *   V6_ONLY=thread-off,card-deep-command  → a subset
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const ROOT = process.cwd();
const DIST = path.join(ROOT, ".fixtures-dist");
const OUT = process.env.V6_OUT || "/tmp/vf/v6";
const ONLY = process.env.V6_ONLY ? new Set(process.env.V6_ONLY.split(",")) : null;
const PROBE = process.env.V6_PROBE ? fs.readFileSync(process.env.V6_PROBE, "utf8") : null;
const MAP = process.env.V6_MAP ? fs.readFileSync(process.env.V6_MAP, "utf8") : null;
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".json": "application/json",
};

function serve(dir) {
    const root = path.resolve(dir);
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let urlPath;
            try {
                urlPath = decodeURIComponent(req.url.split("?")[0]);
            } catch {
                res.writeHead(400);
                res.end();
                return;
            }
            const file = path.resolve(root, urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, ""));
            if (file !== root && !file.startsWith(root + path.sep)) {
                res.writeHead(403);
                res.end();
                return;
            }
            fs.readFile(file, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
                res.end(data);
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
}

const openCard = async (page) => page.locator(".mj_TurnCard_toggle").last().click();
const openGroup = (text) => async (page) => {
    await openCard(page);
    await page.locator(".mj_TurnCard_groupRow", { hasText: text }).last().click();
};

// { name, query, viewport: "desktop" | "phone" | "narrow" | "tall", setup?, clip? }
const STATES = [
    { name: "thread-off", query: "v6=full", viewport: "tall" },
    { name: "thread-on", query: "v6=full&work=on", viewport: "tall" },
    { name: "thread-off", query: "v6=full", viewport: "desktop" },
    { name: "thread-on", query: "v6=full&work=on", viewport: "desktop" },
    { name: "thread-off", query: "v6=full", viewport: "phone" },
    { name: "card-collapsed-done", query: "v6=t1", viewport: "desktop", clip: ".mj_AgentTurn" },
    { name: "card-expanded-done", query: "v6=t1", viewport: "desktop", clip: ".mj_AgentTurn", setup: openCard },
    {
        name: "card-group-open",
        query: "v6=t1",
        viewport: "desktop",
        clip: ".mj_AgentTurn",
        setup: openGroup("Looked through"),
    },
    {
        name: "card-deep-command",
        query: "v6=t1",
        viewport: "desktop",
        clip: ".mj_AgentTurn",
        setup: async (page) => {
            await openGroup("Checked the types")(page);
            await page.locator(".mj_TurnCard_step").first().click();
        },
    },
    {
        name: "card-deep-diff",
        query: "v6=t1",
        viewport: "desktop",
        clip: ".mj_AgentTurn",
        setup: async (page) => {
            await openCard(page);
            await page.locator(".mj_TurnCard_file").first().click();
        },
    },
    { name: "card-collapsed-running", query: "v6=run", viewport: "desktop", clip: ".mj_AgentTurn >> nth=-1" },
    {
        name: "card-expanded-running",
        query: "v6=run",
        viewport: "desktop",
        clip: ".mj_AgentTurn >> nth=-1",
        setup: openCard,
    },
    { name: "card-slow", query: "v6=slow", viewport: "desktop", clip: ".mj_AgentTurn >> nth=-1", slow: true },
    { name: "card-waiting", query: "v6=wait", viewport: "desktop", clip: ".mj_AgentTurn >> nth=-1" },
    { name: "card-turn-error", query: "v6=t5", viewport: "desktop" },
    {
        name: "card-210",
        query: "v6=t210",
        viewport: "tall",
        clip: ".mj_AgentTurn",
        setup: async (page) => {
            await openGroup("Looked through")(page);
            await page.locator(".mj_TurnCard_more", { hasText: "Show all" }).first().click();
        },
    },
    { name: "narrow-collapsed", query: "v6=run", viewport: "narrow" },
    { name: "narrow-expanded", query: "v6=t1", viewport: "narrow", setup: openGroup("Checked the types") },
    {
        name: "narrow-deep",
        query: "v6=t1",
        viewport: "narrow",
        setup: async (page) => {
            await openGroup("Checked the types")(page);
            await page.locator(".mj_TurnCard_step").first().click();
        },
    },
];

STATES.push(
    {
        name: "settings-off",
        query: "v6=t1",
        viewport: "desktop",
        setup: async (page) => page.locator('button[aria-label="Settings"]').click(),
    },
    {
        name: "settings-on",
        query: "v6=t1&work=on",
        viewport: "desktop",
        setup: async (page) => page.locator('button[aria-label="Settings"]').click(),
    },
    {
        name: "settings-sheet",
        query: "v6=t1",
        viewport: "phone",
        stayOnList: true,
        setup: async (page) => {
            const back = page.locator('button[aria-label="Back to conversations"]');
            if (await back.isVisible()) await back.click();
            await page.locator('button[aria-label="Settings"]').click();
        },
    },
);

const VIEWPORTS = {
    desktop: { width: 1280, height: 900 },
    tall: { width: 1280, height: 2600 },
    phone: { width: 390, height: 844 },
    narrow: { width: 840, height: 900 },
};

const { server, port } = await serve(DIST);
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();
const written = [];
const probes = {};
for (const theme of ["light", "dark"]) {
    for (const spec of STATES) {
        if (ONLY && !ONLY.has(spec.name)) continue;
        const context = await browser.newContext({ viewport: VIEWPORTS[spec.viewport] });
        const page = await context.newPage();
        if (spec.slow) await page.clock.install();
        if (spec.viewport === "narrow") {
            await page.addInitScript(() => localStorage.setItem("mx_lhs_size", "420"));
        }
        try {
            await page.goto(`${base}?theme=${theme}&${spec.query}`, { waitUntil: "networkidle" });
            await page.evaluate(() => document.fonts.ready);
            if (spec.slow) await page.clock.fastForward(305_000);
            if (spec.setup) await spec.setup(page);
            await page.mouse.move(0, 0);
            await page.waitForTimeout(400);
            if (spec.viewport === "phone" && !spec.stayOnList) {
                // Phone layout opens on the conversation list; tap into the selected thread.
                const row = page.locator(".mj_RoomListItem").first();
                if (await row.count()) await row.click().catch(() => {});
                await page.waitForTimeout(300);
            }
            await page.evaluate(() => {
                const panel = document.querySelector(".mx_RoomView_messagePanel");
                const open = document.querySelector(".mj_TurnCard_deep, .mj_TurnCard.is-open");
                if (panel && open) open.scrollIntoView({ block: "center" });
            });
            const file = path.join(OUT, `${spec.name}__${theme}__${spec.viewport}.png`);
            if (spec.clip && process.env.V6_CLIP) {
                await page.locator(spec.clip).first().screenshot({ path: file, animations: "disabled" });
            } else {
                await page.screenshot({ path: file, animations: "disabled" });
            }
            written.push(file);
            if (PROBE && MAP) {
                const result = await page.evaluate(
                    ([probe, map]) => {
                        window.MAP = JSON.parse(map);
                        // eslint-disable-next-line no-new-func
                        return new Function(`return ${probe.trim().replace(/;\s*$/, "")}`)();
                    },
                    [PROBE, MAP],
                );
                probes[`${spec.name}__${theme}__${spec.viewport}`] = result;
            }
        } catch (error) {
            console.log(`ERR ${spec.name} @ ${theme}: ${error.message.split("\n")[0]}`);
        }
        await context.close();
    }
}
await browser.close();
server.close();
if (PROBE && MAP) fs.writeFileSync(path.join(OUT, "probe-live.json"), JSON.stringify(probes, null, 2));
console.log(`WROTE ${written.length} shots → ${OUT}`);
