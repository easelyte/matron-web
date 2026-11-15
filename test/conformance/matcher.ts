/*
Copyright 2026 Matron Contributors.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// The conformance matcher: the four rules of the fixture variable convention
// ($bind, $ref, $type, $ignore), as written up in the journal's fixture README.
// Plain objects match on an exact key set, arrays on length and order, everything
// else with ===.

export type Bindings = Record<string, unknown>;
export type MatchResult = { ok: true } | { ok: false; reason: string };

const VAR_KEYS = ["$bind", "$ref", "$type", "$ignore"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isVarNode(value: unknown): value is Record<string, unknown> {
    return isPlainObject(value) && VAR_KEYS.some((key) => key in value);
}

function typeMatches(actual: unknown, type: string): boolean {
    switch (type) {
        case "integer":
            return typeof actual === "number" && Number.isInteger(actual);
        case "number":
            return typeof actual === "number";
        case "string":
            return typeof actual === "string";
        case "boolean":
            return typeof actual === "boolean";
        case "null":
            return actual === null;
        case "array":
            return Array.isArray(actual);
        case "object":
            return isPlainObject(actual);
        default:
            throw new Error(`unknown $type: ${type}`);
    }
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
    }
    if (typeof a === "object") {
        const left = a as Record<string, unknown>;
        const right = b as Record<string, unknown>;
        const keys = Object.keys(left).sort();
        const other = Object.keys(right).sort();
        return (
            keys.length === other.length && keys.every((key, i) => key === other[i] && deepEqual(left[key], right[key]))
        );
    }
    return false;
}

export function match(expected: unknown, actual: unknown, bindings: Bindings, at = "$"): MatchResult {
    if (isVarNode(expected)) {
        if ("$ignore" in expected) return { ok: true };
        if ("$bind" in expected) {
            bindings[expected.$bind as string] = actual;
            return { ok: true };
        }
        if ("$ref" in expected) {
            const name = expected.$ref as string;
            if (!(name in bindings)) return { ok: false, reason: `${at}: $ref '${name}' is unbound` };
            return deepEqual(bindings[name], actual)
                ? { ok: true }
                : {
                      ok: false,
                      reason: `${at}: expected $ref '${name}' = ${JSON.stringify(bindings[name])}, got ${JSON.stringify(actual)}`,
                  };
        }
        return typeMatches(actual, expected.$type as string)
            ? { ok: true }
            : { ok: false, reason: `${at}: expected $type '${String(expected.$type)}', got ${JSON.stringify(actual)}` };
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual))
            return { ok: false, reason: `${at}: expected an array, got ${JSON.stringify(actual)}` };
        if (expected.length !== actual.length) {
            return { ok: false, reason: `${at}: expected array length ${expected.length}, got ${actual.length}` };
        }
        for (let i = 0; i < expected.length; i++) {
            const result = match(expected[i], actual[i], bindings, `${at}[${i}]`);
            if (!result.ok) return result;
        }
        return { ok: true };
    }
    if (isPlainObject(expected)) {
        if (!isPlainObject(actual))
            return { ok: false, reason: `${at}: expected an object, got ${JSON.stringify(actual)}` };
        const expectedKeys = Object.keys(expected).sort();
        const actualKeys = Object.keys(actual).sort();
        if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, i) => key !== actualKeys[i])) {
            return { ok: false, reason: `${at}: key set mismatch, expected [${expectedKeys}], got [${actualKeys}]` };
        }
        for (const key of expectedKeys) {
            const result = match(expected[key], actual[key], bindings, `${at}.${key}`);
            if (!result.ok) return result;
        }
        return { ok: true };
    }
    return expected === actual
        ? { ok: true }
        : { ok: false, reason: `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` };
}

/** Fixture value to outbound wire value: only $ref is legal here. */
export function resolve(template: unknown, bindings: Bindings): unknown {
    if (isPlainObject(template) && "$ref" in template) {
        const name = template.$ref as string;
        if (!(name in bindings)) throw new Error(`$ref '${name}' is unbound`);
        return bindings[name];
    }
    if (Array.isArray(template)) return template.map((value) => resolve(value, bindings));
    if (isPlainObject(template)) {
        return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, resolve(value, bindings)]));
    }
    return template;
}

/** `${name}` interpolation for URL paths and header values. */
export function resolveString(text: string, bindings: Bindings): string {
    return text.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
        if (!(name in bindings)) throw new Error(`'\${${name}}' is unbound`);
        return String(bindings[name]);
    });
}
