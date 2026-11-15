// jsdom plus the Node networking globals the journal client expects in a browser
// (fetch and its classes). The WebSocket stays jsdom's.
const { TestEnvironment } = require("jest-environment-jsdom");

class ConformanceEnvironment extends TestEnvironment {
    constructor(config, context) {
        super(config, context);
        for (const name of ["fetch", "Headers", "Request", "Response"]) {
            this.global[name] = globalThis[name];
        }
    }
}

module.exports = ConformanceEnvironment;
