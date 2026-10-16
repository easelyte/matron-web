/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Visual-fidelity fixtures build. Reuses the app's EXACT module rules (babel-loader +
 * postcss-loader) so the emitted CSS is byte-for-byte the production pipeline — the whole
 * point is to diff the real build, not a second bundler's rendering. Outputs to
 * .fixtures-dist/ (its own dir — never touches webapp/). NOT part of any deploy.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import HtmlWebpackPlugin from "html-webpack-plugin";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import MinimizerPlugin from "minimizer-webpack-plugin";
import postcssPresetEnv from "postcss-preset-env";

const root = path.dirname(fileURLToPath(import.meta.url));

export default () => ({
    mode: "production",
    bail: true,
    devtool: false,
    entry: "./fixtures/index.tsx",
    output: {
        path: path.join(root, ".fixtures-dist"),
        filename: "assets/[name].[contenthash:8].js",
        chunkFilename: "assets/[name].[contenthash:8].js",
        assetModuleFilename: "assets/[name].[contenthash:8][ext]",
        clean: true,
    },
    resolve: { extensions: [".js", ".json", ".ts", ".tsx"] },
    // Same CSS minifier as the app build, so the screenshots show the CSS that ships.
    optimization: {
        minimizer: [
            "...",
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
                include: [path.join(root, "src"), path.join(root, "fixtures")],
                use: { loader: "babel-loader", options: { cacheDirectory: true } },
            },
            {
                test: /\.(?:css|pcss)$/,
                use: [
                    MiniCssExtractPlugin.loader,
                    { loader: "css-loader", options: { importLoaders: 1 } },
                    {
                        loader: "postcss-loader",
                        options: {
                            postcssOptions: {
                                plugins: [postcssPresetEnv({ stage: 3 })],
                            },
                        },
                    },
                ],
            },
            { test: /\.(?:gif|ico|jpe?g|png|svg|ttf|woff2?)$/, type: "asset/resource" },
        ],
    },
    plugins: [
        new MiniCssExtractPlugin({ filename: "assets/[name].[contenthash:8].css" }),
        new HtmlWebpackPlugin({ template: "./fixtures/index.html", filename: "index.html" }),
    ],
});
