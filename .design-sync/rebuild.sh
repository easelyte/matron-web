#!/usr/bin/env bash
# Full rebuild: synthesize the package (copy + shims + CSS + .d.ts), then convert.
# Run from the repo root, one at a time, under the memory cap (see NOTES.md).
set -e
node .design-sync/build-pkg.mjs
node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules ./node_modules --entry ./.ds-sync/pkg/index.mjs --out ./ds-bundle "$@"
