module.exports = {
    sourceMaps: true,
    presets: [
        ["@babel/preset-env", { targets: "last 2 versions" }],
        ["@babel/preset-typescript", { allowDeclareFields: true }],
        ["@babel/preset-react", { runtime: "automatic" }],
    ],
};
