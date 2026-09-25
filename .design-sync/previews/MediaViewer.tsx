import { MediaViewer, MatronThemeProvider, createFixtureClient, buildMediaCorpus, fixtureEvents } from "matron-web";

const close = () => {};

// The card root is the containing block for the fixed-position scrim, so give it a stage the
// height of the declared viewport (minus the capture gutter) for the overlay to cover.
const Stage = ({ children }: { children: React.ReactNode }) => <div style={{ height: 620 }}>{children}</div>;
const client = createFixtureClient({ screen: "chat" });

// The conversation's media: the dashboard screenshot from the fixture thread plus the files
// an agent shared around it. Ids starting with "img" resolve to the fixture chart image.
const corpus = [
    ...buildMediaCorpus(fixtureEvents),
    {
        mediaId: "img-architecture",
        kind: "svg" as const,
        fileKind: "image" as const,
        isImageEvent: false,
        contentType: "application/octet-stream",
        filename: "journal-proxy-topology.svg",
        size: 18_224,
    },
    {
        mediaId: "img-postmortem",
        kind: "pdf" as const,
        fileKind: "pdf" as const,
        isImageEvent: false,
        contentType: "application/pdf",
        filename: "nginx-cert-rotation-postmortem.pdf",
        caption: "Post-mortem: cert rotation, 2026-09-24",
        size: 240_512,
    },
    {
        mediaId: "blob-backup",
        kind: "download" as const,
        fileKind: "archive" as const,
        isImageEvent: false,
        contentType: "application/zip",
        filename: "webapp.bak.20260724T100212Z.zip",
        size: 5_242_880,
    },
];

export const Screenshot = () => (
    <Stage><MediaViewer client={client} items={corpus} initialMediaId="img-dashboard" opener={null} onClose={close} /></Stage>
);

export const PdfDocument = () => (
    <Stage><MediaViewer client={client} items={corpus} initialMediaId="img-postmortem" opener={null} onClose={close} /></Stage>
);

export const DownloadOnly = () => (
    <Stage><MediaViewer client={client} items={corpus} initialMediaId="blob-backup" opener={null} onClose={close} /></Stage>
);

export const SingleImage = () => (
    <Stage><MediaViewer client={client} items={buildMediaCorpus(fixtureEvents)} initialMediaId="img-dashboard" opener={null} onClose={close} /></Stage>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark">
        <Stage><MediaViewer client={client} items={corpus} initialMediaId="img-dashboard" opener={null} onClose={close} /></Stage>
    </MatronThemeProvider>
);
