/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Search-field visual driver. Serves the fixtures build (.fixtures-dist) and shoots every search
 * field in the app (sidebar session search, Work filter search) at rest, hovered, keyboard
 * focused, and filled (where the clear button shows), at 1280 and 390 in both themes. Each shot
 * is a crop around the field at 2x, so the highlight's shape against the bar is legible. The
 * audit records, per field, whether the focus outline is drawn on the bar (the wrapper) and
 * whether the clear button is present and its hit size. Then it tiles one contact sheet.
 *
 * Run:  node scripts/visual/shoot-search.mjs [outDir]   (after `pnpm build:fixtures`)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = path.join(ROOT, ".fixtures-dist");
const OUT = path.resolve(process.argv[2] ?? "/tmp/vf/search");
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

const settle = (p) => p.waitForTimeout(300);

const FIELDS = [
    {
        name: "sidebar",
        // Phones show the sidebar as the session list, so drop the open conversation first.
        open: (p) =>
            p.evaluate(() =>
                window.__matron.client.patch({
                    selectedConversationId: undefined,
                    trackerView: undefined,
                    filesView: undefined,
                }),
            ),
        box: '[data-testid="room-list-search"]',
        input: "#room-list-search-input",
        text: "design",
    },
    {
        name: "work",
        open: (p) => p.evaluate(() => window.__matron.openWork("ok")),
        box: ".mj_WorkSearch",
        input: 'input[aria-label="Search work"]',
        text: "permission",
    },
];

const STATES = ["rest", "hover", "focus", "filled"];

const VIEWPORTS = [
    { w: 1280, h: 860, phone: false },
    { w: 390, h: 844, phone: true },
];
const THEMES = ["light", "dark"];

const { server, port } = await serve(DIST);
const browser = await chromium.launch();
const report = [];
try {
    for (const vp of VIEWPORTS) {
        const context = await browser.newContext({
            viewport: { width: vp.w, height: vp.h },
            deviceScaleFactor: 2,
            isMobile: vp.phone,
            hasTouch: vp.phone,
        });
        for (const theme of THEMES) {
            for (const field of FIELDS) {
                for (const state of STATES) {
                    const page = await context.newPage();
                    await page.goto(`http://127.0.0.1:${port}/?theme=${theme}`);
                    await page.waitForSelector(".mx_MatrixChat");
                    await field.open(page);
                    await settle(page);
                    const input = page.locator(field.input);
                    let error = null;
                    try {
                        if (state === "hover") {
                            // Hover the bar's leading edge (the icon), not the input, so a highlight
                            // that only lives on the <input> shows as the partial rectangle it is.
                            const b = await page.locator(field.box).boundingBox();
                            await page.mouse.move(b.x + 20, b.y + b.height / 2);
                        } else if (state === "focus") {
                            // Keyboard focus, which is what :focus-visible is for.
                            await input.focus();
                            await page.keyboard.press("Shift+Tab");
                            await page.keyboard.press("Tab");
                        } else if (state === "filled") {
                            await input.focus();
                            await page.keyboard.type(field.text);
                        }
                    } catch (e) {
                        error = String(e).split("\n")[0];
                    }
                    await settle(page);
                    const box = await page.locator(field.box).boundingBox();
                    const file = path.join(OUT, `${field.name}-${state}-${vp.w}-${theme}.png`);
                    if (box) {
                        const pad = 12;
                        await page.screenshot({
                            path: file,
                            clip: {
                                x: Math.max(0, box.x - pad),
                                y: Math.max(0, box.y - pad),
                                width: Math.min(box.width + pad * 2, vp.w - Math.max(0, box.x - pad)),
                                height: box.height + pad * 2,
                            },
                        });
                    } else {
                        await page.screenshot({ path: file });
                        error = error ?? "field not visible";
                    }
                    const audit = await page.evaluate(
                        ({ inputSel }) => {
                            const el = document.querySelector(inputSel);
                            const active = document.activeElement;
                            const clear = el?.closest(".mj_SearchField")?.querySelector(".mj_SearchField_clear");
                            const cr = clear?.getBoundingClientRect();
                            const outlineOn = (n) =>
                                n &&
                                getComputedStyle(n).outlineStyle !== "none" &&
                                getComputedStyle(n).outlineWidth !== "0px";
                            return {
                                focused: active === el,
                                inputOutline: outlineOn(el),
                                clear: cr && cr.width ? `${Math.round(cr.width)}x${Math.round(cr.height)}` : null,
                            };
                        },
                        { inputSel: field.input },
                    );
                    report.push({ field: field.name, state, width: vp.w, theme, error, file, ...audit });
                    await page.close();
                }
            }
        }
        await context.close();
    }
} finally {
    await browser.close();
    server.close();
}

// One contact sheet: rows = field x state, columns = 1280 light | 1280 dark | 390 light | 390 dark.
const TILE_H = 120;
const GAP = 12;
const columns = VIEWPORTS.flatMap((vp) => THEMES.map((theme) => ({ vp, theme })));
const rows = [];
for (const field of FIELDS) {
    for (const state of STATES) {
        const tiles = [];
        for (const { vp, theme } of columns) {
            const file = path.join(OUT, `${field.name}-${state}-${vp.w}-${theme}.png`);
            const buffer = await sharp(file).resize({ height: TILE_H }).png().toBuffer();
            const meta = await sharp(buffer).metadata();
            tiles.push({ buffer, width: meta.width });
        }
        rows.push(tiles);
    }
}
const colW = columns.map((_, i) => Math.max(...rows.map((tiles) => tiles[i].width)));
const width = colW.reduce((s, w) => s + w + GAP, GAP);
const height = rows.length * (TILE_H + GAP) + GAP;
const composite = [];
rows.forEach((tiles, r) => {
    let left = GAP;
    tiles.forEach((tile, c) => {
        composite.push({ input: tile.buffer, left, top: GAP + r * (TILE_H + GAP) });
        left += colW[c] + GAP;
    });
});
await sharp({ create: { width, height, channels: 3, background: "#7f7f7f" } })
    .composite(composite)
    .png()
    .toFile(path.join(OUT, "sheet-search.png"));

fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
for (const row of report) {
    console.log(
        `${row.field} ${row.state} ${row.width} ${row.theme}: focused=${row.focused} inputOutline=${row.inputOutline} clear=${row.clear}${row.error ? ` ERROR ${row.error}` : ""}`,
    );
}
