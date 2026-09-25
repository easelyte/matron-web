import { ItemRow, MatronThemeProvider, fixtureItems } from "matron-web";

const open = () => {};
const [question, decision, task, closed] = fixtureItems;

export const NeedsYou = () => (
  <div style={{ maxWidth: 560 }}>
    <ItemRow item={question} currentConvoId="c1" onOpen={open} />
  </div>
);

export const States = () => (
  <div style={{ maxWidth: 560, display: "flex", flexDirection: "column" }}>
    <ItemRow item={question} scope="all" currentConvoId="c1" onOpen={open} />
    <ItemRow item={decision} scope="all" currentConvoId="c1" onOpen={open} />
    <ItemRow item={task} scope="all" currentConvoId="c1" onOpen={open} />
    <ItemRow item={closed} scope="all" currentConvoId="c1" onOpen={open} />
  </div>
);

export const PhoneWidth = () => (
  <div style={{ width: 360, display: "flex", flexDirection: "column" }}>
    <ItemRow item={question} scope="all" currentConvoId="c2" onOpen={open} />
    <ItemRow item={{ ...decision, labels: ["route-elsewhere"] }} scope="all" currentConvoId="c1" onOpen={open} />
  </div>
);

export const Dark = () => (
  <MatronThemeProvider theme="dark">
    <div style={{ maxWidth: 560, display: "flex", flexDirection: "column" }}>
      <ItemRow item={question} scope="all" currentConvoId="c1" onOpen={open} />
      <ItemRow item={task} scope="all" currentConvoId="c1" onOpen={open} />
      <ItemRow item={closed} scope="all" currentConvoId="c1" onOpen={open} />
    </div>
  </MatronThemeProvider>
);
