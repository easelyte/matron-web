import { MatronThemeProvider, TrackerPane, createFixtureClient } from "matron-web";

const loop = (id: number, title: string, repo: string, priority: number, description: string, status = "active", holder: string | null = null) => ({
  id,
  title,
  repo,
  domain: repo === "billing-app" ? "billing" : "infra",
  priority,
  description,
  status,
  claim: holder
    ? { convo_id: "b3f9a1c2-1111-2222-3333-444455556666", holder_label: holder, claimed_at: "2026-09-25T08:30:00Z", liveness: "live" }
    : null,
});

const WORK = {
  schema_version: 1,
  status: "ok",
  group_by: "repo",
  groups: [
    {
      key: "matron-web",
      loops: [
        loop(742, "Mobile tracker: detail views clip under the composer", "matron-web", 5,
          "Item and mission detail lose their last comment behind the reply composer on iOS Safari.", "active", "matron-web wave"),
        loop(731, "Files pane: breadcrumb overflow on deep paths", "matron-web", 2, "Long workspace paths push the close button off-screen."),
      ],
    },
    {
      key: "billing-app",
      loops: [loop(725, "Invoice export: VAT column for EU clients", "billing-app", 3, "Finance needs VAT split out per line for the quarterly filing.")],
    },
  ],
};

const inbox = createFixtureClient({ screen: "tracker-inbox" });
const item = createFixtureClient({ screen: "tracker-item" });
const mission = createFixtureClient({ screen: "tracker-mission" });
const work = createFixtureClient({ screen: "tracker-work" });
(work as unknown as { work: (groupBy: string) => Promise<unknown> }).work = async (groupBy) => ({ ...WORK, group_by: groupBy });
const offline = createFixtureClient({
  screen: "tracker-missions",
  state: { trackerError: "Couldn't reach the journal server. Showing what's on this device." },
});
const darkItem = createFixtureClient({ screen: "tracker-item" });

const frame = (width: number | string, height: number) => ({ width, height, display: "flex" });

export const Inbox = () => (
  <div style={frame("100%", 300)}>
    <TrackerPane client={inbox} state={inbox.getSnapshot()} />
  </div>
);

export const ItemOpen = () => (
  <div style={frame("100%", 500)}>
    <TrackerPane client={item} state={item.getSnapshot()} />
  </div>
);

export const MissionOpen = () => (
  <div style={frame("100%", 700)}>
    <TrackerPane client={mission} state={mission.getSnapshot()} />
  </div>
);

export const Work = () => (
  <div style={frame("100%", 540)}>
    <TrackerPane client={work} state={work.getSnapshot()} />
  </div>
);

export const PhoneMissionsWithError = () => (
  <div style={frame(360, 400)}>
    <TrackerPane client={offline} state={offline.getSnapshot()} />
  </div>
);

export const DarkItem = () => (
  <MatronThemeProvider theme="dark">
    <div style={frame("100%", 560)}>
      <TrackerPane client={darkItem} state={darkItem.getSnapshot()} />
    </div>
  </MatronThemeProvider>
);
