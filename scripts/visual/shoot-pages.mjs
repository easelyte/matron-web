/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Full-page fixture screenshots, one per theme, for before/after pairs in design PRs.
 * Serves .fixtures-dist (after `pnpm build:fixtures`) on a loopback port and shoots the
 * real MatronApp fixture at 1280×860, 2×. Outputs /tmp/vf-tokens/<tag>-<theme>.png.
 *
 * Run:  node scripts/visual/shoot-pages.mjs <tag> [--screen=login] [--fixed] [--tracker=inbox|item|memories|memory]
 *       [--click=<css selector> (repeatable, in order)] [--scroll=<css selector>] [--param=key=value] [--width=1280] [--height=860]
 *   --scroll scrolls the first match into view (after any click) before the shot.
 *   --param adds one more fixture query parameter (repeatable), e.g. --param=missions=1.
 *   --screen=login shoots the signed-out sign-in screen; --fixed adds a config-fixed server
 *   (hidden server field). Files are <tag>-<theme>.png for the chat, <tag>-<screen>[-fixed]-<theme>.png otherwise.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const DIST = path.resolve(process.cwd(), ".fixtures-dist");
const OUT = "/tmp/vf-tokens";
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const tag = args.find((a) => !a.startsWith("--")) || "shot";
const screen = flag("screen") || "chat";
const fixed = args.includes("--fixed");
const tracker = flag("tracker");
const clicks = args.filter((a) => a.startsWith("--click=")).map((a) => a.slice("--click=".length));
const click = clicks[0];
const params = args.filter((a) => a.startsWith("--param=")).map((a) => a.slice("--param=".length));
const scroll = flag("scroll");
const width = Number(flag("width") || 1280);
const height = Number(flag("height") || 860);
const suffix =
    (screen === "chat" ? "" : `-${screen}${fixed ? "-fixed" : ""}`) +
    (tracker ? `-tracker-${tracker}` : "") +
    params.map((p) => `-${p.replace(/[^a-z0-9]+/gi, "-")}`).join("") +
    (click ? "-clicked" : "") +
    (scroll ? "-scrolled" : "");
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

/** Every file under the fixtures dir, keyed by its URL path — the request only ever selects
 *  from this map, so nothing outside the directory can be named. */
function fileIndex(root) {
    const files = new Map();
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else files.set("/" + path.relative(root, full).split(path.sep).join("/"), full);
        }
    };
    walk(root);
    return files;
}

function serve(root) {
    const files = fileIndex(root);
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let urlPath;
            try {
                urlPath = decodeURIComponent(req.url.split("?")[0]);
            } catch {
                res.writeHead(400);
                res.end("bad request");
                return;
            }
            const file = files.get(urlPath === "/" ? "/index.html" : urlPath);
            if (!file) {
                res.writeHead(404);
                res.end("not found");
                return;
            }
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

const { server, port } = await serve(DIST);
const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    const query = new URLSearchParams({ theme, screen });
    if (fixed) query.set("fixed", "1");
    if (tracker) query.set("tracker", tracker);
    for (const p of params) {
        const [key, ...rest] = p.split("=");
        query.set(key, rest.join("="));
    }
    await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: "load" });
    await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(800);
    for (const selector of clicks) {
        await page.click(selector);
        await page.waitForTimeout(300);
    }
    if (scroll) {
        await page.locator(scroll).first().scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(OUT, `${tag}${suffix}-${theme}.png`) });
    await page.close();
}
await browser.close();
server.close();
console.log("shots:", tag);
