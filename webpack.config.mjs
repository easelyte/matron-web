/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import dotenv from "dotenv";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import CopyWebpackPlugin from "copy-webpack-plugin";
import HtmlWebpackPlugin from "html-webpack-plugin";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import MinimizerPlugin from "minimizer-webpack-plugin";
import postcssPresetEnv from "postcss-preset-env";
import webpack from "webpack";
import "webpack-dev-server";

import packageJson from "./package.json" with { type: "json" };

dotenv.config();

const root = path.dirname(fileURLToPath(import.meta.url));

class VersionAssetPlugin {
    constructor(version) {
        this.version = version;
    }

    apply(compiler) {
        compiler.hooks.thisCompilation.tap("VersionAssetPlugin", (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: "VersionAssetPlugin",
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
                },
                () => compilation.emitAsset("version", new webpack.sources.RawSource(this.version)),
            );
        });
    }
}

// A Content-Security-Policy for index.html, as a <meta> so it ships with the app wherever it is
// served (the browser build and the desktop shell alike). It limits script to the app's own
// bundles plus the one inline theme script, which is allowed by its hash, worked out from the
// emitted page so the two cannot drift apart. The journal can be on any https origin the user
// signs in to, so connect-src stays open to https:/wss: (and plain http/ws on loopback only, as
// normalizeServerUrl allows). Media and SVG previews load from blob: and data: URLs. A meta
// policy cannot carry frame-ancestors; that has to come from the server's response headers.
class ContentSecurityPolicyPlugin {
    constructor(scriptOrigins) {
        this.scriptOrigins = scriptOrigins;
    }

    apply(compiler) {
        compiler.hooks.compilation.tap("ContentSecurityPolicyPlugin", (compilation) => {
            HtmlWebpackPlugin.getHooks(compilation).beforeEmit.tap("ContentSecurityPolicyPlugin", (data) => {
                const hashes = [...data.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
                    ([, body]) => `'sha256-${createHash("sha256").update(body).digest("base64")}'`,
                );
                const loopback = "http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*";
                const policy = [
                    "default-src 'self'",
                    `script-src 'self' ${[...this.scriptOrigins, ...hashes].join(" ")} 'wasm-unsafe-eval'`.replace(
                        / +/g,
                        " ",
                    ),
                    "style-src 'self' 'unsafe-inline'",
                    "img-src 'self' blob: data:",
                    "media-src 'self' blob:",
                    "font-src 'self' data:",
                    `connect-src 'self' blob: https: wss: ${loopback}`,
                    "worker-src 'self' blob:",
                    "object-src 'none'",
                    "base-uri 'self'",
                    "form-action 'self'",
                ].join("; ");
                const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
                data.html = data.html.replace(/<meta charset="utf-8"\s*\/?>/i, (charset) => `${charset}${meta}`);
                if (!data.html.includes(meta))
                    throw new Error("ContentSecurityPolicyPlugin: no <meta charset> to follow");
                return data;
            });
        });
    }
}

export default (_environment, arguments_) => {
    const development = arguments_.mode !== "production";
    const version = process.env.VERSION ?? `${packageJson.version}${development ? "-dev" : ""}`;
    // Where webapp/ is served from. Every URL the build emits starts with it, so index.html also
    // works at the client-side routes the journal serves it for (/u/*, /app/*).
    const publicPath = (process.env.PUBLIC_PATH || "/").replace(/\/*$/, "/");

    return {
        mode: development ? "development" : "production",
        bail: true,
        devtool: development ? "inline-source-map" : "source-map",
        entry: "./src/journal/index.tsx",
        output: {
            path: path.join(root, "webapp"),
            publicPath,
            filename: "assets/[name].[contenthash:8].js",
            chunkFilename: "assets/[name].[contenthash:8].js",
            assetModuleFilename: "assets/[name].[contenthash:8][ext]",
            clean: true,
        },
        resolve: {
            extensions: [".js", ".json", ".ts", ".tsx"],
        },
        optimization: {
            // pdf.js ships pdf.worker.min.mjs already minified; re-running Terser over it breaks
            // its private fields ("Private field '#T' must be declared in an enclosing class"),
            // so exclude it. Same plugin + options as webpack's default minimizer.
            minimizer: [
                new MinimizerPlugin({
                    exclude: /pdf\.worker\.min\..*\.mjs$/,
                    terserOptions: { compress: { passes: 2 } },
                }),
                // Webpack minifies only JS by default. Without this the stylesheet ships with its
                // comments and indentation, nearly doubling its compressed size.
                new MinimizerPlugin({
                    test: /\.css$/i,
                    minify: MinimizerPlugin.cleanCssMinify,
                    minimizerOptions: { level: 1 },
                }),
            ],
        },
        module: {
            rules: [
                {
                    test: /\.[jt]sx?$/,
                    include: path.join(root, "src"),
                    use: {
                        loader: "babel-loader",
                        options: { cacheDirectory: true },
                    },
                },
                {
                    test: /\.(?:css|pcss)$/,
                    use: [
                        MiniCssExtractPlugin.loader,
                        { loader: "css-loader", options: { importLoaders: 1, sourceMap: true } },
                        {
                            loader: "postcss-loader",
                            options: {
                                sourceMap: true,
                                postcssOptions: {
                                    plugins: [postcssPresetEnv({ stage: 3 })],
                                },
                            },
                        },
                    ],
                },
                {
                    test: /\.(?:gif|ico|jpe?g|png|svg|ttf|woff2?)$/,
                    type: "asset/resource",
                },
            ],
        },
        plugins: [
            new MiniCssExtractPlugin({ filename: "assets/[name].[contenthash:8].css" }),
            new HtmlWebpackPlugin({ template: "./src/index.html", minify: !development }),
            // Bundles served from another origin (an absolute PUBLIC_PATH) must be allowed too.
            new ContentSecurityPolicyPlugin(/^https?:\/\//.test(publicPath) ? [new URL(publicPath).origin] : []),
            new CopyWebpackPlugin({
                patterns: [
                    { from: "res/manifest.json", noErrorOnMissing: true },
                    { from: "res/icons", to: "icons", noErrorOnMissing: true },
                    { from: "res/opengraph.png", noErrorOnMissing: true },
                    { from: "config.json", noErrorOnMissing: true },
                ],
            }),
            new webpack.DefinePlugin({
                "process.env.VERSION": JSON.stringify(version),
                "process.env.PUBLIC_PATH": JSON.stringify(publicPath),
            }),
            new VersionAssetPlugin(version),
        ],
        devServer: {
            host: "127.0.0.1",
            port: Number(process.env.MATRON_WEB_PORT ?? 8080),
            historyApiFallback: true,
            static: { directory: path.join(root, "webapp") },
            devMiddleware: { stats: "minimal" },
            client: { overlay: { errors: true, warnings: false, runtimeErrors: false } },
            proxy: [
                {
                    context: ["/journal"],
                    target: process.env.MATRON_JOURNAL_URL ?? "http://127.0.0.1:9810",
                    pathRewrite: { "^/journal": "" },
                    changeOrigin: true,
                    ws: true,
                },
            ],
        },
    };
};
