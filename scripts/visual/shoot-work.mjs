/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Work-tab visual driver. Serves the fixtures build (.fixtures-dist) and shoots the Work surface
 * through the REAL components at phone / tablet / desktop widths in both themes: the list, a
 * filtered list, the loop detail (structured description + next step), the detail against an
 * older server (no optional fields), a missing loop, and the empty / error / loading states.
 * Phone shots use touch emulation, and every shot is audited for horizontal overflow and for
 * visible tap targets under 44px (phone only). Then it tiles one contact sheet per scene
 * ([390 | 768 | 1280] x [light | dark]).
 *
 * Run:  node scripts/visual/shoot-work.mjs [outDir]   (after `pnpm build:fixtures`)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const ROOT = process.cwd();
const DIST = path.join(ROOT, ".fixtures-dist");
const OUT = path.resolve(process.argv[2] ?? "/tmp/vf/work");
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".json": "application/json",
};

function serve(dir) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const urlPath = decodeURIComponent(req.url.split("?")[0]);
            const file = path.join(dir, urlPath === "/" ? "index.html" : urlPath);
            fs.readFile(file, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end("not found");
                    return;
                }
                res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
                res.end(data);
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
}

const settle = (p) => p.waitForTimeout(350);

const SCENES = [
    { name: "list", setup: (p) => p.evaluate(() => window.__matron.openWork("ok")) },
    {
        name: "list-all-by-domain",
        setup: async (p) => {
            await p.evaluate(() => window.__matron.openWork("ok"));
            await settle(p);
            await p.selectOption('select[aria-label="Status"]', "all");
            await p.getByRole("tab", { name: "Domain" }).click();
        },
    },
    {
        name: "list-search",
        setup: async (p) => {
            await p.evaluate(() => window.__matron.openWork("ok"));
            await settle(p);
            await p.fill('input[aria-label="Search work"]', "permission");
        },
    },
    {
        name: "list-no-match",
        setup: async (p) => {
            await p.evaluate(() => window.__matron.openWork("ok"));
            await settle(p);
            await p.fill('input[aria-label="Search work"]', "nothing like this");
        },
    },
    {
        // Real tap on a real row, not a store patch, so a broken row target shows up here.
        name: "detail",
        setup: async (p) => {
            await p.evaluate(() => window.__matron.openWork("ok"));
            await settle(p);
            await p.locator('.mj_WorkRow[data-loop-id="108"]').click();
        },
    },
    { name: "detail-blocked", setup: (p) => p.evaluate(() => window.__matron.openWorkLoop(102)) },
    { name: "detail-legacy-server", setup: (p) => p.evaluate(() => window.__matron.openWorkLoop(108, "legacy")) },
    { name: "detail-no-description", setup: (p) => p.evaluate(() => window.__matron.openWorkLoop(106)) },
    { name: "detail-missing", setup: (p) => p.evaluate(() => window.__matron.openWorkLoop(999)) },
    { name: "empty", setup: (p) => p.evaluate(() => window.__matron.openWork("empty")) },
    { name: "error", setup: (p) => p.evaluate(() => window.__matron.openWork("error")) },
    { name: "loading", setup: (p) => p.evaluate(() => window.__matron.openWork("loading")) },
];

const VIEWPORTS = [
    { w: 390, h: 844, phone: true },
    { w: 768, h: 1024, phone: false },
    { w: 1280, h: 860, phone: false },
];
const THEMES = ["light", "dark"];

const { server, port } = await serve(DIST);
const browser = await chromium.launch();
const report = [];
try {
    for (const vp of VIEWPORTS) {
        const context = await browser.newContext({
            viewport: { width: vp.w, height: vp.h },
            deviceScaleFactor: 1,
            isMobile: vp.phone,
            hasTouch: vp.phone,
        });
        for (const theme of THEMES) {
            for (const scene of SCENES) {
                const page = await context.newPage();
                await page.goto(`http://127.0.0.1:${port}/?theme=${theme}`);
                await page.waitForSelector(".mx_MatrixChat");
                let error = null;
                try {
                    await scene.setup(page);
                } catch (e) {
                    error = String(e).split("\n")[0];
                }
                await settle(page);
                const file = path.join(OUT, `${scene.name}-${vp.w}-${theme}.png`);
                await page.screenshot({ path: file });
                const audit = await page.evaluate((phone) => {
                    const doc = document.scrollingElement;
                    const pane = document.querySelector(".mj_TrackerPane");
                    const small = [];
                    if (phone && pane) {
                        for (const el of pane.querySelectorAll("button, a[href], [role=tab], input, select")) {
                            const r = el.getBoundingClientRect();
                            if (!r.width || !r.height) continue;
                            if (r.bottom < 0 || r.top > innerHeight) continue;
                            // Inline prose links are text, not controls; the 44px rule is for controls.
                            if (el.closest(".mj_TrackerProse")) continue;
                            if (r.height < 44 && r.width < 44) {
                                const label =
                                    el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || el.className;
                                small.push(`${label} ${Math.round(r.width)}x${Math.round(r.height)}`);
                            } else if (r.height < 36) {
                                const label =
                                    el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || el.className;
                                small.push(`${label} ${Math.round(r.width)}x${Math.round(r.height)}`);
                            }
                        }
                    }
                    const paneOverflow = pane
                        ? [...pane.querySelectorAll("*")].some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible" && el.getBoundingClientRect().right > innerWidth + 1)
                        : false;
                    return {
                        hOverflow: doc.scrollWidth > innerWidth ? doc.scrollWidth - innerWidth : 0,
                        paneOverflow,
                        smallTargets: small,
                    };
                }, vp.phone);
                report.push({ scene: scene.name, width: vp.w, theme, error, file, ...audit });
                await page.close();
            }
        }
        await context.close();
    }
} finally {
    await browser.close();
    server.close();
}

// One contact sheet per scene: columns = widths, rows = themes, each tile scaled to a common height.
const TILE_H = 700;
const GAP = 16;
for (const scene of SCENES) {
    const rows = [];
    for (const theme of THEMES) {
        const tiles = [];
        for (const vp of VIEWPORTS) {
            const file = path.join(OUT, `${scene.name}-${vp.w}-${theme}.png`);
            const buffer = await sharp(file).resize({ height: TILE_H }).png().toBuffer();
            const meta = await sharp(buffer).metadata();
            tiles.push({ buffer, width: meta.width });
        }
        rows.push(tiles);
    }
    const width = Math.max(...rows.map((tiles) => tiles.reduce((sum, tile) => sum + tile.width + GAP, GAP)));
    const height = rows.length * (TILE_H + GAP) + GAP;
    const composite = [];
    rows.forEach((tiles, rowIndex) => {
        let left = GAP;
        for (const tile of tiles) {
            composite.push({ input: tile.buffer, left, top: GAP + rowIndex * (TILE_H + GAP) });
            left += tile.width + GAP;
        }
    });
    await sharp({ create: { width, height, channels: 3, background: "#7f7f7f" } })
        .composite(composite)
        .png()
        .toFile(path.join(OUT, `sheet-${scene.name}.png`));
}

fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
for (const row of report) {
    const issues = [
        row.hOverflow ? `overflow=${row.hOverflow}` : "",
        row.paneOverflow ? "pane-overflow" : "",
        row.smallTargets.length ? `small=${row.smallTargets.join("; ")}` : "",
        row.error ? `ERROR ${row.error}` : "",
    ].filter(Boolean);
    console.log(`${row.scene} ${row.width} ${row.theme}: ${issues.length ? issues.join(" ") : "ok"}`);
}
