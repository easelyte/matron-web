/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Before/after shots for the 2026-09-28 composer tweaks: a multi-line chat draft restored after
 * switching away and back (it should open at its typed height), and the tracker reply box's
 * send key (Enter sends, Shift+Enter is a newline). 390 (phone) and 1280, light theme.
 *
 * Run (after `pnpm build:fixtures`, with the old build copied aside):
 *   node scripts/visual/shoot-composer-tweaks.mjs <beforeDist> <afterDist> <outDir>
 * Writes <outDir>/{before,after}/<scene>-<w>.png, <outDir>/measure.json, <outDir>/contact-sheet.png.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const [BEFORE, AFTER, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
function serve(dir) {
    const root = fs.realpathSync(dir);
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = decodeURIComponent(req.url.split("?")[0]);
            let f;
            try {
                // Contained in the build dir after resolving .. and symlinks, or refused.
                f = fs.realpathSync(path.resolve(root, u === "/" ? "index.html" : u.replace(/^\/+/, "")));
            } catch {
                return res.writeHead(404).end();
            }
            if (f !== root && !f.startsWith(root + path.sep)) return res.writeHead(403).end();
            fs.readFile(f, (e, d) => {
                if (e) return res.writeHead(404).end();
                res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream" }).end(d);
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
}

const DRAFT = "Draft I was halfway through:\n- check the deploy log\n- confirm the release id\n- then reply on the item\n- and close the loop";

const SCENES = [
    {
        // Type a draft in c1, switch to c2, come back: the restored draft's box height.
        name: "draft-restored",
        setup: async (p) => {
            const box = p.locator(".mx_BasicMessageComposer_input");
            await box.fill(DRAFT);
            await p.waitForTimeout(400);
            await p.evaluate(() => window.__matron.client.patch({ selectedConversationId: "c2" }));
            await p.waitForTimeout(300);
            await p.evaluate(() => window.__matron.client.patch({ selectedConversationId: "c1" }));
            await p.waitForTimeout(300);
            await box.evaluate((n) => n.blur());
        },
        measure: ".mx_BasicMessageComposer_input",
    },
    {
        // Shift+Enter inserts a newline in the tracker reply box (unchanged).
        name: "tracker-shift-enter",
        setup: async (p) => {
            await p.evaluate(() => window.__matron.openTrackerItem());
            await p.waitForTimeout(300);
            const box = p.locator(".mj_TrackerComposer_input");
            await box.click();
            await p.keyboard.type("First line");
            await p.keyboard.press("Shift+Enter");
            await p.keyboard.type("second line");
        },
        measure: ".mj_TrackerComposer_input",
    },
    {
        // Enter: before, a third (empty) line; after, the reply is sent and the box is empty again.
        name: "tracker-enter",
        setup: async (p) => {
            await p.evaluate(() => {
                window.__sent = [];
                window.__matron.client.commentItem = async (num, body) => {
                    window.__sent.push(body.body);
                    return true;
                };
                window.__matron.openTrackerItem();
            });
            await p.waitForTimeout(300);
            const box = p.locator(".mj_TrackerComposer_input");
            await box.click();
            await p.keyboard.type("First line");
            await p.keyboard.press("Shift+Enter");
            await p.keyboard.type("second line");
            await p.keyboard.press("Enter");
        },
        measure: ".mj_TrackerComposer_input",
    },
];

async function shoot(dist, label, browser, measure) {
    const { server, port } = await serve(dist);
    const dir = path.join(OUT, label);
    fs.mkdirSync(dir, { recursive: true });
    for (const scene of SCENES)
        for (const w of [390, 1280]) {
            const phone = w < 480;
            const ctx = await browser.newContext({
                viewport: { width: w, height: phone ? 844 : 860 },
                deviceScaleFactor: phone ? 2 : 1,
                isMobile: phone,
                hasTouch: phone,
                reducedMotion: "reduce",
            });
            const page = await ctx.newPage();
            await page.goto(`http://127.0.0.1:${port}/?theme=light`);
            await page.waitForSelector("#matron > *");
            await page.evaluate(() => document.fonts.ready);
            await page.waitForTimeout(250);
            await scene.setup(page, phone);
            await page.waitForTimeout(400);
            measure[`${label}/${scene.name}-${w}`] = await page.evaluate((sel) => {
                const n = document.querySelector(sel);
                return {
                    value: n?.value,
                    height: n ? Math.round(n.getBoundingClientRect().height) : undefined,
                    styleHeight: n?.style.height,
                    focused: document.activeElement === n,
                    sent: window.__sent,
                };
            }, scene.measure);
            await page.screenshot({ path: path.join(dir, `${scene.name}-${w}.png`) });
            await ctx.close();
        }
    server.close();
}

async function label(text, width) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="26"><rect width="100%" height="100%" fill="#222"/><text x="8" y="18" font-family="sans-serif" font-size="15" fill="#fff">${text}</text></svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
}

async function sheet() {
    const CELL = 520, GAP = 8;
    const composite = [];
    let y = GAP;
    for (const scene of SCENES) {
        composite.push({ input: await label(scene.name, 2 * CELL + GAP), left: GAP, top: y });
        y += 30;
        for (const w of [390, 1280]) {
            let rowH = 0;
            for (const [i, when] of ["before", "after"].entries()) {
                const buf = await sharp(path.join(OUT, when, `${scene.name}-${w}.png`)).resize({ width: CELL }).png().toBuffer();
                const h = (await sharp(buf).metadata()).height;
                rowH = Math.max(rowH, h + 26);
                composite.push({ input: await label(`${w} ${when.toUpperCase()}`, CELL), left: GAP + i * (CELL + GAP), top: y });
                composite.push({ input: buf, left: GAP + i * (CELL + GAP), top: y + 26 });
            }
            y += rowH + GAP;
        }
        y += GAP;
    }
    await sharp({ create: { width: 2 * CELL + 3 * GAP, height: y, channels: 3, background: "#808080" } })
        .composite(composite)
        .png()
        .toFile(path.join(OUT, "contact-sheet.png"));
}

const browser = await chromium.launch();
const measure = {};
try {
    await shoot(BEFORE, "before", browser, measure);
    await shoot(AFTER, "after", browser, measure);
} finally {
    await browser.close();
}
fs.writeFileSync(path.join(OUT, "measure.json"), JSON.stringify(measure, null, 2));
await sheet();
console.log("wrote", path.join(OUT, "contact-sheet.png"));
