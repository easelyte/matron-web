/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Auto-diff: design intent vs live app, both measured — no eyeballing.
 * - Design side: probe redesign-v5/static/*.html by data-spec (the designer's values).
 * - Live side: render the real MatronApp fixture and probe component-map.json's selectors.
 * Matches by spec name, diffs the load-bearing props, prints only mismatches.
 *
 * Run:  pnpm build:fixtures && node scripts/visual/diff.mjs
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const ROOT = process.cwd();
const DIST = path.join(ROOT, ".fixtures-dist");
const PKG = path.join(ROOT, "docs/design/redesign-v5");
const MAP = JSON.parse(fs.readFileSync(path.join(PKG, "component-map.json"), "utf8"));

// Load-bearing props to compare. Skip fontFamily (design pulls Inter/Fira from a CDN that
// won't load headless → fallback metrics differ; weight/size/line-height still resolve).
const CMP = [
    "fontWeight",
    "fontSize",
    "lineHeight",
    "color",
    "backgroundColor",
    "borderTopWidth",
    "borderTopStyle",
    "borderTopColor",
    "borderRadius",
];

const PROBE = (props) => `(() => {
  const P = ${JSON.stringify(props)};
  const pick = (el) => { const cs = getComputedStyle(el); const o = {}; for (const p of P) o[p] = cs[p]; return o; };
  return { specimens: [...document.querySelectorAll('[data-spec]')].map(el => ({ spec: el.dataset.spec, computed: pick(el) })) };
})()`;

const LIVEPROBE = (props, map) => `(() => {
  const P = ${JSON.stringify(props)}; const MAP = ${JSON.stringify(map)};
  const pick = (el) => { const cs = getComputedStyle(el); const o = {}; for (const p of P) o[p] = cs[p]; return o; };
  const first = (sel) => sel.split(/\\s*(?:→|\\/|\\(|,)/)[0].trim();
  return { specimens: MAP.components.filter(c => c.selector && c.selector !== '—').map(c => {
    let el = null; try { el = document.querySelector(first(c.selector)); } catch {}
    return { spec: c.spec, selector: first(c.selector), found: !!el, visual: c.visual || null, computed: el ? pick(el) : null };
  }) };
})()`;

const MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".json": "application/json",
};
function serve(dir) {
    return new Promise((r) => {
        const s = http.createServer((q, res) => {
            const u = decodeURIComponent(q.url.split("?")[0]);
            const f = path.join(dir, u === "/" ? "index.html" : u);
            fs.readFile(f, (e, d) => {
                if (e) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
                res.end(d);
            });
        });
        s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
    });
}

const b = await chromium.launch({ args: ["--no-sandbox"] });

// Design specimens (merge the chrome + states files; last wins on dup spec).
const design = {};
for (const f of ["light-default", "light-states"]) {
    const p = await b.newPage();
    await p.goto("file://" + path.join(PKG, "static", f + ".html"), { waitUntil: "load" });
    const r = await p.evaluate(PROBE(CMP));
    for (const s of r.specimens) design[s.spec] = s.computed;
    await p.close();
}

// Live specimens via the map selectors.
const { s: server, port } = await serve(DIST);
const lp = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
await lp.goto(`http://127.0.0.1:${port}/?theme=light`, { waitUntil: "networkidle" });
await lp.evaluate(() => document.fonts.ready);
const live = {};
const liveRes = await lp.evaluate(LIVEPROBE(CMP, MAP));
for (const s of liveRes.specimens) live[s.spec] = s;
await lp.close();
await b.close();
server.close();

// Diff: for every spec present on BOTH sides, compare props.
const rows = [];
for (const spec of Object.keys(design)) {
    const l = live[spec];
    if (!l) continue; // spec has no live selector (new/devtool/prose) — not diffable here
    if (!l.found) {
        rows.push({ spec, status: "NOT-FOUND-LIVE", selector: l.selector });
        continue;
    }
    const diffs = [];
    for (const p of CMP) {
        const dv = design[spec]?.[p],
            lv = l.computed?.[p];
        if (dv && lv && dv !== lv) diffs.push(`${p}: design[${dv}] vs live[${lv}]`);
    }
    if (diffs.length) rows.push({ spec, visualClaim: l.visual, diffs });
}

console.log("=== DESIGN ↔ LIVE auto-diff (light) — mismatches only ===\n");
if (!rows.length) console.log("no mismatches on compared props.");
for (const r of rows) {
    if (r.status) {
        console.log(`⚠ ${r.spec} — ${r.status} (${r.selector})`);
        continue;
    }
    console.log(`● ${r.spec}${r.visualClaim ? "  [map: " + r.visualClaim + "]" : ""}`);
    for (const d of r.diffs) console.log(`    ${d}`);
}
const diffable = Object.keys(design).filter((s) => live[s]?.found).length;
console.log(`\ncompared ${diffable} specs present on both sides; ${rows.length} with mismatches.`);
