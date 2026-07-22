const { deserialize, serialize } = require("node:v8");

globalThis.structuredClone ??= (value) => deserialize(serialize(value));

Element.prototype.scrollIntoView = jest.fn();
