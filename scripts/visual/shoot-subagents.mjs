/*
Copyright 2026 Matron Contributors.
SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
*/

/* Subagent cards + sidebar child rows: verification shots and contact sheets.
 *
 * Serves the fixtures build (`?sub=thread|child|codex`) and captures each state at 1280 / 768 /
 * 390, light and dark, Developer view off and on, then tiles one contact sheet per state:
 * rows = widths, columns = light-off · dark-off · light-on · dark-on.
 *
 *   pnpm build:fixtures && SUB_OUT=/tmp/vf/sub/after node scripts/visual/shoot-subagents.mjs
 *   SUB_ONLY=sidebar,thread → a subset
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const ROOT = process.cwd();
const DIST = path.join(ROOT, ".fixtures-dist");
const OUT = process.env.SUB_OUT || "/tmp/vf/sub";
const ONLY = process.env.SUB_ONLY ? new Set(process.env.SUB_ONLY.split(",")) : null;
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

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

const WIDTHS = { 1280: { width: 1280, height: 900 }, 768: { width: 768, height: 1024 }, 390: { width: 390, height: 844 } };

// Open the first subagent card (after), tolerating its absence (before).
const openFirstCard = async (page) => {
    const toggle = page.locator(".mj_SubagentCard_toggle").first();
    if (await toggle.count()) await toggle.click();
};
const openCardSteps = async (page) => {
    await openFirstCard(page);
    const group = page.locator(".mj_SubagentCard .mj_TurnCard_groupRow").first();
    if (await group.count()) await group.click();
};
const openTurnHelper = async (page) => {
    const toggle = page.locator(".mj_TurnCard_toggle").last();
    if (await toggle.count()) await toggle.click();
    const helper = page.locator(".mj_TurnCard_groupRow", { hasText: /helper/i }).last();
    if (await helper.count()) {
        await helper.click();
        const step = page.locator(".mj_TurnCard_step").first();
        if (await step.count()) await step.click();
    }
};

// { name, query, list?: phone stays on the conversation list, setup?, scrollTo? }
const STATES = [
    { name: "sidebar", query: "sub=thread", list: true },
    { name: "thread", query: "sub=thread" },
    { name: "thread-card-open", query: "sub=thread", setup: openFirstCard, scrollTo: ".mj_SubagentCard.is-open" },
    { name: "thread-card-steps", query: "sub=thread", setup: openCardSteps, scrollTo: ".mj_SubagentCard.is-open" },
    { name: "thread-helper-deep", query: "sub=thread", setup: openTurnHelper, scrollTo: ".mj_TurnCard.is-open" },
    { name: "child", query: "sub=child" },
    { name: "codex", query: "sub=codex" },
];

const { server, port } = await serve(DIST);
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();
const written = [];
for (const spec of STATES) {
    if (ONLY && !ONLY.has(spec.name)) continue;
    for (const [w, viewport] of Object.entries(WIDTHS)) {
        for (const dev of ["off", "on"]) {
            for (const theme of ["light", "dark"]) {
                const context = await browser.newContext({ viewport });
                const page = await context.newPage();
                await page.clock.install({ time: Date.UTC(2026, 8, 26, 14, 18, 0) });
                try {
                    const work = dev === "on" ? "&work=on" : "";
                    await page.goto(`${base}?theme=${theme}&${spec.query}${work}`, { waitUntil: "networkidle" });
                    await page.evaluate(() => document.fonts.ready);
                    await page.waitForTimeout(300);
                    if (w === "390" && !spec.list) {
                        // Phone opens on the list: tap into the selected conversation.
                        const selected = page.locator(".mj_RoomListItem_selected").first();
                        if (await selected.count()) await selected.click().catch(() => {});
                        await page.waitForTimeout(300);
                    }
                    if (w === "390" && spec.list) {
                        const back = page.locator('button[aria-label="Back to conversations"]');
                        if (await back.isVisible().catch(() => false)) await back.click();
                    }
                    if (spec.setup) await spec.setup(page);
                    await page.mouse.move(0, 0);
                    await page.waitForTimeout(400);
                    if (spec.scrollTo) {
                        await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), spec.scrollTo);
                        await page.waitForTimeout(150);
                    }
                    const file = path.join(SHOTS, `${spec.name}__${w}__${dev}__${theme}.png`);
                    await page.screenshot({ path: file, animations: "disabled" });
                    written.push(file);
                } catch (error) {
                    console.log(`ERR ${spec.name} ${w} ${dev} ${theme}: ${error.message.split("\n")[0]}`);
                }
                await context.close();
            }
        }
    }
}
await browser.close();
server.close();

// Contact sheets: one per state. Rows = widths; columns = light-off, dark-off, light-on, dark-on.
const COLS = [
    ["off", "light"],
    ["off", "dark"],
    ["on", "light"],
    ["on", "dark"],
];
const SCALE = 0.5;
const GAP = 12;
const LABEL_H = 28;
const label = (text, width) =>
    Buffer.from(
        `<svg width="${width}" height="${LABEL_H}"><rect width="100%" height="100%" fill="#222"/><text x="8" y="19" font-family="sans-serif" font-size="14" fill="#fff">${text}</text></svg>`,
    );
for (const spec of STATES) {
    if (ONLY && !ONLY.has(spec.name)) continue;
    const rows = [];
    for (const w of Object.keys(WIDTHS)) {
        const tiles = [];
        for (const [dev, theme] of COLS) {
            const file = path.join(SHOTS, `${spec.name}__${w}__${dev}__${theme}.png`);
            if (!fs.existsSync(file)) continue;
            const meta = await sharp(file).metadata();
            const width = Math.round(meta.width * SCALE);
            const height = Math.round(meta.height * SCALE);
            const img = await sharp(file).resize(width, height).png().toBuffer();
            tiles.push({ img, width, height, text: `${w}px · dev ${dev} · ${theme}` });
        }
        if (tiles.length) rows.push(tiles);
    }
    if (!rows.length) continue;
    const sheetWidth = Math.max(...rows.map((tiles) => tiles.reduce((sum, t) => sum + t.width + GAP, GAP)));
    const rowHeights = rows.map((tiles) => Math.max(...tiles.map((t) => t.height)) + LABEL_H + GAP);
    const sheetHeight = rowHeights.reduce((a, b) => a + b, GAP);
    const composites = [];
    let y = GAP;
    rows.forEach((tiles, index) => {
        let x = GAP;
        for (const tile of tiles) {
            composites.push({ input: label(tile.text, tile.width), left: x, top: y });
            composites.push({ input: tile.img, left: x, top: y + LABEL_H });
            x += tile.width + GAP;
        }
        y += rowHeights[index];
    });
    const out = path.join(OUT, `sheet-${spec.name}.png`);
    await sharp({ create: { width: sheetWidth, height: sheetHeight, channels: 3, background: "#888" } })
        .composite(composites)
        .png()
        .toFile(out);
    written.push(out);
}
console.log(`WROTE ${written.length} files → ${OUT}`);
