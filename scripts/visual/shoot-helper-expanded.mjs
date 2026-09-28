/*
Copyright 2026 Matron Contributors.
SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
*/

/* Helper thread opens expanded (2026-09-28): before/after shots of a helper's own thread with
 * Developer view off, plus a DOM-weight probe on the long many-turn thread.
 *
 * Serves the fixtures build (`?sub=real-tests|real-codex|real-claude|real-long`) and captures
 * each at 1280 and 390, light and dark. Writes shots/<state>__<width>__<theme>.png (thread
 * bottom) and ...__headlines.png (newest turn's headlines at the top), and
 * metrics.json (element count, open step rows, headline rows) per state at 1280.
 *
 *   pnpm build:fixtures && HX_OUT=/tmp/vf/hx/after node scripts/visual/shoot-helper-expanded.mjs
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const DIST = path.join(process.cwd(), ".fixtures-dist");
const OUT = process.env.HX_OUT || "/tmp/vf/hx";
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
    const urlPath = req.url.split("?")[0];
    const file = path.resolve(DIST, urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, ""));
    if (!file.startsWith(DIST)) {
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
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const WIDTHS = { 1280: { width: 1280, height: 900 }, 390: { width: 390, height: 844 } };
const STATES = ["real-tests", "real-codex", "real-claude", "real-long"];

const browser = await chromium.launch();
const metrics = {};
for (const state of STATES) {
    for (const [w, viewport] of Object.entries(WIDTHS)) {
        for (const theme of ["light", "dark"]) {
            const context = await browser.newContext({ viewport });
            const page = await context.newPage();
            await page.clock.install({ time: Date.UTC(2026, 8, 26, 14, 18, 0) });
            await page.goto(`${base}?theme=${theme}&sub=${state}`, { waitUntil: "networkidle" });
            await page.evaluate(() => document.fonts.ready);
            await page.waitForTimeout(300);
            if (w === "390") {
                const selected = page.locator(".mj_RoomListItem_selected").first();
                if (await selected.count()) await selected.click().catch(() => {});
                await page.waitForTimeout(300);
            }
            await page.mouse.move(0, 0);
            await page.waitForTimeout(300);
            if (w === "1280" && theme === "light") {
                metrics[state] = await page.evaluate(() => ({
                    elements: document.querySelectorAll("*").length,
                    timelineElements: document.querySelectorAll(".mj_AgentTurn *").length,
                    turns: document.querySelectorAll(".mj_AgentTurn_helper").length,
                    headlineRows: document.querySelectorAll(".mj_Headline_row").length,
                    openGroups: document.querySelectorAll(".mj_Headline.is-open").length,
                    stepRows: document.querySelectorAll(".mj_Headlines .mj_TurnCard_step").length,
                }));
            }
            const file = path.join(SHOTS, `${state}__${w}__${theme}.png`);
            await page.screenshot({ path: file, animations: "disabled" });
            // The newest turn's headlines at the top of the viewport (the change itself).
            await page.evaluate(() => [...document.querySelectorAll(".mj_Headlines")].at(-1)?.scrollIntoView());
            await page.waitForTimeout(150);
            await page.screenshot({ path: file.replace(/\.png$/, "__headlines.png"), animations: "disabled" });
            await context.close();
        }
    }
}
await browser.close();
server.close();
fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics));
