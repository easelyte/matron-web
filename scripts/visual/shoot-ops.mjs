/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Ops-page visual driver, modelled on shoot-work.mjs. Serves the fixtures
 * build (.fixtures-dist) and shoots the Ops pane through the REAL components at phone / tablet /
 * desktop widths in both themes: healthy, problems, expanded disclosures + chart hover, an old
 * bridge (needs update), two boxes (switch + asleep), loading and empty. Viewports are tall so the
 * whole internally-scrolling pane is in frame. Every shot is audited for horizontal overflow and
 * phone tap targets; then one contact sheet per scene ([390 | 768 | 1280] x [light | dark]).
 *
 * Run:  node scripts/visual/shoot-ops.mjs [outDir]   (after `pnpm build:fixtures`)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const ROOT = process.cwd();
const DIST = path.join(ROOT, ".fixtures-dist");
const OUT = path.resolve(process.argv[2] ?? "/tmp/vf/ops");
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

const open = (mode) => (p) => p.evaluate((m) => window.__matron.openOps(m), mode);
const SCENES = [
    { name: "ok", setup: open("ok") },
    { name: "problems", setup: open("problems") },
    {
        // Real clicks on the real disclosures and the timer filter.
        name: "expanded",
        setup: async (p) => {
            await open("problems")(p);
            await settle(p);
            await p.getByRole("tab", { name: /^All/ }).click();
            await p.getByRole("button", { name: /Resolved in the last day/ }).click();
            await p.getByRole("button", { name: /Cron jobs/ }).click();
            await p.locator(".mj_OpsChart_bar").nth(10).hover();
        },
    },
    { name: "old-bridge", setup: open("old-bridge") },
    { name: "two-boxes", setup: open("two-boxes") },
    { name: "loading", setup: open("loading") },
    { name: "empty", setup: open("empty") },
];

const VIEWPORTS = [
    // Tall viewports: the pane scrolls internally, so the whole page is captured by height.
    { w: 390, h: 4400, phone: true },
    { w: 768, h: 3000, phone: false },
    { w: 1280, h: 2300, phone: false },
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
                    const pane = document.querySelector(".mj_OpsPane");
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
                                    el.getAttribute("aria-label") ||
                                    el.textContent?.trim().slice(0, 24) ||
                                    el.className;
                                small.push(`${label} ${Math.round(r.width)}x${Math.round(r.height)}`);
                            } else if (r.height < 36) {
                                const label =
                                    el.getAttribute("aria-label") ||
                                    el.textContent?.trim().slice(0, 24) ||
                                    el.className;
                                small.push(`${label} ${Math.round(r.width)}x${Math.round(r.height)}`);
                            }
                        }
                    }
                    const paneOverflow = pane
                        ? [...pane.querySelectorAll("*")].some(
                              (el) =>
                                  el.scrollWidth > el.clientWidth + 1 &&
                                  getComputedStyle(el).overflowX === "visible" &&
                                  el.getBoundingClientRect().right > innerWidth + 1,
                          )
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
const TILE_H = 1400;
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
