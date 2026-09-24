/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Mobile audit driver. Serves the fixtures build (.fixtures-dist) and walks the primary surfaces
 * at phone viewports (390×844, 360×740) with touch emulation, tapping the REAL entry points
 * (not store patches) where one exists so a broken tap target shows up as a broken screenshot.
 * Also reports, per surface, horizontal overflow and visible tap targets under 44px.
 *
 * Run:  node scripts/visual/shoot-mobile.mjs [outDir]   (after `pnpm build:fixtures`)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const ROOT = process.cwd();
const DIST = path.join(ROOT, ".fixtures-dist");
const OUT = path.resolve(process.argv[2] ?? "/tmp/vf/mobile");
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

const patch = (p, update) => p.evaluate((u) => window.__matron.client.patch(u), update);
const toList = (p) => patch(p, { selectedConversationId: undefined, trackerView: undefined, filesView: undefined });

// Each surface starts from a fresh load. `tap` entries use real taps on real controls.
const SURFACES = [
    { name: "list", setup: toList },
    {
        name: "tracker-tap-from-list",
        setup: async (p) => {
            await toList(p);
            // Real tap on the real entry point; lists stay empty (no api in the fixture).
            await p
                .getByRole("button", { name: /^Tracker/ })
                .first()
                .tap();
        },
    },
    {
        // The bottom nav's Tracker tab (phone widths). Absent before the mobile nav existed.
        name: "tracker-via-nav",
        setup: async (p) => {
            await toList(p);
            const tab = p.locator('nav[aria-label="Primary"] button[data-nav="tracker"]');
            if (!(await tab.isVisible())) throw new Error("no mobile nav Tracker tab");
            await tab.tap();
            await p.evaluate(() => window.__matron.openTrackerInbox());
        },
    },
    {
        name: "offline-banner",
        setup: async (p) => {
            await toList(p);
            await patch(p, { connection: "offline" });
            await p.waitForTimeout(3_000);
        },
    },
    { name: "tracker-item", setup: (p) => p.evaluate(() => window.__matron.openTrackerItem()) },
    { name: "tracker-mission", setup: (p) => p.evaluate(() => window.__matron.openTrackerMission()) },
    { name: "chat", setup: async () => {} },
    {
        name: "files",
        setup: async (p) => {
            await p.evaluate(() => window.__matron.openFiles());
            await p.waitForTimeout(300);
        },
    },
    {
        name: "settings",
        setup: async (p) => {
            await toList(p);
            await p.getByRole("button", { name: "Settings" }).first().tap();
        },
    },
];

const VIEWPORTS = [
    { w: 390, h: 844 },
    { w: 360, h: 740 },
];

const { server, port } = await serve(DIST);
const browser = await chromium.launch();
const report = [];
try {
    for (const vp of VIEWPORTS) {
        const context = await browser.newContext({
            viewport: { width: vp.w, height: vp.h },
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
        });
        for (const surface of SURFACES) {
            const page = await context.newPage();
            await page.goto(`http://127.0.0.1:${port}/?theme=dark`);
            await page.waitForSelector(".mx_MatrixChat");
            let error = null;
            try {
                await surface.setup(page);
            } catch (e) {
                error = String(e).split("\n")[0];
            }
            await page.waitForTimeout(250);
            const file = path.join(OUT, `${vp.w}x${vp.h}-${surface.name}.png`);
            await page.screenshot({ path: file });
            const audit = await page.evaluate(() => {
                const doc = document.scrollingElement;
                const small = [];
                for (const el of document.querySelectorAll(
                    "button, a[href], [role=button], [role=tab], input, textarea",
                )) {
                    const r = el.getBoundingClientRect();
                    if (!r.width || !r.height) continue;
                    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
                    const style = getComputedStyle(el);
                    if (style.visibility === "hidden" || style.display === "none") continue;
                    if (r.width < 44 || r.height < 44) {
                        const label =
                            el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || el.className;
                        small.push(`${label} ${Math.round(r.width)}x${Math.round(r.height)}`);
                    }
                }
                const tracker = document.querySelector(".mj_TrackerPane")?.getBoundingClientRect();
                return {
                    hOverflow: doc.scrollWidth > innerWidth ? doc.scrollWidth - innerWidth : 0,
                    trackerPane: tracker
                        ? { x: Math.round(tracker.x), w: Math.round(tracker.width), h: Math.round(tracker.height) }
                        : null,
                    smallTargets: small,
                };
            });
            report.push({ viewport: `${vp.w}x${vp.h}`, surface: surface.name, error, file, ...audit });
            await page.close();
        }
        await context.close();
    }
} finally {
    await browser.close();
    server.close();
}
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
for (const row of report) {
    console.log(
        `${row.viewport} ${row.surface}: overflow=${row.hOverflow} tracker=${JSON.stringify(row.trackerPane)} small=${row.smallTargets.length}${row.error ? ` ERROR ${row.error}` : ""}`,
    );
}
