/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import CopyWebpackPlugin from "copy-webpack-plugin";
import HtmlWebpackPlugin from "html-webpack-plugin";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
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

export default (_environment, arguments_) => {
    const development = arguments_.mode !== "production";
    const version = process.env.VERSION ?? `${packageJson.version}${development ? "-dev" : ""}`;

    return {
        mode: development ? "development" : "production",
        bail: true,
        devtool: development ? "inline-source-map" : "source-map",
        entry: "./src/journal/index.tsx",
        output: {
            path: path.join(root, "webapp"),
            filename: "assets/[name].[contenthash:8].js",
            chunkFilename: "assets/[name].[contenthash:8].js",
            assetModuleFilename: "assets/[name].[contenthash:8][ext]",
            clean: true,
        },
        resolve: {
            extensions: [".js", ".json", ".ts", ".tsx"],
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
                                    plugins: [postcssPresetEnv({ stage: 3, browsers: "last 2 versions" })],
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
            new CopyWebpackPlugin({
                patterns: [
                    { from: "res/.well-known", to: ".well-known", noErrorOnMissing: true },
                    { from: "res/manifest.json", noErrorOnMissing: true },
                    { from: "res/vector-icons", to: "vector-icons", noErrorOnMissing: true },
                    { from: "res/opengraph.png", noErrorOnMissing: true },
                    { from: "config.json", noErrorOnMissing: true },
                ],
            }),
            new webpack.DefinePlugin({ "process.env.VERSION": JSON.stringify(version) }),
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
