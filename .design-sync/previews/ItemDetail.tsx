import { ItemDetail, MatronThemeProvider, createFixtureClient, fixtureItemDetail, fixtureItems } from "matron-web";

const client = createFixtureClient({ screen: "tracker-item" });
const back = () => {};
const HOUR = 3_600_000;
const NOW = Date.now();
const [, decision, , closed] = fixtureItems;

const decisionItem = {
  ...decision,
  body: [
    "Plug revenue lands in Stripe but the dashboard balance only reads the bank feed.",
    "",
    "- **Fold in:** balance matches what the business actually earned this month",
    "- **Keep separate:** balance matches the bank, plug shows as its own line",
    "",
    "I recommend keeping them separate until the payout lag is under 48h.",
  ].join("\n"),
  labels: ["finance", "route-elsewhere"],
  links: [
    { title: "Stripe payouts", url: "https://dashboard.stripe.com/payouts" },
    { title: "PR #412", url: "https://github.com/easelyte/matron-web/pull/412" },
  ],
  comment_count: 1,
};

const decisionComments = [
  {
    id: "cm_21",
    item_id: "it_13",
    author: "agent" as const,
    device_id: 1,
    kind: "comment" as const,
    body: "Payout lag over the last 30 days: median 3.2 days. Screenshot of the reconciliation attached.",
    attachments: [{ blob_ref: "b1", name: "reconciliation-sept.png", size: 184_320, mime: "image/png" }],
    meta: null,
    created_at: NOW - 3 * HOUR,
  },
];

const closedItem = { ...closed, body: "Retain seven days of releases on the VPS, then prune the oldest first." };
const closedComments = [
  {
    id: "cm_31",
    item_id: "it_9",
    author: "user" as const,
    device_id: 2,
    kind: "comment" as const,
    body: "Seven days is enough. Rollbacks older than that go through the backup snapshots anyway.",
    attachments: [],
    meta: null,
    created_at: NOW - 31 * HOUR,
  },
  {
    id: "cm_32",
    item_id: "it_9",
    author: "user" as const,
    device_id: 2,
    kind: "status" as const,
    body: "",
    attachments: [],
    meta: {
      from: { state: "open", resolution: null, awaiting: "user" },
      to: { state: "closed", resolution: "decided", awaiting: null },
    },
    created_at: NOW - 30 * HOUR,
  },
];

const frame = (width: number | string, height: number) => ({ width, maxWidth: 720, height, display: "flex", flexDirection: "column" as const });

export const Question = () => (
  <div style={frame("100%", 480)}>
    <ItemDetail item={fixtureItemDetail.item} comments={fixtureItemDetail.comments} client={client} onBack={back} />
  </div>
);

export const DecisionFromAnotherChat = () => (
  <div style={frame("100%", 590)}>
    <ItemDetail item={decisionItem as never} comments={decisionComments as never} client={client} onBack={back} />
  </div>
);

export const Closed = () => (
  <div style={frame("100%", 380)}>
    <ItemDetail item={closedItem} comments={closedComments as never} client={client} onBack={back} />
  </div>
);

export const PhoneWidth = () => (
  <div style={frame(360, 640)}>
    <ItemDetail item={fixtureItemDetail.item} comments={fixtureItemDetail.comments} client={client} onBack={back} />
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div style={frame("100%", 480)}>
      <ItemDetail item={fixtureItemDetail.item} comments={fixtureItemDetail.comments} client={client} onBack={back} />
    </div>
  </MatronThemeProvider>
);
