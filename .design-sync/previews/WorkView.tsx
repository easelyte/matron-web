import { MatronThemeProvider, WorkView } from "matron-web";

const loop = (
  id: number,
  title: string,
  repo: string,
  domain: string,
  priority: number,
  description: string,
  status: "active" | "blocked" | "parked" | "paused" = "active",
  claim: null | { holder: string | null; liveness: "live" | "stale" | "unknown"; convo: string } = null,
) => ({
  id,
  title,
  repo,
  domain,
  priority,
  description,
  status,
  claim: claim
    ? { convo_id: claim.convo, holder_label: claim.holder, claimed_at: "2026-09-25T08:30:00Z", liveness: claim.liveness }
    : null,
});

const GROUPS = [
  {
    key: "matron-web",
    loops: [
      loop(742, "Mobile tracker: detail views clip under the composer", "matron-web", "infra", 5,
        "Item and mission detail lose their last comment behind the reply composer on iOS Safari.\n\nRepro on a 390px viewport with the keyboard open.",
        "active", { holder: "matron-web wave", liveness: "live", convo: "b3f9a1c2-1111-2222-3333-444455556666" }),
      loop(738, "Work tab: show claim liveness from the bridge heartbeat", "matron-web", "infra", 4,
        "Replace the unknown liveness badge with live/stale once the bridge publishes heartbeats.",
        "blocked", { holder: null, liveness: "stale", convo: "c7d4e5f6-7777-8888-9999-aaaabbbbcccc" }),
      loop(731, "Files pane: breadcrumb overflow on deep paths", "matron-web", "infra", 2, ""),
      loop(719, "Offline outbox for tracker replies", "matron-web", "infra", 1,
        "Queue comment posts while offline and replay them with the same idempotency key.", "parked"),
    ],
  },
  {
    key: "billing-app",
    loops: [
      loop(725, "Invoice export: VAT column for EU clients", "billing-app", "billing", 3,
        "Finance needs VAT split out per line for the quarterly filing.",
        "active", { holder: "billing wave", liveness: "unknown", convo: "d1e2f3a4-0000-1111-2222-333344445555" }),
    ],
  },
  {
    key: "ops-repo",
    loops: [
      loop(698, "Backup rotation: verify restores weekly", "ops-repo", "infra", 2,
        "Run a test restore of the newest snapshot every Monday.", "paused"),
    ],
  },
];

const okLoader = {
  work: async (groupBy: "repo" | "domain") => ({ schema_version: 1, status: "ok", group_by: groupBy, groups: GROUPS }),
};

const parkedLoader = {
  work: async (groupBy: "repo" | "domain") => ({
    schema_version: 1,
    status: "ok",
    group_by: groupBy,
    groups: [
      {
        key: "matron-web",
        loops: [
          loop(719, "Offline outbox for tracker replies", "matron-web", "infra", 1,
            "Queue comment posts while offline and replay them with the same idempotency key.", "parked"),
        ],
      },
    ],
  }),
};

const errorLoader = {
  work: async (groupBy: "repo" | "domain") => ({
    schema_version: 1,
    status: "error",
    group_by: groupBy,
    groups: [],
    error: { code: "store_missing", message: "The canonical loop store is missing." },
  }),
};

const loadingLoader = { work: () => new Promise(() => {}) };

export const Active = () => (
  <div style={{ maxWidth: 720 }}>
    <WorkView api={okLoader as never} />
  </div>
);

export const PhoneWidth = () => (
  <div style={{ width: 360 }}>
    <WorkView api={okLoader as never} />
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div style={{ maxWidth: 720 }}>
      <WorkView api={okLoader as never} />
    </div>
  </MatronThemeProvider>
);

export const AllParked = () => (
  <div style={{ maxWidth: 720 }}>
    <WorkView api={parkedLoader as never} />
  </div>
);

export const Loading = () => (
  <div style={{ maxWidth: 720 }}>
    <WorkView api={loadingLoader as never} />
  </div>
);

export const StoreMissing = () => (
  <div style={{ maxWidth: 720 }}>
    <WorkView api={errorLoader as never} />
  </div>
);
