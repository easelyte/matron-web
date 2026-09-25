import { HeaderShell, MatronThemeProvider, ThemeToggle, buildUsageMeters, CompactIcon, KebabIcon } from "matron-web";

const NOW = Date.now();
const back = () => {};

const meters = buildUsageMeters(
    {
        context: { tokens: 144_000, window: 200_000, pct: 72 },
        vitals: { cpu_pct: 34, ram_pct: 58, sampled_at_ms: NOW - 8_000 },
    },
    [
        { id: "session", label: "Session", percent: 41, resets: "3h20" },
        { id: "week_fable", label: "Week (Fable)", percent: 22, resets: "4d" },
        { id: "week_all", label: "Week (all models)", percent: 63, resets: "4d" },
    ],
);

const expanded = { usageCollapsed: false, titleCollapsed: false };
const compact = { usageCollapsed: true, titleCollapsed: true };
// At the ~840px card width the adaptive header folds the meter grid into the ctx/5h disclosure
// (useAdaptiveHeader); the full grid needs ~1100px (see the Subagent cell for the expanded grid).
const tablet = { usageCollapsed: true, titleCollapsed: false };

// Slot content as ChatHeader passes it: model, reset countdown, run state.
const parentSubtitle = (
    <>
        <span className="mj_HeaderModel">claude-opus-5</span>
        <span className="mj_HeaderLimitsReset">resets 3h20 / 4d</span>
        <span className="mj_HeaderState mj_HeaderState_running">running</span>
    </>
);
const parentCompact = (
    <span className="mj_HeaderMetaCompact">
        <span className="mj_HeaderStatusDot mj_HeaderStatusDot_running" aria-hidden="true" />
        <span className="mj_HeaderModelShort">opus-5</span>
    </span>
);
const compactButton = (
    <button className="mj_CompactButton" type="button" aria-label="Compact conversation">
        <CompactIcon />
        <span>Compact</span>
    </button>
);
const overflow = (
    <div className="mj_HeaderOverflow">
        <button type="button" className="mj_IconButton mj_HeaderOverflowTrigger" aria-label="Conversation actions">
            <KebabIcon aria-hidden />
        </button>
    </div>
);

const Parent = ({ collapse = expanded }: { collapse?: typeof expanded }) => (
    <HeaderShell
        mode="parent"
        onBack={back}
        backLabel="Back to conversations"
        title="matron-web · deploy"
        subtitle={parentSubtitle}
        subtitleCompact={parentCompact}
        hasSubtitle
        limits={meters}
        rightControls={compactButton}
        persistentControls={overflow}
        hideControlsWhenCompact
        collapse={collapse}
    />
);

export const Conversation = () => (
    <div>
        <Parent collapse={tablet} />
    </div>
);

export const Subagent = () => (
    <div>
        <HeaderShell
            mode="child"
            onBack={back}
            backLabel="Back to parent"
            title="test triage"
            titleGlyph="↳"
            titleBadge={<span className="mj_HeaderSubagentBadge">subagent</span>}
            subtitle={
                <>
                    <span className="mj_HeaderParentRef">
                        of <span className="mj_HeaderParentName">matron-web · deploy</span>
                    </span>
                    <span className="mj_HeaderState mj_HeaderState_running">running</span>
                </>
            }
            hasSubtitle
            limits={meters}
            collapse={expanded}
        />
    </div>
);

export const NoUsageYet = () => (
    <div>
        <HeaderShell
            mode="parent"
            onBack={back}
            backLabel="Back to conversations"
            title="postgres upgrade dry-run"
            subtitle={<span className="mj_HeaderModel">gpt-5.5-codex</span>}
            hasSubtitle
            rightControls={<ThemeToggle />}
            persistentControls={overflow}
            collapse={expanded}
        />
    </div>
);

export const PhoneCompact = () => (
    <div style={{ width: 360 }}>
        <Parent collapse={compact} />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <div>
            <Parent collapse={tablet} />
        </div>
    </MatronThemeProvider>
);
