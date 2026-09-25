import { DiffCard, MatronThemeProvider, fixtureEvents, parseDiffPayload } from "matron-web";

const nginxEdit = parseDiffPayload(fixtureEvents.find((event) => event.type === "diff")!.payload);

const LONG_DIFF = [
    "@@ -12,18 +12,24 @@ export async function deployRelease(release: Release): Promise<void> {",
    "     const target = join(RELEASES_DIR, release.version);",
    "-    await rsync(release.buildDir, CURRENT_DIR);",
    "+    await mkdir(target, { recursive: true });",
    "+    await rsync(release.buildDir, target);",
    "+    await verifyChecksums(target, release.manifest);",
    "+    // Atomic repoint: rollback is just pointing `current` at the previous release.",
    "+    await symlinkSwap(target, CURRENT_LINK);",
    "     await reloadNginx();",
    "-    log.info(\"deployed\", { version: release.version });",
    "+    log.info(\"deployed\", { version: release.version, path: target });",
    "+    await pruneReleases(RELEASES_DIR, { keep: 5 });",
    " }",
    " ",
    " export async function rollback(): Promise<void> {",
    "-    throw new Error(\"rollback not supported\");",
    "+    const previous = await previousRelease(RELEASES_DIR);",
    "+    if (!previous) throw new Error(\"no previous release to roll back to\");",
    "+    await symlinkSwap(previous, CURRENT_LINK);",
    "+    await reloadNginx();",
    " }",
].join("\n");

const NEW_FILE_DIFF = [
    "@@ -0,0 +1,9 @@",
    "+[Unit]",
    "+Description=Nightly journal backup rotation",
    "+",
    "+[Service]",
    "+Type=oneshot",
    "+ExecStart=/opt/matron/bin/rotate-backups --keep 7",
    "+",
    "+[Install]",
    "+WantedBy=multi-user.target",
].join("\n");

// Viewer tokens carry a base64url JSON payload with an `exp` (epoch seconds).
const viewerToken = (exp: number): string => btoa(JSON.stringify({ exp })).replace(/=+$/, "");
const liveViewer = `https://files.example.test/view?token=${viewerToken(4_102_444_800)}.sig`;
const expiredViewer = `https://files.example.test/view?token=${viewerToken(1_700_000_000)}.sig`;

export const NginxEdit = () => (
    <div style={{ maxWidth: 620 }}>
        <DiffCard data={nginxEdit} />
    </div>
);

export const LongDiffFolded = () => (
    <div style={{ maxWidth: 620 }}>
        <DiffCard
            data={parseDiffPayload({
                tool: "Edit",
                file_path: "/opt/matron/web-journal/scripts/deploy.ts",
                display_path: "scripts/deploy.ts",
                added: 13,
                removed: 3,
                diff: LONG_DIFF,
                viewer_url: liveViewer,
            })}
        />
    </div>
);

export const NewFileAndTruncated = () => (
    <div style={{ maxWidth: 620, display: "flex", flexDirection: "column", gap: 12 }}>
        <DiffCard
            data={parseDiffPayload({
                tool: "Write",
                file_path: "systemd/backup-rotate.service",
                new_file: true,
                added: 9,
                removed: 0,
                diff: NEW_FILE_DIFF,
            })}
        />
        <DiffCard
            data={parseDiffPayload({
                tool: "MultiEdit",
                file_path: "src/journal/journal.pcss",
                label: "3 hunks",
                added: 48,
                removed: 21,
                truncated: true,
                viewer_url: expiredViewer,
                diff: "@@ -981,8 +981,10 @@\n .mj_PinnedSummary {\n-    margin: 8px 16px;\n+    margin: 8px 20px 12px 20px;\n     border: 1px solid var(--cpd-color-border-subtle);\n+    box-shadow: var(--cpd-shadow-sm);",
            })}
        />
    </div>
);

export const Dark = () => (
    <MatronThemeProvider theme="dark" surface="default">
        <div style={{ maxWidth: 620 }}>
            <DiffCard data={nginxEdit} />
        </div>
    </MatronThemeProvider>
);

export const PhoneWidth = () => (
    <div style={{ width: 360 }}>
        <DiffCard data={nginxEdit} />
    </div>
);
