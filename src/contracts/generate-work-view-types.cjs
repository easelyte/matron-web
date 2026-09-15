/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_PATH = path.join(__dirname, "work-view.schema.json");
const OUTPUT_PATH = path.join(__dirname, "work-view.generated.ts");

function typeName(name) {
    return `WorkView${name.replace(/(^|[-_])(\w)/g, (_match, _separator, letter) => letter.toUpperCase())}`;
}

function refType(ref) {
    return typeName(ref.split("/").at(-1));
}

function schemaType(schema) {
    if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
    if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
    if (schema.$ref) return refType(schema.$ref);
    if (schema.oneOf) return schema.oneOf.map(schemaType).join(" | ");
    if (Array.isArray(schema.type)) return schema.type.map((value) => schemaType({ type: value })).join(" | ");

    switch (schema.type) {
        case "integer":
        case "number":
            return "number";
        case "string":
            return "string";
        case "boolean":
            return "boolean";
        case "null":
            return "null";
        case "array": {
            const itemType = schemaType(schema.items);
            if (schema.maxItems === 0) return "[]";
            if (schema.minItems >= 1) return `[${itemType}, ...${itemType}[]]`;
            return `Array<${itemType}>`;
        }
        case "object":
            return objectType(schema);
        default:
            throw new Error(`Unsupported JSON Schema shape: ${JSON.stringify(schema)}`);
    }
}

function objectMembers(schema, propertyOverrides = {}, forcedRequired = []) {
    const required = new Set([...(schema.required ?? []), ...forcedRequired]);
    return Object.entries(schema.properties ?? {})
        .map(([name, property]) => {
            const merged = { ...property, ...(propertyOverrides[name] ?? {}) };
            return `    ${name}${required.has(name) ? "" : "?"}: ${schemaType(merged)};`;
        })
        .join("\n");
}

function objectType(schema) {
    const members = objectMembers(schema);
    return members ? `{\n${members}\n}` : "Record<string, never>";
}

function generateDefinition(name, definition) {
    if (definition.type !== "object") return `export type ${typeName(name)} = ${schemaType(definition)};`;
    return `export interface ${typeName(name)} {\n${objectMembers(definition)}\n}`;
}

function generateEnvelopeVariants(schema) {
    const statuses = schema.properties.status.enum;
    return statuses.map((status) => {
        const condition = schema.allOf.find((entry) => entry.if?.properties?.status?.const === status);
        if (!condition) throw new Error(`No conditional envelope schema for status ${status}`);

        const overrides = {
            ...(condition.then?.properties ?? {}),
            status: { const: status },
        };
        const forcedRequired = condition.then?.required ?? [];
        let members = objectMembers(schema, overrides, forcedRequired);
        if (condition.then?.not?.required?.includes("error")) {
            members = members.replace(/^    error\?: .*;$/m, "    error?: never;");
        }
        return `export interface ${typeName(`${status}-envelope`)} {\n${members}\n}`;
    });
}

function generateTypes(schemaBytes) {
    const schema = JSON.parse(schemaBytes.toString("utf8"));
    const digest = crypto.createHash("sha256").update(schemaBytes).digest("hex");
    const definitions = Object.entries(schema.definitions ?? {}).map(([name, definition]) =>
        generateDefinition(name, definition),
    );
    const variants = generateEnvelopeVariants(schema);
    const union = schema.properties.status.enum.map((status) => typeName(`${status}-envelope`)).join(" | ");
    const constants = [
        ["WORK_VIEW_STATUS_VALUES", schema.properties.status.enum],
        ["WORK_VIEW_GROUP_BY_VALUES", schema.properties.group_by.enum],
        ["WORK_VIEW_LOOP_STATUS_VALUES", schema.definitions.loop.properties.status.enum],
        ["WORK_VIEW_LIVENESS_VALUES", schema.definitions.claim.properties.liveness.enum],
        ["WORK_VIEW_ERROR_CODE_VALUES", schema.definitions.error.properties.code.enum],
    ].map(([name, values]) => {
        const inline = `export const ${name} = [${values.map((value) => JSON.stringify(value)).join(", ")}] as const;`;
        if (inline.length <= 120) return inline;
        return `export const ${name} = [\n${values.map((value) => `    ${JSON.stringify(value)},`).join("\n")}\n] as const;`;
    });

    return `/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.

GENERATED FILE — DO NOT EDIT.
Source: src/contracts/work-view.schema.json
Source SHA-256: ${digest}
Regenerate: node src/contracts/generate-work-view-types.cjs
*/

${definitions.join("\n\n")}

${variants.join("\n\n")}

export type WorkViewEnvelope = ${union};

${constants.join("\n")}
`;
}

function main() {
    const generated = generateTypes(fs.readFileSync(SCHEMA_PATH));
    if (process.argv.includes("--check")) {
        const checkedIn = fs.readFileSync(OUTPUT_PATH, "utf8");
        if (checkedIn !== generated) {
            throw new Error("Generated Work-view types have drifted; run the generator and check in the result.");
        }
        return;
    }
    fs.writeFileSync(OUTPUT_PATH, generated);
}

module.exports = { generateTypes, OUTPUT_PATH, SCHEMA_PATH };

if (require.main === module) main();
