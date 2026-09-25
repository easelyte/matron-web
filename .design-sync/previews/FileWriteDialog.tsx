import { FileWriteDialog, createFixtureFilesApi, FIXTURE_FILES_ROOT } from "matron-web";

const api = createFixtureFilesApi();
const noop = () => {};

// The dialog's scrim is position: fixed. The transformed frame becomes its containing block, so
// the scrim + card fill this viewport-sized frame instead of escaping the captured card.
const Frame = ({ children }: { children: React.ReactNode }) => (
    <div style={{ position: "relative", height: 560, transform: "translateZ(0)", overflow: "hidden" }}>{children}</div>
);
const docs = `${FIXTURE_FILES_ROOT}/docs`;
const key = "idem-7f3a2c";

const screenshot = new File([new Uint8Array(248_320)], "Screenshot 2026-09-25 at 10.12.05.png", { type: "image/png" });
const readme = new File([new Uint8Array(4_310)], "README.md", { type: "text/markdown" });
const log = new File([new Uint8Array(18_432)], "bridge-restart.log", { type: "text/plain" });

export const Upload = () => (
    <Frame>
    <FileWriteDialog
        api={api}
        onSubmit={noop}
        onCancel={noop}
        state={{ pending: { kind: "upload", dir: docs, files: [screenshot, log], index: 0 }, phase: "confirming", idempotencyKey: key }}
    />
    </Frame>
);

export const NewFolder = () => (
    <Frame>
    <FileWriteDialog
        api={api}
        onSubmit={noop}
        onCancel={noop}
        state={{ pending: { kind: "mkdir", dir: docs }, phase: "confirming", idempotencyKey: key }}
    />
    </Frame>
);

export const Rename = () => (
    <Frame>
    <FileWriteDialog
        api={api}
        onSubmit={noop}
        onCancel={noop}
        state={{
            pending: { kind: "rename", dir: docs, path: `${docs}/design-methodology.md`, name: "design-methodology.md", isDir: false },
            phase: "confirming",
            idempotencyKey: key,
        }}
    />
    </Frame>
);

export const Delete = () => (
    <Frame>
    <FileWriteDialog
        api={api}
        onSubmit={noop}
        onCancel={noop}
        state={{
            pending: { kind: "delete", path: `${FIXTURE_FILES_ROOT}/tmp/2026-09-19-bridge-oom`, name: "2026-09-19-bridge-oom", isDir: true },
            phase: "confirming",
            idempotencyKey: key,
        }}
    />
    </Frame>
);

export const UploadConflict = () => (
    <Frame>
    <FileWriteDialog
        api={api}
        onSubmit={noop}
        onCancel={noop}
        state={{
            pending: { kind: "upload", dir: docs, files: [readme], index: 0 },
            phase: "confirming",
            idempotencyKey: key,
            error: "That change conflicts with what's already there. Check the name and try again.",
        }}
    />
    </Frame>
);

export const Deleting = () => (
    <Frame>
    <FileWriteDialog
        api={api}
        onSubmit={noop}
        onCancel={noop}
        state={{
            pending: { kind: "delete", path: `${FIXTURE_FILES_ROOT}/archive.zip`, name: "archive.zip", isDir: false },
            phase: "mutating",
            idempotencyKey: key,
        }}
    />
    </Frame>
);
