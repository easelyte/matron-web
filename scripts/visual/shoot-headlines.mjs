/*
Copyright 2026 Matron Contributors.
SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
*/

/* Helper-thread headlines (2026-09-26): verification shots and contact sheets of REAL helper
 * threads, replayed from the scrubbed corpus sample (`?sub=real-claude|real-tests|real-codex`),
 * plus the sidebar. 1280 and 390, light and dark, Developer view off and on; one contact sheet
 * per state: rows = widths, columns = light-off · dark-off · light-on · dark-on.
 *
 *   pnpm build:fixtures && SUB_OUT=/tmp/vf/hl/after node scripts/visual/shoot-headlines.mjs
 *   FIX_DIST=/other/tree/.fixtures-dist → shoot another build (the "before" tree)
 *   SUB_ONLY=sidebar,real-claude → a subset
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const ROOT = process.cwd();
const DIST = process.env.FIX_DIST || path.join(ROOT, ".fixtures-dist");
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

const WIDTHS = {
    1280: { width: 1280, height: 900 },
    390: { width: 390, height: 844 },
};

// Open the first grouped headline ("Ran 4 commands"), after "Show all" when it is folded away.
const openCommands = async (page) => {
    const more = page.locator(".mj_Headlines_more").first();
    if (await more.count()) await more.click();
    const row = page.locator(".mj_Headline_row", { hasText: /Ran \d+ commands/ }).first();
    if (await row.count()) await row.click();
};
// Before: the turn card's first group.
const openCardGroup = async (page) => {
    const toggle = page.locator("section.mj_TurnCard > .mj_TurnCard_row .mj_TurnCard_toggle").first();
    if (await toggle.count()) await toggle.click();
};

// { name, query, list?: phone stays on the conversation list, setup?, scrollTo? }
const STATES = [
    { name: "sidebar", query: "sub=real-claude", list: true },
    { name: "real-claude", query: "sub=real-claude" },
    {
        name: "real-claude-open",
        query: "sub=real-claude",
        setup: async (p) => (await openCommands(p), await openCardGroup(p)),
        scrollTo: ".mj_Headline.is-open, .mj_TurnCard_group.is-open",
    },
    { name: "real-tests", query: "sub=real-tests", scrollTo: ".mj_Headlines, .mj_TurnCard, .mj_EventTile" },
    { name: "real-codex", query: "sub=real-codex", scrollTo: ".mj_Headlines, .mj_TurnCard, .mj_EventTile" },
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
                        // A helper opens under its parent: back to the parent, then to the list.
                        for (let hop = 0; hop < 3; hop += 1) {
                            const back = page
                                .locator("header button, .mj_BackButton")
                                .filter({ visible: true })
                                .first();
                            if (!(await back.count())) break;
                            const box = await back.boundingBox();
                            if (!box || box.x > 60) break;
                            await back.click();
                            await page.waitForTimeout(400);
                        }
                    }
                    if (spec.setup) await spec.setup(page);
                    await page.mouse.move(0, 0);
                    await page.waitForTimeout(400);
                    if (spec.scrollTo) {
                        await page.evaluate(
                            (sel) => document.querySelector(sel)?.scrollIntoView({ block: "start" }),
                            spec.scrollTo,
                        );
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
