// Locates the pinned conformance package on disk and checks it against test/conformance/package-pin.json.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readPin() {
    return JSON.parse(fs.readFileSync(path.join(root, "test", "conformance", "package-pin.json"), "utf8"));
}

/** Directory of the extracted package: MATRON_CONFORMANCE_DIR, else the tarball extracted to a temp dir. */
export function packageDir() {
    let dir = process.env.MATRON_CONFORMANCE_DIR;
    if (!dir && process.env.MATRON_CONFORMANCE_TARBALL) {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), "matron-conformance-"));
        execFileSync("tar", ["-xzf", process.env.MATRON_CONFORMANCE_TARBALL, "-C", out, "--strip-components=1"]);
        dir = out;
    }
    if (!dir) throw new Error("set MATRON_CONFORMANCE_DIR (extracted package) or MATRON_CONFORMANCE_TARBALL (the .tgz)");
    const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "manifest.json"))).digest("hex");
    const pin = readPin();
    if (digest !== pin.manifestSha256) {
        throw new Error(`conformance package manifest ${digest} does not match the pin ${pin.manifestSha256} (version ${pin.version})`);
    }
    return dir;
}
