/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Control-geometry audit. Serves the fixtures build (.fixtures-dist), opens every surface at
 * 1280 / 1024 / 768 / 390 in both themes, and MEASURES (getComputedStyle + getBoundingClientRect,
 * never eyeballs) every visible interactive control:
 *
 *  - Row check: controls that share a flex row (the nearest row-flex ancestor holding two or more
 *    controls) must share one height, one vertical centre, one radius and one font size. Composite
 *    controls (tablist / radiogroup / role=group) are measured as ONE box so a segmented control is
 *    compared with the inputs beside it, not with its own segments.
 *  - Census: every boxed control's height / radius / font size, bucketed, so off-scale values show.
 *  - Focus + hover (1280 light only): the focus-visible treatment and the hover delta per control
 *    class, so inconsistent rings and dead hovers show.
 *
 * Writes <out>/audit.json, <out>/shots/<scene>-<w>-<theme>.png and one contact sheet per scene
 * (<out>/sheets/<scene>.png: rows = widths, columns = light | dark).
 *
 * Run:  node scripts/visual/audit-controls.mjs [outDir]    (after `pnpm build:fixtures`)
 *       AUDIT_ONLY=work-list,work-filtered  AUDIT_WIDTHS=1280,390  to narrow a run.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

const ROOT = process.cwd();
const DIST = path.join(ROOT, ".fixtures-dist");
const OUT = path.resolve(process.argv[2] ?? "/tmp/vf/audit");
const ONLY = process.env.AUDIT_ONLY ? new Set(process.env.AUDIT_ONLY.split(",")) : null;
const WIDTHS = process.env.AUDIT_WIDTHS ? process.env.AUDIT_WIDTHS.split(",").map(Number) : [1280, 1024, 768, 390];
const THEMES = (process.env.AUDIT_THEMES ?? "light,dark").split(",");
const STATES = process.env.AUDIT_STATES !== "0";
fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });
fs.mkdirSync(path.join(OUT, "sheets"), { recursive: true });

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
            const urlPath = decodeURIComponent(req.url.split("?")[0]);
            const file = path.resolve(root, urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, ""));
            if (!file.startsWith(root)) {
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

const ev = (fn, arg) => (p) => p.evaluate(fn, arg);
const patch = (update) => (p) => p.evaluate((u) => window.__matron.client.patch(u), update);
const click = (sel, opts) => async (p) => {
    const loc = opts?.hasText ? p.locator(sel, { hasText: opts.hasText }) : p.locator(sel);
    // Strict: a missing target fails the scene rather than measuring whatever is still open.
    await loc.first().click({ timeout: 3000 });
};
const seq =
    (...steps) =>
    async (p) => {
        for (const s of steps) {
            await s(p);
            await p.waitForTimeout(250);
        }
    };
// Phone shows the list first when nothing is selected; most scenes select c1 already.
const openSettings = async (p) => {
    const back = p.locator('button[aria-label="Back to conversations"]');
    if (await back.isVisible().catch(() => false)) await back.click();
    await click('button[aria-label="Settings"]')(p);
};
const openNewSession = async (p) => {
    const back = p.locator('button[aria-label="Back to conversations"]');
    if (await back.isVisible().catch(() => false)) await back.click();
    await click('button[aria-label="New session options"]')(p);
};

// What each scene must show after setup; a miss is a setup error and fails the run, so a drifted
// selector can never report the previous screen as a clean scene.
const EXPECT = {
    chat: ".mx_MessageComposer",
    "chat-v6": ".mj_AgentTurn",
    "chat-child": ".mj_SubagentBack",
    "composer-staged": ".mj_UploadConfirm",
    "composer-slash": '[role="listbox"]',
    "sidebar-list": ".mj_RoomListTabs",
    "session-menu": '[role="menu"]',
    "browser-confirm": '[role="dialog"]',
    "browser-confirm-busy": '[role="dialog"]',
    settings: '[role="menu"], [role="dialog"]',
    "new-session": '[role="dialog"]',
    "tracker-missions": ".mj_TrackerPane",
    "tracker-mission": ".mj_TrackerDetail",
    "tracker-inbox": ".mj_TrackerInboxToggle",
    "tracker-item": ".mj_TrackerComposer",
    "work-list": ".mj_WorkFilters",
    "work-filtered": ".mj_WorkSelect_set",
    "work-detail": ".mj_TrackerDetail",
    "work-empty": ".mj_TrackerEmpty",
    "files-list": ".mj_FilesList",
    "files-preview": ".mj_FilesPreview_header",
    "files-upload": ".mj_FileWrite_confirm",
    "files-edit": ".mj_FileWrite_textarea",
    "files-delete": '[role="dialog"]:has-text("Delete file")',
    "media-viewer": ".mj_MediaViewer",
    offline: ".mj_ConnectionError, .mj_ConnectionBanner",
    signin: ".mx_Login_submit",
};

export const SCENES = [
    { name: "chat", query: "" },
    { name: "chat-v6", query: "v6=full" },
    { name: "chat-child", query: "", setup: ev(() => window.__matron.selectChild()) },
    { name: "composer-staged", query: "", setup: ev(() => window.__matron.stageTwo()) },
    { name: "composer-slash", query: "", setup: (p) => p.fill(".mx_BasicMessageComposer_input", "/") },
    { name: "sidebar-list", query: "", setup: patch({ selectedConversationId: undefined }) },
    { name: "session-menu", query: "v6=t1", setup: click('button[aria-label="Conversation actions"]') },
    {
        name: "browser-confirm",
        query: "v6=t1",
        setup: seq(
            click('button[aria-label="Conversation actions"]'),
            click(".mj_RoomItemMenu_item", { hasText: "Enable browser tools" }),
        ),
    },
    {
        // Running session: the confirm grows a third action ("Restart now"), the widest footer.
        name: "browser-confirm-busy",
        query: "v6=run",
        setup: seq(
            click('button[aria-label="Conversation actions"]'),
            click(".mj_RoomItemMenu_item", { hasText: "Enable browser tools" }),
        ),
    },
    { name: "settings", query: "v6=t1", setup: openSettings },
    { name: "new-session", query: "v6=t1", setup: openNewSession },
    { name: "tracker-missions", query: "", setup: ev(() => window.__matron.openTrackerMissions()) },
    { name: "tracker-mission", query: "", setup: ev(() => window.__matron.openTrackerMission()) },
    { name: "tracker-inbox", query: "", setup: ev(() => window.__matron.openTrackerInbox()) },
    { name: "tracker-item", query: "", setup: ev(() => window.__matron.openTrackerItem()) },
    { name: "work-list", query: "", setup: ev(() => window.__matron.openWork("ok")) },
    {
        name: "work-filtered",
        query: "",
        setup: seq(
            ev(() => window.__matron.openWork("ok")),
            (p) => p.selectOption('select[aria-label="Status"]', "all"),
            (p) => p.getByRole("tab", { name: "Domain" }).click(),
            (p) => p.fill('input[aria-label="Search work"]', "permission"),
        ),
    },
    { name: "work-detail", query: "", setup: ev(() => window.__matron.openWorkLoop(108)) },
    { name: "work-empty", query: "", setup: ev(() => window.__matron.openWork("empty")) },
    {
        name: "files-list",
        query: "",
        setup: seq(
            ev(() => window.__matron.openFiles()),
            (p) => p.waitForSelector(".mj_FilesList"),
        ),
    },
    {
        name: "files-preview",
        query: "",
        setup: seq(
            ev(() => window.__matron.openFiles()),
            click(".mj_FilesRow", { hasText: "client.ts" }),
        ),
    },
    {
        name: "files-upload",
        query: "",
        setup: seq(
            ev(() => window.__matron.openFiles()),
            (p) => p.waitForSelector(".mj_FilesToolbar"),
            ev(() => window.__matron.stageFileUpload()),
        ),
    },
    {
        name: "files-edit",
        query: "",
        setup: seq(
            ev(() => window.__matron.openFiles()),
            click(".mj_FilesRow", { hasText: "README.md" }),
            (p) => p.waitForSelector(".mj_FilesPreview_edit"),
            click(".mj_FilesPreview_edit"),
        ),
    },
    {
        name: "files-delete",
        query: "",
        setup: seq(
            ev(() => window.__matron.openFiles()),
            (p) => p.waitForSelector(".mj_FilesToolbar"),
            // A FILE's delete (the folder dialog differs). Phones show only the first rows of the
            // stacked, virtualised list, so scroll archive.zip into the rendered window first.
            async (p) => {
                const row = p.locator('[aria-label="Delete archive.zip"]');
                for (let i = 0; i < 20 && !(await row.count()); i++)
                    await p.evaluate(() => {
                        for (const el of document.querySelectorAll(".mj_FilesPane_list, .mj_FilesPane_list *"))
                            if (el.scrollHeight > el.clientHeight + 1) el.scrollTop += 200;
                    });
                await row.first().click({ timeout: 3000 });
            },
        ),
    },
    { name: "media-viewer", query: "v6=full", setup: seq(click(".mj_Image img"), (p) => p.waitForTimeout(300)) },
    // The offline banner has a grace period before it shows (shoot-mobile waits the same 3s).
    {
        name: "offline",
        query: "",
        setup: seq(patch({ connection: "offline", controlError: "Couldn't reach the bridge. Retrying…" }), (p) =>
            p.waitForTimeout(3200),
        ),
    },
    { name: "signin", query: "", setup: patch({ phase: "signed-out" }) },
];

// ───────────────────────────── in-page measurement ─────────────────────────────
function measureInPage() {
    const CONTROL =
        'button, input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), select, textarea, [contenteditable="true"], [role=button], [role=tab], [role=radio], [role=menuitem], [role=menuitemradio], [role=switch], [role=checkbox], [role=option], a[href]';
    const COMPOSITE = "[role=tablist], [role=radiogroup], [role=group], .mj_Segmented";
    const vw = innerWidth;
    const vh = innerHeight;
    const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
        if (el.closest('[aria-hidden="true"], [inert]')) return false;
        // Covered by a modal? Only count topmost at centre.
        const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
        const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
        const top = document.elementFromPoint(cx, cy);
        if (top && !el.contains(top) && !top.contains(el)) {
            // Allow labels / overlays owned by the control's own row (icon overlays).
            if (!top.closest("label") || !top.closest("label").contains(el)) return false;
        }
        return true;
    };
    const alpha = (c) => {
        if (!c || c === "transparent") return 0;
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return 1;
        const parts = m[1].split(/[ ,/]+/).filter(Boolean);
        return parts.length >= 4 ? parseFloat(parts[3]) : 1;
    };
    const name = (el) => {
        const cls = [...el.classList].filter((c) => /^m[jx]_/.test(c));
        let owner = el;
        while (!cls.length && owner.parentElement) {
            owner = owner.parentElement;
            const c = [...owner.classList].filter((x) => /^m[jx]_/.test(x));
            if (c.length) {
                cls.push(c[0] + ">" + el.tagName.toLowerCase());
                break;
            }
        }
        const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 28);
        return { cls: cls.slice(0, 2).join("."), label };
    };
    const px = (v) => Math.round(parseFloat(v) * 10) / 10;
    const describe = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const svg = el.querySelector("svg");
        const sr = svg ? svg.getBoundingClientRect() : null;
        const boxed =
            (px(cs.borderTopWidth) > 0 && alpha(cs.borderTopColor) > 0.05) || alpha(cs.backgroundColor) > 0.05;
        // A composite's own font is inherited noise; its first control's font is what renders.
        const inner = el.matches(COMPOSITE) ? el.querySelector(CONTROL) : null;
        const fcs = inner ? getComputedStyle(inner) : cs;
        return {
            ...name(el),
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || "",
            x: px(r.left),
            y: px(r.top),
            w: px(r.width),
            h: px(r.height),
            cy: px(r.top + r.height / 2),
            radius: px(cs.borderTopLeftRadius),
            fontSize: px(fcs.fontSize),
            fontWeight: fcs.fontWeight,
            lineHeight: fcs.lineHeight,
            padding: `${px(cs.paddingTop)} ${px(cs.paddingRight)} ${px(cs.paddingBottom)} ${px(cs.paddingLeft)}`,
            border: `${px(cs.borderTopWidth)} ${cs.borderTopColor}`,
            bg: cs.backgroundColor,
            color: cs.color,
            icon: sr ? `${px(sr.width)}x${px(sr.height)}` : "",
            boxed,
        };
    };

    const all = [...document.querySelectorAll(CONTROL)].filter(visible);
    const composites = [...document.querySelectorAll(COMPOSITE)].filter(visible);
    // Units for row comparison: composites stand in for their children; nested controls drop.
    const inComposite = (el) => composites.some((c) => c !== el && c.contains(el));
    const units = [
        ...composites.filter((c) => !composites.some((o) => o !== c && o.contains(c))),
        ...all.filter((el) => !inComposite(el) && !all.some((o) => o !== el && o.contains(el) && o.matches(CONTROL))),
    ];
    const controls = all.map(describe);

    // Row grouping: nearest row-flex ancestor containing >=2 units.
    const rows = new Map();
    for (const u of units) {
        let a = u.parentElement;
        for (let depth = 0; a && depth < 6; depth++, a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (!/flex|grid/.test(cs.display)) continue;
            if (/flex/.test(cs.display) && cs.flexDirection.startsWith("column")) continue;
            const members = units.filter((o) => a.contains(o));
            if (members.length < 2) continue;
            if (!rows.has(a)) rows.set(a, new Set());
            rows.get(a).add(u);
            break;
        }
    }
    const findings = [];
    for (const [container, set] of rows) {
        const items = [...set].map((el) => ({ el, d: describe(el) }));
        // Split into visual lines by vertical overlap.
        items.sort((a, b) => a.d.y - b.d.y);
        const lines = [];
        for (const it of items) {
            const line = lines.find((l) => l.some((o) => it.d.y < o.d.y + o.d.h - 2 && o.d.y < it.d.y + it.d.h - 2));
            if (line) line.push(it);
            else lines.push([it]);
        }
        for (const line of lines) {
            if (line.length < 2) continue;
            const boxed = line.filter((i) => i.d.boxed);
            const spread = (arr, k) => {
                const v = arr.map((i) => i.d[k]);
                return v.length ? Math.max(...v) - Math.min(...v) : 0;
            };
            const issues = [];
            if (boxed.length >= 2 && spread(boxed, "h") > 0.5) issues.push("height");
            // Inline glyph buttons (a title's disclosure chevron) ride their text, not the row.
            const sized = line.filter((i) => i.d.h >= 20);
            if (sized.length >= 2 && spread(sized, "cy") > 1) issues.push("centre");
            if (boxed.length >= 2 && spread(boxed, "radius") > 0.5 && boxed.every((i) => i.d.radius < i.d.h / 2))
                issues.push("radius");
            // Type is compared within a kind: entered text (fields) vs labels (buttons, segments).
            const field = (i) => /^(input|select|textarea)$/.test(i.d.tag);
            for (const kind of [boxed.filter(field), boxed.filter((i) => !field(i))])
                if (kind.length >= 2 && spread(kind, "fontSize") > 0.5 && !issues.includes("font")) issues.push("font");
            if (!issues.length) continue;
            findings.push({
                row: name(container).cls || container.tagName.toLowerCase(),
                issues,
                members: line.map((i) => ({
                    cls: i.d.cls,
                    label: i.d.label,
                    h: i.d.h,
                    cy: i.d.cy,
                    radius: i.d.radius,
                    fontSize: i.d.fontSize,
                    boxed: i.d.boxed,
                })),
            });
        }
    }
    // Clipping: a control pushed past the viewport edge (the audit's visibility filter would
    // otherwise drop it silently). Controls inside a horizontal scroller are allowed.
    for (const el of document.querySelectorAll(CONTROL)) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= vh) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if (el.closest('[aria-hidden="true"], [inert]')) continue;
        if (r.left >= -0.5 && r.right <= vw + 0.5) continue;
        let scroller = false;
        for (let a = el.parentElement; a; a = a.parentElement)
            if (/auto|scroll/.test(getComputedStyle(a).overflowX)) scroller = true;
        if (scroller) continue;
        findings.push({
            row: "viewport",
            issues: ["clipped"],
            members: [
                { ...name(el), h: Math.round(r.height), cy: Math.round(r.left), radius: 0, fontSize: 0, boxed: true },
            ],
        });
    }
    return { controls, findings };
}

async function focusHover(page) {
    // One representative per control class: focus-visible treatment + hover delta.
    const handles = await page.evaluateHandle(() => {
        const CONTROL =
            "button, input:not([type=hidden]):not([type=file]), select, textarea, [role=button], [role=tab], [role=radio], [role=menuitem], a[href]";
        const seen = new Set();
        const out = [];
        for (const el of document.querySelectorAll(CONTROL)) {
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1 || r.top > innerHeight || r.bottom < 0) continue;
            if (el.closest('[aria-hidden="true"], [inert]')) continue;
            const cls =
                [...el.classList].filter((c) => /^m[jx]_/.test(c))[0] ||
                el.parentElement?.className?.split?.(" ")[0] + ">" + el.tagName;
            if (seen.has(cls)) continue;
            seen.add(cls);
            out.push(el);
        }
        return out;
    });
    const count = await page.evaluate((a) => a.length, handles);
    const res = [];
    for (let i = 0; i < count; i++) {
        const el = await page.evaluateHandle(([a, j]) => a[j], [handles, i]);
        const read = () =>
            el.evaluate((e) => {
                const cs = getComputedStyle(e);
                return {
                    cls:
                        [...e.classList]
                            .filter((c) => /^m[jx]_/.test(c))
                            .slice(0, 2)
                            .join(".") || e.tagName,
                    outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} off ${cs.outlineOffset}`,
                    shadow: cs.boxShadow,
                    bg: cs.backgroundColor,
                    border: cs.borderTopColor,
                    color: cs.color,
                    cursor: cs.cursor,
                };
            });
        try {
            const rest = await read();
            await page.mouse.move(0, 0);
            await page.keyboard.press("Shift");
            await el.evaluate((e) => e.focus());
            const focus = await read();
            const focusVisible = await el.evaluate((e) => e.matches(":focus-visible"));
            await el.evaluate((e) => e.blur());
            await el.hover({ timeout: 800, force: true }).catch(() => undefined);
            await page.waitForTimeout(160);
            const hover = await read();
            await page.mouse.move(0, 0);
            res.push({
                cls: rest.cls,
                focusVisible,
                ring:
                    focus.outline !== rest.outline || focus.shadow !== rest.shadow
                        ? focus.outline.startsWith("none")
                            ? `shadow ${focus.shadow}`
                            : `outline ${focus.outline}`
                        : "NONE",
                hoverDelta: hover.bg !== rest.bg || hover.border !== rest.border || hover.color !== rest.color,
                cursor: rest.cursor,
            });
        } catch {
            /* detached by a previous interaction; skip */
        }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    return res;
}

async function tile(files, outFile, cols) {
    const imgs = await Promise.all(
        files.map(async (f) => {
            const buf = await sharp(f).resize({ width: 640, withoutEnlargement: false }).png().toBuffer();
            const meta = await sharp(buf).metadata();
            return { buf, w: meta.width, h: meta.height };
        }),
    );
    const rows = [];
    for (let i = 0; i < imgs.length; i += cols) rows.push(imgs.slice(i, i + cols));
    const rowH = rows.map((r) => Math.max(...r.map((i) => i.h)));
    const W = cols * 640 + (cols + 1) * 8;
    const H = rowH.reduce((a, b) => a + b + 8, 8);
    const composite = [];
    let y = 8;
    rows.forEach((r, ri) => {
        r.forEach((img, ci) => composite.push({ input: img.buf, left: 8 + ci * 648, top: y }));
        y += rowH[ri] + 8;
    });
    await sharp({ create: { width: W, height: H, channels: 3, background: "#808080" } })
        .composite(composite)
        .png()
        .toFile(outFile);
}

const { server, port } = await serve(DIST);
const browser = await chromium.launch();
const report = [];
try {
    for (const scene of SCENES) {
        if (ONLY && !ONLY.has(scene.name)) continue;
        const shots = [];
        for (const w of WIDTHS) {
            const phone = w < 480;
            for (const theme of THEMES) {
                const context = await browser.newContext({
                    viewport: { width: w, height: phone ? 844 : w <= 800 ? 1024 : 860 },
                    deviceScaleFactor: 1,
                    hasTouch: phone,
                    isMobile: phone,
                    reducedMotion: "reduce",
                });
                const page = await context.newPage();
                const q = [`theme=${theme}`, scene.query].filter(Boolean).join("&");
                await page.goto(`http://127.0.0.1:${port}/?${q}`);
                await page.waitForSelector("#matron > *");
                await page.evaluate(() => document.fonts.ready);
                await page.waitForTimeout(300);
                let setupError = "";
                if (scene.setup) await scene.setup(page).catch((e) => (setupError = String(e).slice(0, 200)));
                const expected = EXPECT[scene.name];
                if (
                    !setupError &&
                    expected &&
                    !(await page
                        .locator(expected)
                        .first()
                        .isVisible()
                        .catch(() => false))
                )
                    setupError = `expected ${expected} not visible after setup`;
                await page.waitForTimeout(400);
                const file = path.join(OUT, "shots", `${scene.name}-${w}-${theme}.png`);
                await page.screenshot({ path: file });
                shots.push(file);
                const m = await page.evaluate(measureInPage);
                const entry = { scene: scene.name, w, theme, setupError, ...m };
                if (STATES && theme === "light" && (w === 1280 || w === 390)) entry.states = await focusHover(page);
                report.push(entry);
                console.log(
                    `${scene.name} ${w} ${theme}: ${m.controls.length} controls, ${m.findings.length} row findings${setupError ? " SETUP-ERR" : ""}`,
                );
                await context.close();
            }
        }
        await tile(shots, path.join(OUT, "sheets", `${scene.name}.png`), THEMES.length);
    }
} finally {
    await browser.close();
    server.close();
}
fs.writeFileSync(path.join(OUT, "audit.json"), JSON.stringify(report, null, 1));
const measured = new Set(report.map((e) => e.scene));
for (const scene of SCENES)
    if ((!ONLY || ONLY.has(scene.name)) && !measured.has(scene.name)) {
        console.error(`NO MEASUREMENTS for requested scene ${scene.name}`);
        process.exitCode = 1;
    }
const failedSetups = report.filter((e) => e.setupError);
if (failedSetups.length) {
    for (const e of failedSetups) console.error(`SETUP FAILED ${e.scene} ${e.w} ${e.theme}: ${e.setupError}`);
    process.exitCode = 1;
}
console.log(`wrote ${path.join(OUT, "audit.json")}`);
