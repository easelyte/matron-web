// Hosts the conformance runner: the replay coordinator spawns jest with this config and
// talks to the runner over stdio (see scripts/conformance/replay.mjs).
module.exports = {
    testEnvironment: "<rootDir>/test/conformance/jest-env.cjs",
    testEnvironmentOptions: { url: "http://localhost/" },
    testMatch: ["<rootDir>/test/conformance/stdio-host-test.ts"],
    transform: { "^.+\\.[jt]sx?$": "babel-jest" },
    transformIgnorePatterns: [],
    setupFiles: ["<rootDir>/test/setup.cjs"],
    modulePathIgnorePatterns: ["<rootDir>/.nx/"],
    testTimeout: 1_800_000,
};
