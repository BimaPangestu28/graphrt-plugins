import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalogEntry } from "../lib/plugin-package.mjs";
import { readWasmRuntimes } from "../lib/plugin-runtimes.mjs";
import { REPO_ROOT } from "../plugins.mjs";

const REST_KIT_BUILDS = ["open-meteo", "currency-rates", "wikipedia", "web-search"];
const readJson = (...parts) => JSON.parse(readFileSync(join(REPO_ROOT, ...parts), "utf8"));

for (const pluginName of REST_KIT_BUILDS) {
  test(`${pluginName}: the rest-kit build is a catalog runtime with every node and tool of the Node.js plugin`, () => {
    const processManifest = readJson(pluginName, "graphrt-plugin.json");
    const wasmManifest = readJson("wasm", pluginName, "graphrt-plugin.json");
    assert.deepEqual(wasmManifest.nodes, processManifest.nodes);
    assert.deepEqual(wasmManifest.tools, processManifest.tools);
    assert.deepEqual(wasmManifest.permissions, processManifest.permissions);
    const entry = buildCatalogEntry(processManifest, { sha256: "0", sizeBytes: 1 }, undefined, (name) => ({ assetName: `icon-${name}-0123456789ab.svg` }), readWasmRuntimes(REPO_ROOT, "o/r"));
    const [processRuntime, wasmRuntime] = entry.runtimes;
    assert.equal(processRuntime.default, true);
    assert.equal(wasmRuntime.subdir, `wasm/${pluginName}`);
    assert.deepEqual(wasmRuntime.tools, processManifest.tools.map((tool) => tool.name));
  });
}
