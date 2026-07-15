module.exports = {
    testEnvironment: "jsdom",
    testEnvironmentOptions: { url: "http://localhost/" },
    testMatch: ["<rootDir>/test/unit-tests/journal/**/*-test.ts"],
    transform: { "^.+\\.[jt]sx?$": "babel-jest" },
    setupFiles: ["<rootDir>/test/setup.cjs"],
    modulePathIgnorePatterns: ["<rootDir>/.nx/"],
    collectCoverageFrom: ["<rootDir>/src/journal/**/*.{ts,tsx}", "!<rootDir>/src/journal/index.tsx"],
    coverageReporters: ["text-summary", "lcov"],
};
