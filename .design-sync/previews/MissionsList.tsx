import { MatronThemeProvider, MissionsList, fixtureMissions } from "matron-web";

const open = () => {};
const [tracker, backups, postgres] = fixtureMissions;

const busier = [
  ...fixtureMissions,
  {
    ...backups,
    id: "ms_7",
    num: 7,
    title: "SNAFU invoice export",
    needs_you: 1,
    open_items: 2,
    last_milestone_at: Date.now() - 45 * 60_000,
    last_milestone: { num: 3, title: "CSV totals match the ledger", kind: "progress" as const, created_at: Date.now() - 45 * 60_000 },
  },
  {
    ...backups,
    id: "ms_8",
    num: 8,
    title: "Tracker mobile polish",
    needs_you: 0,
    milestones: 0,
    last_milestone_at: null,
    last_milestone: null,
    created_at: Date.now() - 3 * 3_600_000,
  },
];

export const Open = () => (
  <div style={{ maxWidth: 720 }}>
    <MissionsList missions={busier} onOpenMission={open} />
  </div>
);

export const PhoneWidth = () => (
  <div style={{ width: 360 }}>
    <MissionsList missions={busier} onOpenMission={open} />
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div style={{ maxWidth: 720 }}>
      <MissionsList missions={[tracker, backups, postgres]} onOpenMission={open} />
    </div>
  </MatronThemeProvider>
);

export const Empty = () => (
  <div style={{ maxWidth: 720 }}>
    <MissionsList missions={[]} onOpenMission={open} />
  </div>
);
