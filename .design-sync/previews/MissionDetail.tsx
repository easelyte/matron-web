import { MatronThemeProvider, MissionDetail, createFixtureClient, fixtureMissionDetail, fixtureMissions } from "matron-web";

const client = createFixtureClient({ screen: "tracker-mission" });
const noop = () => {};
const HOUR = 3_600_000;
const NOW = Date.now();

const closedDetail = {
  mission: fixtureMissions[2],
  milestones: [
    {
      id: "ml_5",
      mission_id: "ms_4",
      num: 5,
      kind: "progress" as const,
      title: "Dry-run clean",
      body: "",
      convo_id: "c3",
      seq: 18,
      device_id: 1,
      created_by: "agent" as const,
      created_at: NOW - 130 * HOUR,
    },
    {
      id: "ml_4",
      mission_id: "ms_4",
      num: 4,
      kind: "user_input" as const,
      title: "Go for the upgrade in the Sunday window",
      body: "",
      convo_id: "c3",
      seq: 9,
      device_id: 2,
      created_by: "user" as const,
      created_at: NOW - 150 * HOUR,
    },
  ],
  items: [],
  conversations: [{ id: "c3", title: "postgres upgrade dry-run", state: "idle", box: "vps" }],
};

const freshDetail = {
  mission: {
    ...fixtureMissions[1],
    id: "ms_9",
    num: 9,
    title: "Nightly Postgres restore drill",
    body: "Prove the nightly dump restores cleanly into a scratch database, and alert when it doesn't.",
    open_items: 1,
    milestones: 0,
    last_milestone_at: null,
    last_milestone: null,
    created_at: NOW - 40 * 60_000,
  },
  milestones: [],
  items: [
    {
      id: "it_16",
      num: 16,
      kind: "task" as const,
      state: "open" as const,
      awaiting: "agent" as const,
      title: "Write the restore-check systemd timer",
      origin_convo_id: "c3",
      updated_at: NOW - 30 * 60_000,
    },
  ],
  conversations: [{ id: "c3", title: "postgres upgrade dry-run", state: "running", box: "vps" }],
};

const frame = (width: number | string, height: number) => ({ width, maxWidth: 720, height, display: "flex", flexDirection: "column" as const });

export const OpenMission = () => (
  <div style={frame("100%", 660)}>
    <MissionDetail detail={fixtureMissionDetail} client={client} onOpenItem={noop} onBack={noop} />
  </div>
);

export const ClosedMission = () => (
  <div style={frame("100%", 500)}>
    <MissionDetail detail={closedDetail as never} client={client} onOpenItem={noop} onBack={noop} />
  </div>
);

export const FreshMission = () => (
  <div style={frame("100%", 520)}>
    <MissionDetail detail={freshDetail as never} client={client} onOpenItem={noop} onBack={noop} />
  </div>
);

export const NotLoaded = () => (
  <div style={frame("100%", 180)}>
    <MissionDetail detail={null} client={client} onOpenItem={noop} onBack={noop} />
  </div>
);

export const PhoneWidth = () => (
  <div style={frame(360, 660)}>
    <MissionDetail detail={fixtureMissionDetail} client={client} onOpenItem={noop} onBack={noop} />
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div style={frame("100%", 660)}>
      <MissionDetail detail={fixtureMissionDetail} client={client} onOpenItem={noop} onBack={noop} />
    </div>
  </MatronThemeProvider>
);
