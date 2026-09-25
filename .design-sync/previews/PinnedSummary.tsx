import { MatronThemeProvider, PinnedSummary } from "matron-web";

const MIN = 60_000;

const deploy = {
    bullets: [
        "Reskinned the journal client end to end; bubbles, sidebar and header now share one scale.",
        "Cut the deploy to a versioned release dir with a current-release pointer, so rollback is a repoint.",
        "Restarted nginx after the cert rotation and watched the error rate for ten minutes: it held at 0.02% with no 5xx spike, no upstream resets, and no change to p99 latency, so the rotation is considered clean.",
        "Spawned a test-triage subagent for the flaky upload-timeout test; it is still running.",
    ],
    state: "ready" as const,
    updatedAtMs: Date.now() - 7 * MIN,
};

export const Ready = () => (
    <div style={{ maxWidth: 760 }}>
        <PinnedSummary summary={deploy} />
    </div>
);

export const Updating = () => (
    <div style={{ maxWidth: 760 }}>
        <PinnedSummary summary={{ ...deploy, state: "updating", updatedAtMs: Date.now() - 42 * MIN }} />
    </div>
);

export const Empty = () => (
    <div style={{ maxWidth: 760 }}>
        <PinnedSummary summary={{ bullets: [], updatedAtMs: Date.now() - MIN }} />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark" surface="default">
        <div style={{ maxWidth: 760 }}>
            <PinnedSummary summary={deploy} />
        </div>
    </MatronThemeProvider>
);

export const PhoneWidth = () => (
    <div style={{ width: 360 }}>
        <PinnedSummary summary={deploy} />
    </div>
);
