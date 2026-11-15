#!/usr/bin/env node
// Replays the shared journal fixtures with this app playing the client role.
//
//   MATRON_CONFORMANCE_COORDINATOR=<checkout that has the replay coordinator>
//   MATRON_CONFORMANCE_TARBALL=<the packed conformance .tgz>   (or MATRON_CONFORMANCE_DIR)
//   node scripts/conformance/replay.mjs [fixture-name-substring ...]
//
// The coordinator (tools/conformance-server.js in the journal) boots a seeded journal per
// fixture, plays the agent and admin roles, and spawns the runner in test/conformance
// over stdio. Exits non-zero if any fixture fails; a skipped fixture is reported, not hidden.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageDir } from "./package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const journal = process.env.MATRON_CONFORMANCE_COORDINATOR;
if (!journal) {
    console.error("MATRON_CONFORMANCE_COORDINATOR must point at a checkout that has tools/conformance-server.js");
    process.exit(2);
}
const dir = packageDir();
const filters = process.argv.slice(2);
const fixtures = fs
    .readdirSync(dir)
    .filter((name) => /^\d.*\.json$/.test(name) && (filters.length === 0 || filters.some((f) => name.includes(f))))
    .sort();
if (fixtures.length === 0) {
    console.error("no fixtures selected");
    process.exit(2);
}

const runnerArgs = [
    path.join(root, "node_modules", "jest", "bin", "jest.js"),
    "--config",
    path.join(root, "jest.conformance.config.cjs"),
    "--rootDir",
    root,
    "--runInBand",
    "--silent",
];
// The coordinator's server writes key files into its working directory; keep them out of the tree.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "matron-conformance-run-"));
const counts = { pass: 0, skip: 0, fail: 0 };
for (const name of fixtures) {
    const args = [
        path.join(journal, "tools", "conformance-server.js"),
        "--replay",
        path.join(dir, name),
        "--runner",
        process.execPath,
        ...runnerArgs.flatMap((arg) => ["--runner-arg", arg]),
    ];
    const run = spawnSync(process.execPath, args, { encoding: "utf8", cwd: scratch, timeout: 120_000 });
    let result;
    try {
        result = JSON.parse(run.stdout.trim().split("\n").pop());
    } catch {
        result = { status: "fail", reason: `no result line (exit ${run.status}): ${(run.stderr ?? "").slice(-400)}` };
    }
    const status = run.status === 0 ? (result.status ?? "pass") : "fail";
    const bucket = status === "fail" || status === "invalid" ? "fail" : status.startsWith("skip") ? "skip" : "pass";
    counts[bucket] += 1;
    console.log(`${bucket.padEnd(5)} ${name}${bucket === "pass" ? "" : ` ${JSON.stringify(result)}`}`);
}
console.log(`${counts.pass} passed, ${counts.skip} skipped, ${counts.fail} failed`);
process.exit(counts.fail ? 1 : 0);
