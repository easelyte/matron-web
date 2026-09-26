/* Matron redesign v6 — pure renderers: state → HTML string. No DOM access.
   Used by the interactive artifact and by the static exporter (same code, same output). */
(function (W) {
  const M = W.MV6;
  const F = M.fixtures;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- icons (24-unit stroke, currentColor) ---------- */
  const C = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
  const P = (...d) => d.map((x) => `<path d="${x}"/>`).join("");
  const ICONS = {
    check: P("M5 12.5l4.5 4.5L19 7.5"), chev: P("M6 9l6 6 6-6"), chevR: P("M9 6l6 6-6 6"), chevL: P("M15 6l-6 6 6 6"),
    file: P("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"),
    search: C(11, 11, 6) + P("M20 20l-4.5-4.5"), pencil: P("M4 20h4L19 9l-4-4L4 16z", "M14 6l4 4"),
    flask: P("M9 3h6", "M10 3v6L5 18a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3L14 9V3", "M7.5 14h9"),
    shield: P("M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z", "M9 12l2 2 4-4"),
    history: C(12, 12, 8) + P("M12 8v4l3 2"), branch: C(6, 6, 2) + C(6, 18, 2) + C(18, 8, 2) + P("M6 8v8", "M18 10a6 6 0 0 1-6 6H8"),
    helper: C(12, 8, 3.5) + P("M5 20c1-4 4-6 7-6s6 2 7 6"), globe: C(12, 12, 9) + P("M3 12h18", "M12 3c3 3 3 15 0 18c-3-3-3-15 0-18"),
    terminal: P("M4 5h16v14H4z", "M8 10l3 2-3 2", "M13 15h3"), dot: C(12, 12, 2),
    x: P("M6 6l12 12M18 6L6 18"), alert: C(12, 12, 9) + P("M12 7.5v5.5", "M12 16.5v.01"),
    dots: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
    gear: C(12, 12, 3) + P("M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"),
    user: C(12, 8, 3.5) + P("M5 20c1-4 4-6 7-6s6 2 7 6"), logout: P("M15 4h4v16h-4", "M10 16l-4-4 4-4", "M6 12h10"),
    pin: P("M12 17v5", "M8 3h8l-1 6 3 4H6l3-4z"), archive: P("M4 5h16v4H4z", "M6 9v10h12V9", "M10 13h4"),
    plus: P("M12 5v14M5 12h14"), chat: P("M5 5h14v10H9l-4 4z"), memory: P("M6 6h12v12H6z", "M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"),
    clip: P("M16 7l-7.5 7.5a2.1 2.1 0 0 0 3 3L19 10a4 4 0 0 0-5.7-5.7L5.8 11.8a6 6 0 0 0 8.5 8.5L20 14.5"),
    send: P("M4 12l16-8-6 16-2.5-6.5z"), mic: P("M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"),
    question: C(12, 12, 9) + P("M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14", "M12 17v.01"),
    image: P("M4 5h16v14H4z", "M20 16l-5-5-8 8") + C(9, 10, 1.5), rename: P("M4 20h16", "M6 16l9-9 3 3-9 9H6z"),
  };
  const icon = (n, cls = "") => `<svg class="i i-${n} ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ""}</svg>`;
  M.icon = icon;

  /* ---------- live-line helpers ---------- */
  const fmtElapsed = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
  M.fmtElapsed = fmtElapsed;

  /* ---------- the Under the hood card ---------- */
  function renderCard(turn, mode, st) {
    const ui = (st.cards && st.cards[turn.id]) || {};
    const running = mode === "running" || mode === "slow";
    const live = st.live || { idx: 2, elapsed: 42 };
    let items = turn.items, runStep = null, doneCount;
    if (running) {
      const script = turn.liveScript[Math.min(live.idx, turn.liveScript.length - 1)];
      items = turn.runningItems.slice(0, script.done + 1 + (turn.runningItems[0].kind === "narration" ? 0 : -1));
      runStep = { ...script.step, status: "running" };
      doneCount = M.stepsOf(items).length;
    } else if (mode === "waiting") {
      items = turn.items.slice(0, turn.waitingUntil);
    }
    const steps = M.stepsOf(items);
    const n = doneCount ?? steps.length;
    const issues = M.turnIssues(items) || !!turn.endError;
    const seq = M.groupTurn(items, running ? runStep : null);
    const files = M.changedFiles(items);
    const cls = ["mj_TurnCard", ui.open ? "is-open" : "", `mj_TurnCard_${mode}`].join(" ");
    const elapsed = mode === "slow" ? Math.max(live.elapsed, 304) : live.elapsed;

    let glyph, meta, liveTexts = null;
    if (running) {
      glyph = '<span class="mj_LiveDot" aria-hidden="true"></span>';
      const cur = M.liveLine(runStep);
      const prevScript = turn.liveScript[Math.max(0, live.idx - 1)];
      const prev = live.xfade && live.idx > 0 ? M.liveLine(prevScript.step) : null;
      liveTexts = prev
        ? `<span class="mj_TurnCard_liveText is-mid" aria-hidden="true" data-xfade="out">${esc(prev)}</span><span class="mj_TurnCard_liveText is-mid" data-xfade="in">${esc(cur)}</span>`
        : `<span class="mj_TurnCard_liveText">${esc(cur)}</span>`;
      meta = `<span class="sep">·</span><span class="mj_TurnCard_live">${liveTexts}</span>${elapsed > 10 ? `<span class="sep">·</span><span class="mj_TurnCard_elapsed" data-elapsed>${fmtElapsed(elapsed)}</span>` : ""}`;
    } else if (mode === "waiting") {
      glyph = '<span class="mj_TurnCard_dot mj_TurnCard_dot_wait" aria-hidden="true"></span>';
      meta = `<span class="sep">·</span><span class="mj_TurnCard_live"><span class="mj_TurnCard_liveText">Waiting for you</span></span>`;
    } else if (mode === "stopped") {
      glyph = '<span class="mj_TurnCard_dot mj_TurnCard_dot_warn" aria-hidden="true"></span>';
      meta = `<span class="sep">·</span><span>Stopped</span><span class="sep">·</span><span>${n} ${n === 1 ? "step" : "steps"}</span>`;
    } else {
      glyph = issues ? '<span class="mj_TurnCard_dot mj_TurnCard_dot_warn" aria-hidden="true"></span>' : icon("check");
      meta = `<span class="sep">·</span><span>${n} ${n === 1 ? "step" : "steps"}</span><span class="sep mj_TurnCard_elapsedTotal">·</span><span class="mj_TurnCard_elapsedTotal">${M.fmtDur(turn.durationMs)}</span>`;
    }
    const srStatus = running ? `Working: ${M.liveLine(runStep)}` : mode === "waiting" ? "Waiting for you" : issues ? `Done with a problem along the way, ${n} steps` : `Done, ${n} steps`;
    const f = st.force || {};
    const head = `<div class="mj_TurnCard_row">
<button class="mj_TurnCard_toggle${f.cardHover === turn.id ? " is-hover" : ""}${f.cardFocus === turn.id ? " is-focus" : ""}" data-act="card" data-turn="${turn.id}" aria-expanded="${!!ui.open}" aria-controls="tc-${turn.id}-body">
<span class="mj_TurnCard_glyph">${glyph}</span><span class="mj_TurnCard_title" data-spec="turn.card.title">Under the hood</span>
<span class="mj_TurnCard_meta" role="status" aria-live="polite" aria-atomic="true" data-spec="turn.card.liveLine"><span class="mj_Sr">${esc(srStatus)}. </span>${meta}</span>
<span>${mode === "slow" ? '<span class="mj_TurnCard_stopSpace" aria-hidden="true">Stop</span>' : ""}</span>${icon("chev", "mj_TurnCard_chevron")}</button>
${mode === "slow" ? `<button class="mj_TurnCard_stop" data-act="stop" data-turn="${turn.id}">Stop</button>` : ""}</div>`;
    if (!ui.open) return `<section class="${cls}" data-spec="turn.card" data-turn="${turn.id}" aria-label="Under the hood">${head}</section>`;

    const body = [];
    if (files.length) {
      const fcap = ui.all && ui.all.files ? files.length : 5;
      body.push(`<div class="mj_TurnCard_changed" data-spec="turn.card.changedFiles"><div class="mj_TurnCard_label">Changed files</div>${files.slice(0, fcap)
        .map((fl) => {
          const open = ui.deep === fl.stepId && ui.deepFrom === "files";
          const step = steps.find((s) => s.id === fl.stepId);
          return `<button class="mj_TurnCard_file" data-act="deep" data-from="files" data-turn="${turn.id}" data-step="${fl.stepId}" aria-expanded="${open}" title="${esc(fl.path)}">${icon("file", "mj_TurnCard_icon")}<span class="mj_TurnCard_name">${esc(fl.name)}</span><span class="mj_TurnCard_counts"><span class="add">+${fl.added}</span><span class="del">−${fl.removed}</span></span>${icon("chevR", "mj_TurnCard_go")}</button>${open ? renderDeep(turn, step, [step], "files") : ""}`;
        })
        .join("")}${files.length > fcap ? `<button class="mj_TurnCard_more" data-act="all" data-turn="${turn.id}" data-group="files">Show all ${files.length} files</button>` : ""}</div>`);
    }
    seq.forEach((g) => {
      if (g.type === "narration") { body.push(`<p class="mj_TurnCard_narration">${esc(g.text)}</p>`); return; }
      const open = ui.groups && ui.groups[g.id];
      const statusGlyph = g.status === "ok" ? `<span class="mj_TurnCard_status mj_TurnCard_status_ok" aria-label="done">${icon("check")}</span>`
        : g.status === "recovered" ? `<span class="mj_TurnCard_status" aria-label="failed, then fixed"><span class="mj_TurnCard_dot mj_TurnCard_dot_warn"></span></span>`
        : g.status === "failed" ? `<span class="mj_TurnCard_status mj_TurnCard_status_failed" aria-label="failed">${icon("x")}</span>`
        : `<span class="mj_TurnCard_status" aria-label="in progress"><span class="mj_LiveDot"></span></span>`;
      const outcome = g.outcomeText ? `<span class="mj_TurnCard_outcome">: ${esc(g.outcomeText)}</span>` : "";
      const k = g.steps.length;
      const cap = ui.all && ui.all[g.id] ? k : 12;
      const list = open
        ? `<ul class="mj_TurnCard_steps" id="tc-${g.id}">${g.steps.slice(0, cap).map((s, i) => {
            const dOpen = ui.deep === s.id && ui.deepFrom !== "files";
            const note = s.status === "failed" ? '<span class="mj_TurnCard_stepNote mj_TurnCard_stepNote_failed">failed</span>' : s.status === "running" ? '<span class="mj_TurnCard_stepNote">now</span>' : "<span></span>";
            const sentence = i > 0 && M.stepSentence(g.steps[i - 1]) === M.stepSentence(s) ? `${M.stepSentence(s)} again` : M.stepSentence(s);
            return `<li><button class="mj_TurnCard_step${f.stepHover === s.id ? " is-hover" : ""}" data-spec="turn.card.step" data-act="deep" data-turn="${turn.id}" data-step="${s.id}" data-group="${g.id}" aria-expanded="${dOpen}" ${s.status === "running" ? "disabled" : ""}><span class="mj_TurnCard_name" title="${esc(s.input.path || s.input.command || "")}">${esc(sentence)}</span>${note}${s.status === "running" ? "<span></span>" : icon("chevR", "mj_TurnCard_go")}</button>${dOpen ? renderDeep(turn, s, g.steps, "group") : ""}</li>`;
          }).join("")}${k > cap ? `<li><button class="mj_TurnCard_more" data-act="all" data-turn="${turn.id}" data-group="${g.id}">Show all ${k}</button></li>` : ""}</ul>`
        : "";
      body.push(`<div class="mj_TurnCard_group mj_TurnCard_group_${g.status}${open ? " is-open" : ""}" data-spec="turn.card.group" data-group="${g.id}"><button class="mj_TurnCard_groupRow${f.groupHover === g.id ? " is-hover" : ""}" data-act="group" data-turn="${turn.id}" data-group="${g.id}" aria-expanded="${!!open}" aria-controls="tc-${g.id}">${icon(g.icon, "mj_TurnCard_icon")}<span class="mj_TurnCard_sentence">${esc(g.sentence)}${outcome}</span>${statusGlyph}<span class="mj_TurnCard_count">${k} ${k === 1 ? "step" : "steps"}</span>${icon("chev", "mj_TurnCard_chevron")}</button>${list}</div>`);
    });
    if (running) body.push(`<div class="mj_TurnCard_now" aria-hidden="true"><span class="mj_TurnCard_glyph"><span class="mj_LiveDot"></span></span><span>${esc(M.liveLine(runStep))}</span></div>`);
    return `<section class="${cls}" data-spec="turn.card" data-turn="${turn.id}" aria-label="Under the hood">${head}<div class="mj_TurnCard_body" id="tc-${turn.id}-body">${body.join("")}</div></section>`;
  }

  /* ---------- deep detail (the only level with mono + exit codes) ---------- */
  function toolCard(s, open = true) {
    const bash = s.tool === "Bash";
    const cmdText = bash ? `$ ${s.input.command}` : `${s.tool} ${s.input.path || s.input.pattern || s.input.url || ""}`.trim();
    const failed = s.status === "failed";
    const badge = typeof s.exit === "number" ? `<span class="mj_ToolBadge${failed ? " mj_ToolBadge_failed" : ""}">exit ${s.exit}</span>` : "";
    const out = s.output ?? (s.tool === "Read" ? `${s.input.path}${s.input.note ? ` · ${s.input.note}` : ""}\n(file contents are not kept in the journal)` : s.tool === "Grep" ? `${s.input.pattern}: matches in 4 files` : "done");
    return `<details class="mj_ToolCard${failed ? " mj_ToolCard_failed" : ""}"${open ? " open" : ""}><summary>${icon("chev", "mj_ToolCard_chevron")}<code>${esc(cmdText)}</code><span class="mj_ToolCard_spacer"></span>${badge}<span class="mj_ToolTime">${M.fmtDur(s.ms)}</span></summary><pre class="mj_TurnCard_pre">${esc(out)}</pre>${s.fullBytes ? `<div class="mj_ToolCard_foot"><span>Preview · ${(s.fullBytes / 1024).toFixed(0)} KB total</span><button class="mj_ToolCard_load" data-act="noop">Load full output</button></div>` : ""}</details>`;
  }
  function diffCard(s) {
    return `<div class="mj_DiffCard"><div class="mj_DiffCard_header"><span class="mj_DiffCard_filename">${esc(s.input.path)}</span><span class="mj_DiffCard_added">+${s.added}</span><span class="mj_DiffCard_removed">−${s.removed}</span></div><div class="mj_DiffCard_body mj_TurnCard_pre"><div class="mj_DiffCard_track">${(s.diff || []).map(([t, l]) => `<span class="mj_DiffLine_${t}">${t === "add" ? "+" : t === "del" ? "-" : t === "ctx" ? " " : ""}${esc(l)}</span>`).join("")}</div></div></div>`;
  }
  function renderDeep(turn, s, groupSteps, from) {
    const c = M.classify(s).key;
    let kind, content, meta = M.fmtDur(s.ms);
    if (c === "change") { kind = "diff"; content = diffCard(s); meta = ""; }
    else if (c === "helper") {
      kind = "helper";
      const h = s.helper || {};
      content = `<div class="mj_TurnCard_helper"><p>${esc(h.summary || s.input.description)}</p><span class="mj_TurnCard_helperMeta">${esc(h.name)} · ${esc(h.kind || "claude")} · ${esc(h.status || "")}</span><button class="mj_TurnCard_helperOpen" data-act="noop">Open helper ${icon("chevR")}</button></div>`;
    } else {
      kind = "command";
      content = toolCard(s);
      if (s.status === "failed") {
        const i = groupSteps.indexOf(s);
        const rerun = groupSteps.slice(i + 1).find((x) => x.status === "ok" && M.cmd(x) === M.cmd(s));
        if (rerun) content += toolCard(rerun);
      }
    }
    return `<div class="mj_TurnCard_deep" data-spec="turn.card.deep.${kind}"><div class="mj_TurnCard_deepHead"><button class="mj_TurnCard_back" data-act="deepClose" data-turn="${turn.id}" data-step="${s.id}">${icon("chevL")}${from === "files" ? "Back to files" : "Back to steps"}</button><span class="mj_TurnCard_deepMeta">${esc(meta)}</span></div>${content}</div>`;
  }
  M.renderCard = renderCard;

  /* ---------- break-throughs (existing full cards) ---------- */
  function renderBreak(b, pending, st) {
    if (b.type === "permission" || b.type === "question") {
      const perm = b.type === "permission";
      const answered = !pending && b.answered;
      const actions = answered
        ? `<div class="mj_PromptResolved"><span class="mj_PromptGlyph mj_PromptGlyph_ok">${icon("check")}</span><span class="mj_Answered">${esc(b.answered)}</span></div>`
        : `<div class="mj_PromptOptions">${b.options.map((o, i) => `<button class="${i === 0 ? "mj_PromptOption_affirmative" : ""}" data-act="answer" data-break="${b.id}" data-answer="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
      return `<div class="mj_PromptCard${perm ? " mj_PromptCard_permission" : ""}" ${pending && perm ? 'role="alert"' : ""}><div class="mj_PromptHeader"><span class="mj_PromptLabel">${perm ? "Permission request" : "Question"}</span><span class="mj_PromptTime">${esc(b.time)}</span></div><div class="mj_PromptBody"><span class="mj_PromptGlyph">${icon(perm ? "shield" : "question")}</span><span class="mj_PromptQuestion">${esc(b.question)}</span>${b.detail ? `<span class="mj_PromptDetail">${esc(b.detail)}</span>` : ""}</div>${actions}</div>`;
    }
    if (b.type === "image") return `<figure class="mj_Image"><div class="mv6_ImageStandIn">screenshot · ${esc(b.name)}</div><figcaption>${esc(b.name)} · ${b.w}×${b.h}</figcaption></figure>`;
    if (b.type === "file") return `<a class="mj_File" href="#">${icon("file")}<span class="mj_FileName">${esc(b.name)}</span><span class="mj_FileSize">${esc(b.size)}</span></a>`;
    if (b.type === "item") return `<div class="mv6_ItemCardStandIn" data-standin="ItemCard (src/journal/tracker/cards.tsx)"><span class="mv6_ItemCardStandIn_glyph">${icon("question")}</span><span class="mv6_ItemCardStandIn_title"><span>Question #${b.num} · </span>${esc(b.title)}</span><span class="mv6_NeedsYouStandIn">${esc(b.status)}</span></div>`;
    if (b.type === "helper") return `<div class="mj_SpawnOutcomeRow mj_SpawnOutcomeRow_started"><span class="mj_SpawnOutcomeRow_rail"></span><span class="mj_SpawnOutcomeRow_text"><span class="mj_SpawnOutcomeRow_eyebrow">Subagent · ${esc(b.kind)}</span><b>${esc(b.name)}</b> started</span><button class="mj_SpawnOpenButton" data-act="noop">Open</button></div>`;
    return "";
  }

  /* ---------- turns ---------- */
  const profile = (time) => `<div class="mx_DisambiguatedProfile"><span class="mj_MsgAvatar" aria-hidden="true"></span><span>Claude</span><time>${esc(time)}</time></div>`;
  const opTile = (turn) => `<li class="mx_EventTile" data-layout="bubble" data-self="true"><div class="mx_EventTile_line">${esc(turn.user)}</div></li>`;
  const answer = (paras) => (paras.length ? `<div class="mj_Markdown">${paras.map((p) => `<p>${p}</p>`).join("")}</div>` : "");

  function renderTurn(turn, mode, st) {
    const blocks = [];
    const running = mode === "running" || mode === "slow";
    const breaks = turn.items.filter((i) => i.kind === "break");
    const visibleBreaks = mode === "waiting" ? breaks.filter((b) => turn.items.indexOf(b) <= turn.waitingUntil) : running ? [] : breaks;
    if (st.showWork) {
      const src = running ? turn.runningItems : mode === "waiting" ? turn.items.slice(0, turn.waitingUntil + 1) : turn.items;
      src.forEach((it) => {
        if (it.kind === "narration") blocks.push(answer([esc(it.text)]));
        else if (it.kind === "step") blocks.push(M.classify(it).key === "change" ? diffCard(it) : toolCard(it, false));
        else blocks.push(renderBreak(it, mode === "waiting" && turn.items.indexOf(it) === turn.waitingUntil, st));
      });
      if (running) blocks.push('<div class="mj_Activity" role="status"><span></span><span></span><span></span>Thinking</div>');
      if (turn.endError) blocks.push(answer([esc(turn.endError)]));
    } else {
      if (M.stepsOf(turn.items).length) blocks.push(renderCard(turn, mode, st));
      visibleBreaks.forEach((b) => blocks.push(renderBreak(b, mode === "waiting" && turn.items.indexOf(b) === turn.waitingUntil, st)));
      if (turn.endError && mode === "done") blocks.push(`<div class="mj_TurnError" role="alert" data-spec="turn.errorRow">${icon("alert")}<span>${esc(turn.endError)}</span></div>`);
    }
    if (mode === "done" || mode === "stopped") blocks.push(answer(turn.answer));
    return opTile(turn) + `<li class="mx_EventTile" data-self="false" data-turn="${turn.id}">${profile(turn.time)}<div class="mx_EventTile_line">${blocks.join("")}</div></li>`;
  }
  const notice = (text, st) =>
    st.showWork
      ? `<li class="mx_EventTile" data-self="false">${profile("")}<div class="mx_EventTile_line">${answer([esc(text)])}</div></li>`
      : `<li class="mj_SystemNotice" data-spec="thread.systemNotice">${esc(text)}</li>`;
  const peer = (p) => `<li class="mx_EventTile" data-self="false"><div class="mx_EventTile_line"><div class="mj_PeerMessage"><div class="mj_PeerMessage_head">${icon("helper", "mj_PeerMessage_mark")}<span class="mj_PeerMessage_name">${esc(p.from)}</span><span class="mj_PeerMessage_tag">${esc(p.kind)}</span><span class="mj_PeerMessage_time">${esc(p.time)}</span></div><div class="mj_PeerMessage_body">${esc(p.body)}</div></div></div></li>`;

  /* tails = which slice of the six-turn thread is on screen, and each turn's mode */
  const TAILS = {
    full: [["t1", "done"], ["t2", "done"], ["t3", "done"], ["t4", "done"], ["peer"], ["t5", "done"], ["n:compacted"], ["n:idle"], ["t6", "done"]],
    t1: [["t1", "done"]],
    t2run: [["t1", "done"], ["t2", "running"]],
    t2slow: [["t1", "done"], ["t2", "slow"]],
    t2stopped: [["t1", "done"], ["t2", "stopped"]],
    t2done: [["t1", "done"], ["t2", "done"]],
    t3wait: [["t2", "done"], ["t3", "waiting"]],
    t3done: [["t2", "done"], ["t3", "done"]],
    t4: [["t4", "done"], ["peer"], ["t5", "done"], ["n:compacted"], ["n:idle"]],
    t5: [["t5", "done"]],
    t210: [["t210", "done"]],
  };
  M.TAILS = TAILS;
  const TURN = { t1: F.T1, t2: F.T2, t3: F.T3, t4: F.T4, t5: F.T5, t6: F.T6, t210: F.T210 };
  M.TURN = TURN;
  M.isBusy = (st) => (TAILS[st.tail] || []).some(([, m]) => m === "running" || m === "slow");

  function renderThread(st) {
    const rows = (TAILS[st.tail] || TAILS.full).map(([id, mode]) => {
      if (id === "peer") return peer(F.PEER);
      if (id.startsWith("n:")) return notice(F.NOTICES[id.slice(2)], st);
      return renderTurn(TURN[id], mode, st);
    });
    (st.notices || []).forEach((n) => rows.push(notice(n, st)));
    return `<ol class="mx_RoomView_MessageList" aria-live="polite">${rows.join("")}</ol>`;
  }

  /* ---------- sidebar ---------- */
  const FOLDERS = ["/opt/matron-web", "/home/user/workspace", "/opt/matron-bridge", "/opt/tracker-sync", "/home/user/notes", "/srv/deploy", "/opt/matron-web/docs", "/opt/codex-sandbox", "/home/user/scratch", "/srv/backups", "/opt/matron-infra", "/home/user/projects/clients/northwind/2026-q3/redesign-archive/exports"];
  M.FOLDERS = FOLDERS;
  const DEFAULT_FOLDER = 1;
  const MODELS = [["opus", "Opus 4.5"], ["sonnet", "Sonnet 4.5"], ["haiku", "Haiku 4.5"]];
  M.splitHint = (st) => {
    const d = st.defaults || {};
    if (!d.known) return "";
    const agent = d.agent === "codex" ? "Codex" : (MODELS.find((m) => m[0] === d.model) || MODELS[0])[1].split(" ")[0];
    return `${agent} · ${M.base(FOLDERS[d.folder ?? DEFAULT_FOLDER])}`;
  };

  function renderSplit(st) {
    const s = st.split || "idle", f = st.force || {};
    const hint = M.splitHint(st);
    const disabled = s === "starting" || s === "nobox";
    const main = s === "starting"
      ? `<span class="mj_Spinner" aria-hidden="true"></span><span class="mj_NewSessionSplit_label">Starting…</span>`
      : `${icon("pencil")}<span class="mj_NewSessionSplit_label">New session</span>${hint && s !== "nobox" ? `<span class="mj_NewSessionSplit_hint">${esc(hint)}</span>` : ""}`;
    const note = s === "error" ? `<div class="mj_NewSessionSplit_note mj_NewSessionSplit_note_error" role="alert">Couldn’t reach the box. <button data-act="splitMain">Retry</button> · <button data-act="sheet">Options</button></div>`
      : s === "uncertain" ? `<div class="mj_NewSessionSplit_note" role="status">May have started. <button data-act="noop">Check your list</button></div>`
      : s === "nobox" ? `<div class="mj_NewSessionSplit_note">No box connected</div>` : "";
    const cls = (seg) => `${f.splitHover === seg ? " is-hover" : ""}${f.splitFocus === seg ? " is-focus" : ""}`;
    return `<div class="mj_NewSessionRow"><div class="mj_NewSessionSplit${s === "nobox" ? " mj_NewSessionSplit_disabled" : ""}" role="group" aria-label="New session">
<button class="mj_NewSessionButton mj_NewSessionSplit_main${cls("main")}" data-spec="sidebar.newSession.main" data-act="splitMain" aria-label="${s === "starting" ? "Starting a new session" : `Start a new session${hint ? `: ${hint}` : ""}`}" ${disabled ? "disabled" : ""}>${main}</button><span class="mj_NewSessionSplit_sep" aria-hidden="true"></span>
<button class="mj_NewSessionSplit_more${cls("more")}" data-spec="sidebar.newSession.more" data-act="sheet" aria-label="New session options" aria-haspopup="dialog" ${disabled ? "disabled" : ""}>${icon("dots")}</button></div>${note}</div>`;
  }

  function renderSidebar(st) {
    const busy = M.isBusy(st);
    const rows = [
      ["matron-web", busy ? "Running the tests…" : "Pushed fix/new-session-sheet", "10:44", st.session !== "codex", busy],
      ["↳ test triage", "Triaging 7 failing tests", "10:32", st.session === "codex", true],
      ["deploy", "Deployed rc.0 to staging", "09:12", false, false],
      ["tracker cleanup", "Closed 14 stale items", "Wed", false, false],
      ["docs pass", "Styling primitives v2 drafted", "Mon", false, false],
    ];
    return `<aside class="mx_LeftPanel" aria-label="Sessions"><div class="mj_RoomListHeader"><div class="mj_Wordmark"><img class="mj_WordmarkLogo" src="res/matron-logo-simple.svg" alt=""><h1>Matron</h1></div></div>${renderSplit(st)}
<nav class="mj_RoomList">${rows.map(([n, p, t, sel, run]) => `<button class="mj_RoomListItem${sel ? " mj_RoomListItem_selected" : ""}" data-act="session" data-session="${n.includes("triage") ? "codex" : "claude"}" ${sel ? 'aria-current="true"' : ""}><span class="mj_RoomListStatus${run ? " mj_RoomListStatus_running" : ""}"></span><span class="mj_RoomListText"><span class="mj_RoomListName">${esc(n)}</span><span class="mj_RoomListPreview">${esc(p)}</span></span><span class="mj_RoomListTime">${t}</span></button>`).join("")}</nav>
<div class="mj_SidebarFooter"><span class="mj_SidebarFooter_dot" aria-hidden="true"></span><span class="mj_SidebarFooter_text">Connected · box-1</span><button class="mj_IconButton" data-act="menu" data-menu="settings" aria-label="Settings" aria-haspopup="menu" aria-expanded="${st.menu === "settings"}">${icon("gear")}</button>${st.menu === "settings" ? renderSettings(st) : ""}</div></aside>`;
  }

  /* ---------- menus ---------- */
  const item = (ic, label, o = {}) => `<button class="mj_RoomItemMenu_item${o.cls || ""}" role="${o.role || "menuitem"}" ${o.checked !== undefined ? `aria-checked="${o.checked}"` : ""} ${o.disabled ? 'disabled aria-disabled="true"' : ""} data-act="${o.act || "closeMenu"}" ${o.spec ? `data-spec="${o.spec}"` : ""}>${icon(ic)}<span class="mj_MenuText"><span class="mj_MenuLabel">${label}</span>${o.hint ? `<span class="mj_MenuHint">${o.hint}</span>` : ""}</span>${o.after || ""}</button>`;
  function renderSettings(st) {
    const f = st.force || {};
    return `<div class="mj_HeaderMenu mj_RoomItemMenu mj_AccountMenu" role="menu" aria-label="Settings"><div class="mj_AccountMenu_who">${icon("user")}<div><b>operator</b><span>journal.example</span></div></div>
${item("chat", "Show the work", { role: "menuitemcheckbox", checked: !!st.showWork, act: "showWork", spec: "settings.showTheWork", cls: ` mj_RoomItemMenu_item_switch${f.menuFocus === "showWork" ? " is-focus" : ""}`, hint: "Show every step in the chat instead of tucking it under the hood", after: `<span class="mj_Switch${st.showWork ? " is-on" : ""}" aria-hidden="true"></span>` })}
<div class="mj_RoomItemMenu_sep" role="separator"></div>${item("logout", "Sign out")}</div>`;
  }
  function renderSessionMenu(st) {
    const b = st.browser || "idle", f = st.force || {};
    let bi;
    if (st.session === "codex") bi = item("globe", "Enable browser tools", { disabled: true, hint: "Not available for Codex sessions", spec: "sessionMenu.enableBrowser" });
    else if (b === "on") bi = item("check", "Browser tools on", { role: "menuitemcheckbox", checked: true, disabled: true, hint: "Screenshots and web pages are available", spec: "sessionMenu.enableBrowser" });
    else if (b === "queued") bi = item("globe", "Enable browser tools", { disabled: true, hint: "Restarting after this step", spec: "sessionMenu.enableBrowser" });
    else if (b === "restarting") bi = item("globe", "Enable browser tools", { disabled: true, hint: "Restarting…", spec: "sessionMenu.enableBrowser" });
    else bi = item("globe", "Enable browser tools", { act: "browserConfirm", spec: "sessionMenu.enableBrowser", cls: f.menuHover === "browser" ? " is-hover" : "", hint: "Lets the agent take screenshots and use web pages · restarts the session, keeps the conversation" });
    return `<div class="mj_HeaderMenu mj_RoomItemMenu mj_SessionMenu" role="menu" aria-label="Session">${item("rename", "Rename")}${item("pin", "Pin")}${bi}<div class="mj_RoomItemMenu_sep" role="separator"></div>${item("archive", "Archive")}</div>`;
  }

  /* ---------- modals ---------- */
  const modal = (spec, ic, title, body, actions, extra = "") => `<div class="mj_UploadConfirm_scrim" data-act="scrim"><div class="mj_UploadConfirm mj_UploadConfirm_queue${extra}" role="dialog" aria-modal="true" aria-labelledby="dlg-title" data-spec="${spec}"><div class="mj_UploadConfirm_header">${icon(ic)}<h2 class="mj_UploadConfirm_title" id="dlg-title">${title}</h2><button class="mj_UploadConfirm_close" data-act="closeModal" aria-label="Close">${icon("x")}</button></div><div class="mj_UploadConfirm_body">${body}</div><div class="mj_UploadConfirm_footer"><div class="mj_UploadConfirm_actions">${actions}</div></div></div></div>`;
  function renderBrowserConfirm(st) {
    const busy = M.isBusy(st);
    const body = `<p>Matron restarts this session with browser tools, so the agent can take screenshots and use web pages.</p><ul class="mj_ConfirmList"><li>${icon("chat")}<span>The conversation is kept.</span></li>${busy ? "" : ""}<li>${icon("memory")}<span>Browser tools use about 400 MB of memory while on.</span></li></ul>${busy ? `<div class="mj_ConfirmBusy"><span class="mj_LiveDot" aria-hidden="true"></span><span>The agent is in the middle of a task. The restart waits until it finishes. <b>Restart now</b> stops the current step instead.</span></div>` : ""}`;
    const actions = `<button data-act="closeModal">Cancel</button>${busy ? '<button class="mj_UploadConfirm_skip" data-act="browserNow">Restart now</button>' : ""}<button class="mj_UploadConfirm_send" data-act="browserGo">Restart with browser tools</button>`;
    return modal("modal.enableBrowserConfirm", "globe", "Enable browser tools", body, actions);
  }
  function renderSheet(st) {
    const sh = st.sheet || {};
    const codex = sh.agent === "codex";
    const folders = FOLDERS.map((p, i) => `<button class="mj_FolderOption" role="radio" aria-checked="${sh.folder === i}" data-act="folder" data-folder="${i}" title="${esc(p)}"><span class="mj_Radio"></span><span class="mj_FolderOption_path">${esc(p)}</span>${i === DEFAULT_FOLDER ? '<span class="mj_Tag">default</span>' : "<span></span>"}</button>`).join("")
      + `<button class="mj_FolderOption" role="radio" aria-checked="${sh.folder === "other"}" data-act="folder" data-folder="other"><span class="mj_Radio"></span><span class="mj_FolderOption_path">Other folder…</span><span></span></button>`;
    const other = sh.folder === "other" ? `<input class="mj_TextInput${sh.folderError ? " mj_TextInput_error" : ""}" data-spec="modal.newSessionOptions.otherFolder" data-input="other" placeholder="/path/on/the/box" value="${esc(sh.other || "")}" aria-invalid="${!!sh.folderError}" aria-describedby="ns-folder-err">${sh.folderError ? '<span class="mj_FieldError" id="ns-folder-err" role="alert">That folder doesn’t exist on the box.</span>' : ""}` : "";
    const body = `<div class="mj_Field" data-spec="modal.newSessionOptions.folder"><span class="mj_FieldLabel" id="ns-folder">Folder</span><div class="mj_FolderList" role="radiogroup" aria-labelledby="ns-folder">${folders}</div>${other}</div>
<div class="mj_Field" data-spec="modal.newSessionOptions.agent"><span class="mj_FieldLabel" id="ns-agent">Agent</span><div class="mj_Segmented" role="radiogroup" aria-labelledby="ns-agent"><button role="radio" aria-checked="${!codex}" data-act="agent" data-agent="claude">Claude</button><button role="radio" aria-checked="${codex}" data-act="agent" data-agent="codex">Codex</button></div></div>
<div class="mj_Field" data-spec="modal.newSessionOptions.model"><label class="mj_FieldLabel" for="ns-model">Model</label><select class="mj_Select" id="ns-model" data-input="model" ${codex ? "disabled" : ""}>${MODELS.map(([v, l], i) => `<option value="${v}" ${(sh.model || "opus") === v ? "selected" : ""}>${l}${i === 0 ? " (box default)" : ""}</option>`).join("")}</select>${codex ? '<span class="mj_FieldHint">Codex picks its own model</span>' : ""}</div>
<div class="mj_Field mj_SwitchRow" data-spec="modal.newSessionOptions.browser"><span class="mj_FieldLabel" id="ns-browser" style="color:var(--cpd-color-text-primary);font:var(--cpd-font-label)">Browser tools</span><button class="mj_SwitchButton" role="switch" aria-checked="${!codex && !!sh.browser}" aria-labelledby="ns-browser" data-act="sheetBrowser" ${codex ? "disabled" : ""}><span class="mj_Switch${!codex && sh.browser ? " is-on" : ""}${codex ? " is-disabled" : ""}"></span></button><span class="mj_FieldHint">${codex ? "Not available for Codex sessions" : "You can also turn this on later from the session menu · ≈400 MB while on"}</span></div>
<div class="mj_Field" data-spec="modal.newSessionOptions.firstTask"><label class="mj_FieldLabel" for="ns-task">First task (optional)</label><textarea class="mj_TextArea" id="ns-task" data-input="task" placeholder="What should it start on?">${esc(sh.task || "")}</textarea></div>
<label class="mj_CheckRow" data-spec="modal.newSessionOptions.remember"><input type="checkbox" data-act="remember" ${sh.remember ? "checked" : ""}>Remember as my defaults</label>
${sh.boxes > 1 ? `<div class="mj_LowFi" data-spec="modal.newSessionOptions.box"><span class="mj_LowFi_note">multi-box: owned upstream</span><div class="mj_LowFi_row"><span>box-1</span><span>gpu-box-2</span><span>laptop</span></div></div>` : `<span class="mj_BoxCaption" data-spec="modal.newSessionOptions.box">On box-1</span>`}`;
    const actions = `<button data-act="closeModal">Cancel</button><button class="mj_UploadConfirm_send" data-act="sheetStart" data-spec="modal.newSessionOptions.start">Start session</button>`;
    return modal("modal.newSessionOptions", "plus", "New session", body, actions, " mj_NewSessionSheet");
  }

  /* ---------- header + composer ---------- */
  function renderHeader(st) {
    const busy = M.isBusy(st);
    const codex = st.session === "codex";
    const status = busy ? "running" : (TAILS[st.tail] || []).some(([, m]) => m === "waiting") ? "needs you" : "idle";
    const chip = st.browser === "queued" ? `<span class="mj_HeaderChip" role="status"><span class="mj_Spinner" aria-hidden="true"></span>Restarting after this step</span>` : "";
    return `<header class="mx_RoomHeader"><div class="mj_HeaderTitle"><b>${codex ? "↳ test triage" : "matron-web"}</b><span>${codex ? "Codex · /opt/matron-web · working" : `Opus · /opt/matron-web · ${status}${st.browser === "on" ? " · browser tools" : ""}`}</span></div>${chip}<button class="mj_IconButton" data-act="menu" data-menu="session" aria-label="Session menu" aria-haspopup="menu" aria-expanded="${st.menu === "session"}">${icon("dots")}</button>${st.menu === "session" ? renderSessionMenu(st) : ""}</header>`;
  }
  const composer = () => `<div class="mx_MessageComposer"><div class="mx_MessageComposer_row"><button class="mx_MessageComposer_button" aria-label="Attach">${icon("clip")}</button><textarea class="mx_BasicMessageComposer_input" rows="1" placeholder="Message the agent…" aria-label="Message"></textarea><button class="mx_MessageComposer_button" aria-label="Record">${icon("mic")}</button><button class="mx_MessageComposer_sendMessage" aria-label="Send">${icon("send")}</button></div></div>`;

  function renderChat(st) {
    const overlay = st.modal === "browser" ? renderBrowserConfirm(st) : st.modal === "sheet" ? renderSheet(st) : "";
    return `<main class="mx_RoomView_body" data-pane="${st.pane || "wide"}" data-chat-pane>${renderHeader(st)}<div class="mx_RoomView_messagePanel"><div class="mx_RoomView_messageListWrapper">${renderThread(st)}</div></div>${composer()}${overlay}</main>`;
  }

  M.renderApp = function renderApp(st) {
    if (st.screen === "phone") return `<div class="mv6-phone">${renderSidebar({ ...st, menu: null })}</div>${st.modal === "sheet" ? renderSheet(st) : ""}`;
    if (st.screen === "narrowStage") return `<div class="mv6-narrowStage">${renderChat({ ...st, pane: "narrow" })}</div>`;
    return `<div class="mx_MatrixChat">${renderSidebar(st)}${renderChat(st)}</div>`;
  };

  /* ---------- presets: every state reachable by clicking ---------- */
  const BASE = { theme: "light", pane: "wide", screen: "desktop", showWork: false, tail: "full", cards: {}, live: { idx: 2, xfade: false, elapsed: 42 }, menu: null, modal: null, browser: "idle", session: "claude", split: "idle", force: {}, notices: [], defaults: { known: true, model: "opus", folder: 1, agent: "claude" }, sheet: { folder: 1, agent: "claude", model: "opus", browser: false, task: "", remember: false, boxes: 1 } };
  M.BASE = BASE;
  const g1 = (id) => ({ [id]: true });
  const P_ = [];
  const add = (id, group, label, patch, note) => P_.push({ id, group, label, patch, note: note || "" });
  add("card-collapsed-done", "Under the hood", "Collapsed · done (turn 1)", { tail: "t1" });
  add("card-collapsed-running", "Under the hood", "Collapsed · running, mid-cross-fade (turn 2)", { tail: "t2run", live: { idx: 2, xfade: true, elapsed: 42 } }, "live line captured half-way through its 240ms cross-fade");
  add("card-expanded-done", "Under the hood", "Expanded · done (turn 1)", { tail: "t1", cards: { t1: { open: true } } });
  add("card-group-open", "Under the hood", "Expanded · one group open", { tail: "t1", cards: { t1: { open: true, groups: g1("look-1-0") } } });
  add("card-deep-diff", "Under the hood", "Deep detail · diff (components.tsx)", { tail: "t1", cards: { t1: { open: true, deep: "t1s8", deepFrom: "files" } } });
  add("card-deep-command", "Under the hood", "Deep detail · failed type check + rerun", { tail: "t1", cards: { t1: { open: true, groups: g1("check-1-5"), deep: "t1s10" } } });
  add("card-deep-helper", "Under the hood", "Deep detail · helper", { tail: "t5", cards: { t5: { open: true, groups: g1("helper-0-1"), deep: "t5s2" } } });
  add("card-expanded-running", "Under the hood", "Expanded · running", { tail: "t2run", cards: { t2: { open: true } } });
  add("card-recovered", "Under the hood", "Error · recovered step (amber group)", { tail: "t1", cards: { t1: { open: true, groups: g1("check-1-5") } } });
  add("card-turn-error", "Under the hood", "Error · turn-ending row below the card", { tail: "t5" });
  add("card-slow", "Under the hood", "Slow step · amber + Stop", { tail: "t2slow", live: { idx: 2, xfade: false, elapsed: 304 } });
  add("card-waiting", "Under the hood", "Waiting for you", { tail: "t3wait" });
  add("card-210", "Under the hood", "210-step turn · expanded", { tail: "t210", cards: { t210: { open: true, groups: g1("look-1-0") } } });
  add("narrow-collapsed", "Narrow chat pane (420px)", "Collapsed", { screen: "narrowStage", pane: "narrow", tail: "t2run" });
  add("narrow-expanded", "Narrow chat pane (420px)", "Expanded", { screen: "narrowStage", pane: "narrow", tail: "t1", cards: { t1: { open: true, groups: g1("check-1-5") } } });
  add("narrow-deep", "Narrow chat pane (420px)", "Deep detail", { screen: "narrowStage", pane: "narrow", tail: "t1", cards: { t1: { open: true, groups: g1("check-1-5"), deep: "t1s10" } } });
  add("thread-off", "Thread", "Six turns · Show the work OFF", { tail: "full" });
  add("thread-on", "Thread", "Six turns · Show the work ON (= today)", { tail: "full", showWork: true });
  add("thread-breakthroughs", "Thread", "Break-throughs: image, file, tracker item, peer, helper, notices", { tail: "t4" });
  add("thread-permission", "Thread", "Break-through: permission + question", { tail: "t3done" });
  add("settings-off", "Settings menu", "Show the work · off", { menu: "settings", force: { menuFocus: "showWork" } });
  add("settings-on", "Settings menu", "Show the work · on", { menu: "settings", showWork: true });
  add("browser-idle", "Session menu", "Enable browser tools · idle", { menu: "session", force: { menuHover: "browser" } });
  add("browser-confirm-idle", "Session menu", "Confirm · agent idle", { modal: "browser", tail: "t1" });
  add("browser-confirm-busy", "Session menu", "Confirm · agent mid-task (Restart now)", { modal: "browser", tail: "t2run" });
  add("browser-queued", "Session menu", "Queued · header chip", { browser: "queued", tail: "t2run" });
  add("browser-restarting", "Session menu", "Restarting · notice line", { browser: "restarting", tail: "t1", notices: [F.NOTICES.restarting] });
  add("browser-on", "Session menu", "On · checked, disabled", { browser: "on", menu: "session", tail: "t1" });
  add("browser-codex", "Session menu", "Unavailable · Codex session", { session: "codex", menu: "session", tail: "t1" });
  add("split-idle", "New session button", "Idle", { tail: "t1" });
  add("split-hover-main", "New session button", "Hover · main", { tail: "t1", force: { splitHover: "main" } });
  add("split-hover-more", "New session button", "Hover · ⋯", { tail: "t1", force: { splitHover: "more" } });
  add("split-focus-main", "New session button", "Focus-visible · main", { tail: "t1", force: { splitFocus: "main" } });
  add("split-focus-more", "New session button", "Focus-visible · ⋯", { tail: "t1", force: { splitFocus: "more" } });
  add("split-starting", "New session button", "Starting", { tail: "t1", split: "starting" });
  add("split-error", "New session button", "Error", { tail: "t1", split: "error" });
  add("split-uncertain", "New session button", "Uncertain", { tail: "t1", split: "uncertain" });
  add("split-nobox", "New session button", "No box connected", { tail: "t1", split: "nobox" });
  add("split-mobile", "New session button", "Mobile (390px)", { screen: "phone" });
  add("sheet-default", "Options sheet", "Default", { tail: "t1", modal: "sheet" });
  add("sheet-filled", "Options sheet", "Filled · Remember as my defaults", { tail: "t1", modal: "sheet", sheet: { folder: 0, agent: "claude", model: "sonnet", browser: true, task: "Fix the flaky conversation-order test on main.", remember: true, boxes: 1 } });
  add("sheet-codex", "Options sheet", "Codex selected", { tail: "t1", modal: "sheet", sheet: { folder: 0, agent: "codex", model: "opus", browser: false, task: "", remember: false, boxes: 1 } });
  add("sheet-badfolder", "Options sheet", "Bad folder", { tail: "t1", modal: "sheet", sheet: { folder: "other", other: "/opt/matron-wbe", folderError: true, agent: "claude", model: "opus", browser: false, task: "", remember: false, boxes: 1 } });
  add("sheet-multibox", "Options sheet", "Multi-box (low-fi)", { tail: "t1", modal: "sheet", sheet: { folder: 1, agent: "claude", model: "opus", browser: false, task: "", remember: false, boxes: 3 } });
  M.PRESETS = P_;
  M.stateFor = (preset, theme) => ({ ...JSON.parse(JSON.stringify(BASE)), ...JSON.parse(JSON.stringify(preset.patch)), theme: theme || "light" });
  M.esc = esc;
})(typeof window !== "undefined" ? window : globalThis);
