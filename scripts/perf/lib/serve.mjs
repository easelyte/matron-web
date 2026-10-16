/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Serves a built webapp/ and proxies /journal (HTTP and the WebSocket) to a journal, the
 * same-origin layout the README recommends for a deployment. Assets are served with the
 * cache headers a deployment uses, and optionally compressed, so transfer sizes are honest.
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm",
};

const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".webmanifest"]);

export function serveApp({ webDir, journalUrl, port = 0 }) {
    const target = new URL(journalUrl);
    const cache = new Map();
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname.startsWith("/journal/")) {
            const upstream = http.request(
                {
                    host: target.hostname,
                    port: target.port,
                    method: req.method,
                    path: url.pathname.slice("/journal".length) + url.search,
                    headers: { ...req.headers, host: target.host },
                },
                (up) => {
                    res.writeHead(up.statusCode, up.headers);
                    up.pipe(res);
                },
            );
            upstream.on("error", () => {
                res.writeHead(502);
                res.end();
            });
            req.pipe(upstream);
            return;
        }
        let file = path.join(webDir, decodeURIComponent(url.pathname));
        if (!file.startsWith(webDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            file = path.join(webDir, "index.html");
        }
        const ext = path.extname(file);
        const accepts = String(req.headers["accept-encoding"] ?? "");
        const encoding = COMPRESSIBLE.has(ext)
            ? accepts.includes("br")
                ? "br"
                : accepts.includes("gzip")
                  ? "gzip"
                  : null
            : null;
        const key = `${file}:${encoding}`;
        let body = cache.get(key);
        if (!body) {
            body = fs.readFileSync(file);
            if (encoding === "br") body = zlib.brotliCompressSync(body);
            else if (encoding === "gzip") body = zlib.gzipSync(body);
            cache.set(key, body);
        }
        res.writeHead(200, {
            "content-type": MIME[ext] ?? "application/octet-stream",
            "cache-control": url.pathname.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
            ...(encoding ? { "content-encoding": encoding } : {}),
            "content-length": body.length,
        });
        res.end(body);
    });
    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url, "http://localhost");
        if (!url.pathname.startsWith("/journal/")) return socket.destroy();
        const upstream = net.connect(Number(target.port), target.hostname, () => {
            const lines = [`${req.method} ${url.pathname.slice("/journal".length)}${url.search} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const name = req.rawHeaders[i];
                lines.push(`${name}: ${name.toLowerCase() === "host" ? target.host : req.rawHeaders[i + 1]}`);
            }
            upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
            if (head?.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
    });
    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}`,
                close: () =>
                    new Promise((r) => {
                        server.closeAllConnections?.();
                        server.close(r);
                    }),
            });
        });
    });
}
