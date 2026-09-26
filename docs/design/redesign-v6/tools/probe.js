/*
 * probe.js — v6. One script, two sides.
 *
 * Design side: open any redesign-v6/static/*.html (or the artifact) and run it. It walks [data-spec].
 * Live side:   open the running app, paste component-map.json as `window.MAP = {...}`, run it.
 *              It walks every map entry's selector (implemented entries) AND its `suggested`
 *              selector (new entries), so a freshly implemented .mj_TurnCard is picked up.
 * Census:      set `window.PROBE_CENSUS = true` first to also dump every distinct
 *              font / spacing / radius value on the page with a few example classes.
 * Output is JSON on stdout and the return value. Nothing is pre-dumped: one render → true numbers.
 */
(() => {
  const PROPS = ["font", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color", "backgroundColor", "backgroundImage",
    "borderTopWidth", "borderTopStyle", "borderTopColor", "borderRadius", "padding", "margin", "gap", "display", "gridTemplateColumns",
    "width", "height", "minHeight", "maxWidth", "opacity", "outline", "outlineOffset", "boxShadow", "overflow", "textOverflow", "whiteSpace",
    "transitionProperty", "transitionDuration", "animationName", "animationDuration"];
  const pick = (el) => {
    const cs = getComputedStyle(el), out = {};
    for (const p of PROPS) { const v = cs[p]; if (v && !["none", "normal", "auto", "0px", "0s"].includes(v)) out[p] = v; }
    const r = el.getBoundingClientRect();
    out._box = { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    if (el.scrollWidth > el.clientWidth + 1) out._overflowsX = el.scrollWidth - el.clientWidth;
    return out;
  };
  const firstSel = (s) => String(s || "").split(/\s*(?:→|\(| — |,|\+ )/)[0].trim();
  const meta = document.querySelector('meta[name="matron-state"]');
  const TOKENS = ["--cpd-color-bg-app", "--cpd-color-bg-room-canvas", "--cpd-color-bg-canvas-default", "--cpd-color-bg-canvas-raised", "--cpd-color-bg-subtle-primary", "--cpd-color-bg-subtle-secondary", "--cpd-color-text-primary", "--cpd-color-text-secondary", "--cpd-color-text-tertiary", "--cpd-color-text-action-accent", "--cpd-color-text-critical-primary", "--cpd-color-usage-medium", "--cpd-color-border-subtle", "--cpd-color-border-strong", "--cpd-state-hover", "--cpd-state-selected", "--mj-warn-ink", "--mj-warn-dot", "--mj-warn-tint", "--mj-accent-border", "--mj-critical-tint", "--mj-critical-border", "--mj-live-xfade", "--mj-live-min-interval", "--mj-card-expand", "--mj-deep-open", "--mj-resolve", "--mj-bp-pane-narrow", "--mj-bp-pane-medium"];
  const root = getComputedStyle(document.documentElement);
  const result = {
    mode: typeof MAP !== "undefined" && MAP ? "live" : "design",
    state: meta ? meta.content : location.pathname + location.hash,
    note: document.querySelector('meta[name="matron-state-note"]')?.content || null,
    theme: document.documentElement.dataset.theme || null,
    pane: document.querySelector("[data-chat-pane], .mx_RoomView_body")?.getAttribute("data-pane") || null,
    viewport: { w: innerWidth, h: innerHeight },
    tokens: Object.fromEntries(TOKENS.map((n) => [n, root.getPropertyValue(n).trim()]).filter(([, v]) => v)),
  };
  if (result.mode === "design") {
    result.specimens = [...document.querySelectorAll("[data-spec]")].filter((el) => !el.closest(".mv6-dev")).map((el) => ({
      spec: el.dataset.spec, tag: el.tagName.toLowerCase(), cls: el.className && el.className.baseVal === undefined ? String(el.className) : null,
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80), computed: pick(el),
      forced: [...el.querySelectorAll(".is-hover,.is-focus")].map((x) => x.className).slice(0, 4),
    }));
  } else {
    result.specimens = MAP.components.filter((c) => c.status !== "devtool").map((c) => {
      const sel = firstSel(c.status === "implemented" ? c.selector : c.suggested || c.selector);
      let el = null; try { el = document.querySelector(sel); } catch { /* prose selector */ }
      return { spec: c.spec, status: c.status, selector: sel, found: !!el, visualClaim: c.visual || null, compare: c.compare || MAP.defaults.compare, computed: el ? pick(el) : null };
    });
  }
  if (typeof PROBE_CENSUS !== "undefined" && PROBE_CENSUS) {
    const T = { font: {}, spacing: {}, radius: {} };
    const add = (k, v, c) => { if (!v || ["0px", "normal", "auto"].includes(v)) return; (T[k][v] = T[k][v] || { n: 0, where: [] }).n++; if (T[k][v].where.length < 3 && !T[k][v].where.includes(c)) T[k][v].where.push(c); };
    document.querySelectorAll("body *").forEach((el) => {
      if (el.closest("svg,.mv6-dev")) return;
      const cs = getComputedStyle(el); if (cs.display === "none") return;
      const c = typeof el.className === "string" ? el.className.split(" ")[0] || el.tagName : el.tagName;
      if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) add("font", `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily.split(",")[0]}`, c);
      ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap", "columnGap"].forEach((p) => add("spacing", cs[p], c));
      add("radius", cs.borderTopLeftRadius, c);
    });
    result.census = { distinct: { font: Object.keys(T.font).length, spacing: Object.keys(T.spacing).length, radius: Object.keys(T.radius).length }, ...T };
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
})();
