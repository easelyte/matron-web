/* Matron redesign v6 — interactivity for the clickable artifact (not part of the handoff CSS). */
(function () {
  const M = window.MV6;
  const root = document.getElementById("mv6-root");
  const devRoot = document.getElementById("mv6-dev");
  let st, presetId = null, devOpen = false, timers = [], lastLiveChange = 0;

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const clearTimers = () => { timers.forEach(clearTimeout); timers.forEach(clearInterval); timers = []; };
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));

  function fromHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    const p = M.PRESETS.find((x) => x.id === h.get("state"));
    presetId = p ? p.id : null;
    st = p ? M.stateFor(p, h.get("theme")) : { ...clone(M.BASE), theme: h.get("theme") || "light" };
  }
  function toHash() { history.replaceState(null, "", `#${presetId ? `state=${presetId}&` : ""}theme=${st.theme}`); }

  /* focus key → selector, so focus returns to the element that opened a thing (§ a11y) */
  let focusSel = null;
  const keyOf = (el) => {
    if (!el || !el.dataset) return null;
    const d = el.dataset, parts = [];
    ["act", "turn", "group", "step", "from", "menu", "folder", "agent"].forEach((k) => d[k] && parts.push(`[data-${k}="${d[k]}"]`));
    return parts.length ? parts.join("") : null;
  };

  function render(opts = {}) {
    document.documentElement.dataset.theme = st.theme;
    const panel = root.querySelector(".mx_RoomView_messagePanel");
    const prevScroll = panel ? panel.scrollTop : null;
    const active = document.activeElement;
    const sel = focusSel || (root.contains(active) ? keyOf(active) : null);
    focusSel = null;
    root.innerHTML = M.renderApp(st);
    const np = root.querySelector(".mx_RoomView_messagePanel");
    if (np) {
      if (opts.scroll === "keep" && prevScroll !== null) np.scrollTop = prevScroll;
      else {
        const open = np.querySelector(".mj_TurnCard_deep") || np.querySelector(".mj_TurnCard_group.is-open") || np.querySelector(".mj_TurnCard.is-open");
        np.scrollTop = open && opts.scroll !== "bottom" ? Math.max(0, open.getBoundingClientRect().top - np.getBoundingClientRect().top + np.scrollTop - 120) : np.scrollHeight;
      }
    }
    if (sel) { const el = root.querySelector(sel); if (el) el.focus({ preventScroll: true }); }
    if (st.modal) { const first = root.querySelector('[role="dialog"] .mj_FolderOption[aria-checked="true"], [role="dialog"] .mj_UploadConfirm_send'); if (first && !root.querySelector('[role="dialog"]').contains(document.activeElement)) first.focus({ preventScroll: true }); }
    runXfade();
    observePane();
    renderDev();
    toHash();
  }

  /* live-line cross-fade: outgoing and incoming stacked in one grid cell */
  function runXfade() {
    const out = root.querySelector('[data-xfade="out"]'), inn = root.querySelector('[data-xfade="in"]');
    if (!out || !inn || presetId === "card-collapsed-running") return;
    out.classList.remove("is-mid"); inn.classList.remove("is-mid"); inn.classList.add("is-out");
    void inn.offsetWidth;
    out.classList.add("is-out"); inn.classList.remove("is-out");
    later(260, () => { st.live.xfade = false; const o = root.querySelector('[data-xfade="out"]'); if (o) o.remove(); });
  }

  /* the chat pane is the measured element (ResizeObserver), not the viewport */
  let ro;
  function observePane() {
    if (ro) ro.disconnect();
    const pane = root.querySelector("[data-chat-pane]");
    if (!pane || !window.ResizeObserver) return;
    ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      const v = w <= 480 ? "narrow" : w <= 760 ? "medium" : "wide";
      if (pane.dataset.pane !== v) { pane.dataset.pane = v; st.pane = v; }
    });
    ro.observe(pane);
  }

  /* turn 2's scripted run: live line changes at most once per 1.2s */
  function setLive(idx) {
    const wait = Math.max(0, 1200 - (Date.now() - lastLiveChange));
    later(wait, () => {
      lastLiveChange = Date.now();
      st.live = { ...st.live, idx, xfade: true };
      if (idx === 2) st.live.elapsed = 30;
      render({ scroll: "keep" });
    });
  }
  function startRun() {
    clearTimers();
    st.tail = "t2run"; st.live = { idx: 0, xfade: false, elapsed: 0 };
    lastLiveChange = Date.now();
    render({ scroll: "bottom" });
    later(2400, () => setLive(1));
    later(4800, () => setLive(2));
    const tick = setInterval(() => {
      if (st.tail !== "t2run" || st.live.idx !== 2) return;
      st.live.elapsed += 1;
      const el = root.querySelector("[data-elapsed]");
      if (el) el.textContent = M.fmtElapsed(st.live.elapsed);
      else if (st.live.elapsed > 10) render({ scroll: "keep" });
      if (st.live.elapsed >= 48) finishRun();
    }, 1000);
    timers.push(tick);
  }
  function finishRun() {
    clearTimers();
    if (st.tail === "t2run") st.tail = "t2done";
    const wasQueued = st.browser === "queued";
    render({ scroll: "keep" });
    const card = root.querySelector('.mj_TurnCard[data-turn="t2"]');
    if (card) card.classList.add("is-resolved");
    if (wasQueued) restartBrowser();
  }
  function restartBrowser() {
    st.browser = "restarting";
    st.notices = [...(st.notices || []), M.fixtures.NOTICES.restarting];
    render({ scroll: "bottom" });
    later(2200, () => { st.browser = "on"; render({ scroll: "keep" }); });
  }

  const ui = (t) => (st.cards[t] = st.cards[t] || { open: false, groups: {}, all: {} });

  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || !root.contains(el)) { if (st.menu && !e.target.closest(".mj_HeaderMenu")) { st.menu = null; render({ scroll: "keep" }); } return; }
    const d = el.dataset, a = d.act;
    if (a === "scrim" && e.target !== el) return;
    presetId = null; st.force = {};
    if (a === "card") { const u = ui(d.turn); u.open = !u.open; }
    else if (a === "group") { const u = ui(d.turn); u.groups = u.groups || {}; u.groups[d.group] = !u.groups[d.group]; }
    else if (a === "deep") { const u = ui(d.turn); const same = u.deep === d.step && (u.deepFrom || "group") === (d.from || "group"); u.deep = same ? null : d.step; u.deepFrom = d.from || "group"; }
    else if (a === "deepClose") { const u = ui(d.turn); focusSel = `[data-act="deep"][data-step="${u.deep}"]`; u.deep = null; }
    else if (a === "all") { const u = ui(d.turn); u.all = u.all || {}; u.all[d.group] = true; }
    else if (a === "stop") { clearTimers(); st.tail = "t2stopped"; focusSel = '[data-act="card"][data-turn="t2"]'; }
    else if (a === "answer") { if (st.tail === "t3wait") st.tail = "t3done"; focusSel = ".mx_BasicMessageComposer_input"; }
    else if (a === "menu") { st.menu = st.menu === d.menu ? null : d.menu; if (!st.menu) focusSel = `[data-act="menu"][data-menu="${d.menu}"]`; }
    else if (a === "closeMenu") { focusSel = `[data-act="menu"][data-menu="${st.menu}"]`; st.menu = null; }
    else if (a === "showWork") { st.showWork = !st.showWork; focusSel = '[data-act="showWork"]'; }
    else if (a === "session") { st.session = d.session; st.menu = null; }
    else if (a === "browserConfirm") { st.menu = null; st.modal = "browser"; }
    else if (a === "closeModal" || a === "scrim") { focusSel = st.modal === "sheet" ? '[data-act="sheet"]' : '[data-act="menu"][data-menu="session"]'; st.modal = null; }
    else if (a === "browserGo") { st.modal = null; if (M.isBusy(st)) st.browser = "queued"; else { render({ scroll: "keep" }); restartBrowser(); return; } }
    else if (a === "browserNow") { st.modal = null; clearTimers(); if (M.isBusy(st)) st.tail = "t2stopped"; render({ scroll: "keep" }); restartBrowser(); return; }
    else if (a === "splitMain") { if (el.disabled) return; st.split = "starting"; render({ scroll: "keep" }); later(1500, () => { st.split = "idle"; render({ scroll: "keep" }); }); return; }
    else if (a === "sheet") { st.menu = null; st.modal = "sheet"; st.split = st.split === "error" ? "idle" : st.split; st.sheet = { folder: st.defaults.folder ?? 1, agent: st.defaults.agent || "claude", model: st.defaults.model || "opus", browser: false, task: "", remember: false, boxes: 1 }; }
    else if (a === "folder") { st.sheet.folder = d.folder === "other" ? "other" : +d.folder; st.sheet.folderError = false; if (d.folder === "other") focusSel = '[data-input="other"]'; }
    else if (a === "agent") { st.sheet.agent = d.agent; }
    else if (a === "sheetBrowser") { st.sheet.browser = !st.sheet.browser; }
    else if (a === "remember") { st.sheet.remember = el.checked; return; }
    else if (a === "sheetStart") {
      const sh = st.sheet;
      if (sh.folder === "other" && !M.FOLDERS.includes((sh.other || "").trim())) { sh.folderError = true; focusSel = '[data-input="other"]'; render({ scroll: "keep" }); return; }
      if (sh.remember && sh.folder !== "other") st.defaults = { known: true, folder: sh.folder, model: sh.model, agent: sh.agent };
      st.modal = null; st.split = "starting"; focusSel = '[data-act="splitMain"]';
      render({ scroll: "keep" }); later(1500, () => { st.split = "idle"; render({ scroll: "keep" }); }); return;
    }
    else if (a === "noop") return;
    render({ scroll: a === "card" || a === "group" || a === "deep" || a === "deepClose" || a === "all" ? "keep" : undefined });
  });
  root.addEventListener("input", (e) => {
    const k = e.target.dataset && e.target.dataset.input;
    if (!k || !st.sheet) return;
    if (k === "other") { st.sheet.other = e.target.value; if (st.sheet.folderError) { st.sheet.folderError = false; } }
    if (k === "task") st.sheet.task = e.target.value;
    if (k === "model") st.sheet.model = e.target.value;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (st.modal) { focusSel = st.modal === "sheet" ? '[data-act="sheet"]' : '[data-act="menu"][data-menu="session"]'; st.modal = null; }
    else if (st.menu) { focusSel = `[data-act="menu"][data-menu="${st.menu}"]`; st.menu = null; }
    else { const t = Object.keys(st.cards).find((k) => st.cards[k].deep); if (!t) return; focusSel = `[data-act="deep"][data-step="${st.cards[t].deep}"]`; st.cards[t].deep = null; }
    render({ scroll: "keep" });
  });

  /* ---------- devtool: the state matrix (do NOT implement) ---------- */
  function renderDev() {
    const groups = {};
    M.PRESETS.forEach((p) => (groups[p.group] = groups[p.group] || []).push(p));
    devRoot.innerHTML = `<div class="mv6-dev" data-spec="devtool.stateMatrix">${devOpen ? `<div class="mv6-dev_panel" role="dialog" aria-label="States">
<div class="mv6-dev_row"><button data-dev="theme" data-v="light" aria-pressed="${st.theme === "light"}">Light</button><button data-dev="theme" data-v="dark" aria-pressed="${st.theme === "dark"}">Dark</button><button data-dev="work" aria-pressed="${!!st.showWork}">Show the work</button><button data-dev="run">▶ Replay turn 2</button><button data-dev="reset">Reset</button></div>
${Object.entries(groups).map(([g, ps]) => `<h4>${g}</h4><div class="mv6-dev_list">${ps.map((p) => `<button data-dev="preset" data-id="${p.id}" aria-current="${presetId === p.id}">${p.label}</button>`).join("")}</div>`).join("")}</div>` : ""}
<button class="mv6-dev_btn" data-dev="toggle" aria-expanded="${devOpen}">states · ${M.PRESETS.length}</button></div>`;
  }
  devRoot.addEventListener("click", (e) => {
    const b = e.target.closest("[data-dev]");
    if (!b) return;
    const k = b.dataset.dev;
    if (k === "toggle") { devOpen = !devOpen; renderDev(); return; }
    if (k === "theme") { st.theme = b.dataset.v; render({ scroll: "keep" }); return; }
    if (k === "work") { st.showWork = !st.showWork; render({ scroll: "keep" }); return; }
    if (k === "run") { presetId = null; st.cards = {}; st.browser = st.browser === "on" ? "on" : "idle"; startRun(); return; }
    if (k === "reset") { clearTimers(); presetId = null; st = { ...clone(M.BASE), theme: st.theme }; render(); return; }
    if (k === "preset") { clearTimers(); const p = M.PRESETS.find((x) => x.id === b.dataset.id); presetId = p.id; st = M.stateFor(p, st.theme); render(); }
  });

  fromHash();
  render();
  window.addEventListener("hashchange", () => { fromHash(); render(); });
})();
