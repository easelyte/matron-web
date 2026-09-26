/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Before/after shots for the 2026-09-26 phone fixes: bottom tab bar and chat bottom under a
 * simulated home-indicator inset, the session ⋯ menu, the usage popover toggle, field font sizes
 * (iOS focus zoom) and markdown-free sidebar previews. Phones run at 390×844 with a 47/34 safe-area
 * inset (CDP Emulation.setSafeAreaInsetsOverride); desktop at 1280. Both themes.
 *
 * Run (after `pnpm build:fixtures`, with the old build copied aside):
 *   node scripts/visual/shoot-mobile-fixes.mjs <beforeDist> <afterDist> <outDir>
 * Writes <outDir>/{before,after}/<scene>-<w>-<theme>.png, <outDir>/measure.json and
 * <outDir>/contact-sheet.png (per scene: 390 row, 1280 row; columns before|after × light|dark).
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

// Pinned row + the markdown previews from the operator's screenshot.
const seed = () => {
    const c = window.__matron.client;
    const s = c.getSnapshot();
    const snippets = {
        c1: "Pushed. Session closed. ## Session summary **Done: deploy + rollback",
        c2: "**P1 — BRIDGE_DOWN** Operator bridge service not responding for 5m",
        c3: "**TECH & AI BRIEF — 2026-09-23 (cont.)** [Opus 5.5](https://x.test) and `pnpm` notes",
    };
    c.patch({
        pinnedIds: new Set(["c2"]),
        conversations: s.conversations.map((x) =>
            snippets[x.id]
                ? { ...x, snippet: snippets[x.id], title: x.id === "c1" ? "[96] Matron · polish pass follow-ups" : x.title }
                : x,
        ),
    });
};
const SCENES = [
    { name: "list", phoneOnly: false, setup: async (p, phone) => phone && p.evaluate(() => window.__matron.client.patch({ selectedConversationId: undefined })) },
    { name: "menu", setup: async (p) => p.click('button[aria-label="Conversation actions"]') },
    {
        name: "usage",
        setup: async (p, phone) => {
            if (!phone) return;
            await p.locator(".mj_UsageCluster_collapsed").tap();
        },
    },
    { name: "chat-bottom", setup: async () => {} },
    {
        name: "field-focus",
        setup: async (p, phone) => {
            if (phone) await p.evaluate(() => window.__matron.client.patch({ selectedConversationId: undefined }));
            await p.locator(".mx_RoomListSearch_input").focus();
        },
    },
];

async function shoot(dist, label, browser, measure) {
    const { server, port } = await serve(dist);
    const dir = path.join(OUT, label);
    fs.mkdirSync(dir, { recursive: true });
    for (const scene of SCENES)
        for (const w of [390, 1280])
            for (const theme of ["light", "dark"]) {
                const phone = w < 480;
                const ctx = await browser.newContext({
                    viewport: { width: w, height: phone ? 844 : 860 },
                    deviceScaleFactor: phone ? 2 : 1,
                    isMobile: phone,
                    hasTouch: phone,
                    reducedMotion: "reduce",
                });
                const page = await ctx.newPage();
                if (phone) {
                    const cdp = await ctx.newCDPSession(page);
                    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34 } });
                }
                await page.goto(`http://127.0.0.1:${port}/?theme=${theme}`);
                await page.waitForSelector("#matron > *");
                await page.evaluate(() => document.fonts.ready);
                await page.evaluate(seed);
                await page.waitForTimeout(250);
                await scene.setup(page, phone);
                await page.waitForTimeout(350);
                if (phone) {
                    // Paint the simulated status bar + home indicator so the inset reads in the shot.
                    await page.evaluate(() => {
                        const bar = (css) => {
                            const d = document.createElement("div");
                            d.style.cssText = `position:fixed;left:0;right:0;z-index:99999;pointer-events:none;${css}`;
                            document.body.append(d);
                        };
                        bar("top:0;height:47px;background:repeating-linear-gradient(45deg,rgba(255,0,128,.12) 0 6px,transparent 6px 12px)");
                        bar("bottom:8px;left:calc(50% - 67px);right:auto;width:134px;height:5px;border-radius:3px;background:rgba(128,128,128,.9)");
                    });
                }
                const m = await page.evaluate(() => {
                    const r = (s) => document.querySelector(s)?.getBoundingClientRect();
                    const nav = r(".mj_MobileNav"), label = r(".mj_MobileNav_label"), icon = r(".mj_MobileNav_icon svg");
                    const comp = r(".mx_MessageComposer"), hint = r(".mj_ComposerHint");
                    return {
                        navHeight: nav?.height,
                        navBorderToIcon: nav && icon ? icon.top - nav.top - 1 : undefined,
                        labelBottomToScreen: label ? innerHeight - label.bottom : undefined,
                        composerBottomGap: comp ? innerHeight - comp.bottom : undefined,
                        hintBottomToScreen: hint ? innerHeight - hint.bottom : undefined,
                        titleWidth: r(".mj_HeaderTitleCluster")?.width,
                        usageOpen: Boolean(document.querySelector(".mj_UsagePopover")),
                        fields: [...document.querySelectorAll("input,textarea,select,[contenteditable=true]")]
                            .filter((e) => e.offsetParent)
                            .map((e) => `${e.className || e.tagName}: ${getComputedStyle(e).fontSize}`),
                        previews: [...document.querySelectorAll(".mj_RoomListPreview")].map((e) => e.textContent),
                        menuRows: [...document.querySelectorAll("[role=menu] > *")].map((e) => {
                            const b = e.getBoundingClientRect();
                            return `${e.getAttribute("role")} ${e.textContent.trim() || "—"} h=${b.height}`;
                        }),
                    };
                });
                if (scene.name === "usage" && phone) {
                    await page.screenshot({ path: path.join(dir, `${scene.name}-${w}-${theme}.png`) });
                    await page.locator(".mj_UsageCluster_collapsed").tap();
                    await page.waitForTimeout(250);
                    m.usageOpenAfterSecondTap = Boolean(await page.$(".mj_UsagePopover"));
                } else {
                    await page.screenshot({ path: path.join(dir, `${scene.name}-${w}-${theme}.png`) });
                }
                measure[`${label}/${scene.name}-${w}-${theme}`] = m;
                await ctx.close();
            }
    server.close();
}

async function label(text, width) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="26"><rect width="100%" height="100%" fill="#222"/><text x="8" y="18" font-family="sans-serif" font-size="15" fill="#fff">${text}</text></svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
}

async function sheet() {
    const CELL = 390, GAP = 8;
    const composite = [];
    let y = GAP;
    const cols = [["before", "light"], ["after", "light"], ["before", "dark"], ["after", "dark"]];
    for (const scene of SCENES) {
        composite.push({ input: await label(`${scene.name}`, 4 * CELL + 3 * GAP), left: GAP, top: y });
        y += 30;
        for (const w of [390, 1280]) {
            let rowH = 0;
            const cells = [];
            for (const [i, [when, theme]] of cols.entries()) {
                const buf = await sharp(path.join(OUT, when, `${scene.name}-${w}-${theme}.png`)).resize({ width: CELL }).png().toBuffer();
                const h = (await sharp(buf).metadata()).height;
                rowH = Math.max(rowH, h + 26);
                cells.push({ buf, left: GAP + i * (CELL + GAP), tag: `${w} ${theme} ${when.toUpperCase()}` });
            }
            for (const c of cells) {
                composite.push({ input: await label(c.tag, CELL), left: c.left, top: y });
                composite.push({ input: c.buf, left: c.left, top: y + 26 });
            }
            y += rowH + GAP;
        }
        y += GAP;
    }
    const W = 4 * CELL + 5 * GAP;
    await sharp({ create: { width: W, height: y, channels: 3, background: "#808080" } })
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
