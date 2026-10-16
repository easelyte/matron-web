// Targets come from the "browserslist" field in package.json, which PostCSS reads too. Its first
// entry follows current browsers; the version floors after it keep the build working for those
// that "last 2 versions" no longer lists but the app still has to run on: Safari and iOS 18
// (devices that cannot update to 26) and the Chromium in the Desktop app's Electron, which
// trails Chrome by a few releases. Without them, a browser data update could stop Babel
// compiling syntax those engines lack.
module.exports = {
    sourceMaps: true,
    presets: [
        "@babel/preset-env",
        ["@babel/preset-typescript", { allowDeclareFields: true }],
        ["@babel/preset-react", { runtime: "automatic" }],
    ],
};
