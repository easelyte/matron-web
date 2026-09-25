import { MatronThemeProvider, ToolStream } from "matron-web";

const ESC = "\u001b";

const testRun = {
    messageRef: "msg-test-run",
    command: "npm test -- --runInBand journal",
    content: [
        `${ESC}[1m> matron-web@1.12.0 test${ESC}[0m`,
        "",
        ` ${ESC}[32mPASS${ESC}[0m  test/unit-tests/journal/components-test.ts (8.4 s)`,
        ` ${ESC}[32mPASS${ESC}[0m  test/unit-tests/journal/client-test.ts`,
        ` ${ESC}[31mFAIL${ESC}[0m  test/unit-tests/journal/upload-test.ts`,
        `   ${ESC}[31m●${ESC}[0m upload › retries after a 504 from the media endpoint`,
        `     ${ESC}[2mTimeout - Async callback was not invoked within 5000 ms${ESC}[0m`,
        ` ${ESC}[33mRUNS${ESC}[0m  test/unit-tests/journal/files-test.ts`,
    ].join("\n"),
    offset: 0,
    headTruncated: false,
};

const buildTail = {
    messageRef: "msg-build",
    command: "npm run build",
    content: [
        "asset journal.js 1.84 MiB [emitted] [minimized] (name: journal)",
        "asset journal.css 212 KiB [emitted] (name: journal)",
        `${ESC}[33mWARNING${ESC}[0m in asset size limit: journal.js exceeds the recommended size (244 KiB)`,
        `webpack 5.98.0 compiled with ${ESC}[1m${ESC}[33m1 warning${ESC}[0m in 41213 ms`,
    ].join("\n"),
    offset: 184_320,
    headTruncated: true,
};

const toolOnly = {
    messageRef: "msg-grep",
    tool: "Grep",
    content: "src/journal/components.tsx:4297: export function DiffCard(\nsrc/journal/components.tsx:4504: export function EventContent(",
    offset: 0,
    headTruncated: false,
};

export const RunningTests = () => (
    <ol className="mx_RoomView_MessageList" style={{ maxWidth: 760 }}>
        <ToolStream stream={testRun} />
    </ol>
);

export const LongOutputTail = () => (
    <ol className="mx_RoomView_MessageList" style={{ maxWidth: 760 }}>
        <ToolStream stream={buildTail} />
    </ol>
);

export const ToolWithoutCommand = () => (
    <ol className="mx_RoomView_MessageList" style={{ maxWidth: 760 }}>
        <ToolStream stream={toolOnly} />
    </ol>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark" surface="default">
        <ol className="mx_RoomView_MessageList" style={{ maxWidth: 760 }}>
            <ToolStream stream={testRun} />
        </ol>
    </MatronThemeProvider>
);
