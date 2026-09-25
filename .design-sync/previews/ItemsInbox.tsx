import { ItemsInbox, MatronThemeProvider, createFixtureClient, fixtureItems } from "matron-web";

const client = createFixtureClient({ screen: "tracker-inbox" });
const open = () => {};
const [question, decision, task, closed] = fixtureItems;

const moreNeedsYou = [
  ...fixtureItems,
  {
    ...question,
    id: "it_15",
    num: 15,
    kind: "decision" as const,
    title: "Restart the bridge to deploy 4f2c1e9?",
    body: "Merged and staged. Live on the old sha until you give the go.",
    labels: [],
    origin_convo_id: "c3",
    origin_convo_title: "postgres upgrade dry-run",
    mission_id: null,
    mission_num: null,
    comment_count: 0,
    updated_at: Date.now() - 20 * 60_000,
  },
];

export const NeedsYou = () => (
  <div style={{ maxWidth: 720 }}>
    <ItemsInbox items={moreNeedsYou} client={client} onOpenItem={open} />
  </div>
);

export const NothingNeedsYou = () => (
  <div style={{ maxWidth: 720 }}>
    <ItemsInbox items={[task, closed]} client={client} onOpenItem={open} />
  </div>
);

export const PhoneWidth = () => (
  <div style={{ width: 360 }}>
    <ItemsInbox items={moreNeedsYou} client={client} onOpenItem={open} />
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div style={{ maxWidth: 720 }}>
      <ItemsInbox items={[question, decision, task]} client={client} onOpenItem={open} />
    </div>
  </MatronThemeProvider>
);
