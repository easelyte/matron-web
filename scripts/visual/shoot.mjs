/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Visual-fidelity driver. Serves the fixtures build (.fixtures-dist, real components +
 * fake client), drives each component into every state × theme via Playwright, screenshots
 * the real element, and composites a per-component contact sheet with sharp. Where a design
 * mock exists it is placed alongside for a side-by-side. Outputs under /tmp/vf/.
 *
 * Run:  node scripts/visual/shoot.mjs   (after `pnpm build:fixtures`)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const ROOT = process.cwd();
const DIST = path.join(ROOT, ".fixtures-dist");
const OUT = "/tmp/vf";
const SHOTS = path.join(OUT, "app");
fs.mkdirSync(SHOTS, { recursive: true });

const MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".json": "application/json",
    ".ico": "image/x-icon",
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

// A shot: reach a state, then screenshot `clip` (a selector) — mouse left where it lands so
// :hover persists into the capture.
const SHOTS_SPEC = [
    { comp: "composer", state: "rest", clip: ".mx_MessageComposer", setup: async () => {} },
    {
        comp: "composer",
        state: "typed",
        clip: ".mx_MessageComposer",
        setup: async (p) => p.fill(".mx_BasicMessageComposer_input", "restart nginx on prod"),
    },
    {
        comp: "composer",
        state: "send-hover",
        clip: ".mx_MessageComposer",
        setup: async (p) => {
            await p.fill(".mx_BasicMessageComposer_input", "restart nginx on prod");
            await p.hover(".mx_MessageComposer_sendMessage");
        },
    },
    {
        comp: "composer",
        state: "slash-open",
        clip: ".mx_MessageComposer",
        setup: async (p) => p.fill(".mx_BasicMessageComposer_input", "/"),
    },
    {
        comp: "upload",
        state: "single",
        clip: ".mj_UploadConfirm",
        setup: async (p) => {
            await p.evaluate(() => window.__matron.stageImage());
            await p.waitForSelector(".mj_UploadConfirm_queue");
        },
    },
    {
        comp: "upload",
        state: "queue",
        clip: ".mj_UploadConfirm",
        setup: async (p) => {
            await p.evaluate(() => window.__matron.stageTwo());
            await p.waitForSelector(".mj_UploadConfirm_queue");
        },
    },
];

const THEMES = ["light", "dark"];
const WIDTH = 1180;

async function run() {
    const { server, port } = await serve(DIST);
    const base = `http://127.0.0.1:${port}/`;
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const results = [];

    for (const theme of THEMES) {
        for (const spec of SHOTS_SPEC) {
            const page = await browser.newPage({ viewport: { width: WIDTH, height: 840 }, deviceScaleFactor: 2 });
            await page.goto(`${base}?theme=${theme}`, { waitUntil: "networkidle" });
            await page.evaluate(() => document.fonts.ready);
            await spec.setup(page);
            await page.waitForTimeout(120); // settle transitions
            const file = path.join(SHOTS, `${spec.comp}__${spec.state}__${theme}.png`);
            await page.locator(spec.clip).first().screenshot({ path: file, animations: "disabled" });
            results.push({ ...spec, theme, file });
            await page.close();
        }
    }
    await browser.close();
    server.close();
    return results;
}

// ---- montage ----
const LABEL_H = 26;
const PAD = 10;
const BG = { light: "#e9e6df", dark: "#0d0e10" };

async function labeled(file, text, theme) {
    const img = sharp(file);
    const meta = await img.metadata();
    const w = meta.width;
    const label = Buffer.from(
        `<svg width="${w}" height="${LABEL_H}"><rect width="100%" height="100%" fill="${theme === "dark" ? "#16181c" : "#fff"}"/><text x="6" y="18" font-family="monospace" font-size="12" fill="${theme === "dark" ? "#bbb" : "#444"}">${text}</text></svg>`,
    );
    return sharp({ create: { width: w, height: meta.height + LABEL_H, channels: 4, background: theme === "dark" ? "#16181c" : "#fff" } })
        .composite([{ input: label, top: 0, left: 0 }, { input: await img.toBuffer(), top: LABEL_H, left: 0 }])
        .png()
        .toBuffer();
}

async function montageComponent(comp, results) {
    const cells = results.filter((r) => r.comp === comp);
    // one row per state, columns = themes; plus the mock as an extra left column where present
    const states = [...new Set(cells.map((c) => c.state))];
    const mockPath = path.join(ROOT, "docs/design/redesign-v4/upload-modal-mock.png");
    const hasMock = comp === "upload" && fs.existsSync(mockPath);

    const rows = [];
    for (const state of states) {
        const rowImgs = [];
        if (hasMock && state === "queue") rowImgs.push(await labeled(mockPath, "MOCK · upload-modal-mock.png", "light"));
        for (const theme of THEMES) {
            const cell = cells.find((c) => c.state === state && c.theme === theme);
            if (cell) rowImgs.push(await labeled(cell.file, `app · ${comp} · ${state} · ${theme}`, theme));
        }
        rows.push(rowImgs);
    }

    // layout: stack rows; within a row, place cells left→right with padding
    const rowMetas = [];
    for (const imgs of rows) {
        const metas = await Promise.all(imgs.map(async (b) => ({ b, m: await sharp(b).metadata() })));
        const wsum = metas.reduce((a, x) => a + x.m.width, 0) + PAD * (metas.length + 1);
        const hmax = Math.max(...metas.map((x) => x.m.height)) + PAD;
        rowMetas.push({ metas, wsum, hmax });
    }
    const W = Math.max(...rowMetas.map((r) => r.wsum));
    const H = rowMetas.reduce((a, r) => a + r.hmax, 0) + PAD;

    const composites = [];
    let y = PAD;
    for (const { metas, hmax } of rowMetas) {
        let x = PAD;
        for (const { b, m } of metas) {
            composites.push({ input: b, top: y, left: x });
            x += m.width + PAD;
        }
        y += hmax;
    }
    const out = path.join(OUT, `contact-sheet-${comp}.png`);
    await sharp({ create: { width: W, height: H, channels: 4, background: "#cfcabf" } })
        .composite(composites)
        .png()
        .toFile(out);
    return out;
}

const results = await run();
const sheets = [];
for (const comp of [...new Set(SHOTS_SPEC.map((s) => s.comp))]) {
    sheets.push(await montageComponent(comp, results));
}
console.log("SHEETS", JSON.stringify(sheets));
console.log("SHOTS", results.length);
