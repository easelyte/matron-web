const { deserialize, serialize } = require("node:v8");
const { TextDecoder, TextEncoder } = require("node:util");

globalThis.structuredClone ??= (value) => deserialize(serialize(value));
// jsdom does not expose the TextEncoder/TextDecoder globals the app uses to decode fetch bodies
// (api.ts, files/filesApi.ts); provide the Node implementations only when absent.
globalThis.TextEncoder ??= TextEncoder;
globalThis.TextDecoder ??= TextDecoder;

Element.prototype.scrollIntoView = jest.fn();
