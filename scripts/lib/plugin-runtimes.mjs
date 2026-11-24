/**
 * Alternative runtimes of official plugins for the catalog: the WebAssembly builds listed in `wasm/builds.json`
 * (plugin name -> `[{subdir, tool_mode, note}]`). A catalog entry of such a plugin gets `runtimes`: the Node.js
 * process plugin (the tarball, the default) and each WebAssembly build with its tools, module checksum and the
 * install command, so a user or the desktop app can pick one. Plugins without a build get no `runtimes` field
 * (the field is additive within catalog schema 1 and 2; readers ignore it).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";

export const WASM_BUILDS_FILE = join("wasm", "builds.json");
const MANIFEST_FILE_NAME = "graphrt-plugin.json";

/**
 * Reads `wasm/builds.json` and each build's manifest and module.
 *
 * @param repoRoot - Repository root (string, default: this repository)
 * @param repository - GitHub `owner/name` for the install command (string)
 * @returns WebAssembly runtimes by plugin name (Map<string, object[]>)
 * @throws Error - A listed build has no manifest or module, or its manifest names another plugin or runtime
 */
export function readWasmRuntimes(repoRoot, repository) {
  const registryPath = join(repoRoot, WASM_BUILDS_FILE);
  if (!existsSync(registryPath)) return new Map();
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  return new Map(Object.entries(registry).map(([pluginName, builds]) => [pluginName, builds.map((build) => describeWasmBuild(repoRoot, repository, pluginName, build))]));
}

function describeWasmBuild(repoRoot, repository, pluginName, { subdir, tool_mode: toolMode, note }) {
  const manifestPath = join(repoRoot, subdir, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath)) throw new Error(`${WASM_BUILDS_FILE}: ${subdir} has no ${MANIFEST_FILE_NAME}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== pluginName || manifest.runtime !== "wasm") {
    throw new Error(`${WASM_BUILDS_FILE}: ${subdir} must be a wasm manifest named ${pluginName}, not ${manifest.runtime} ${manifest.name}`);
  }
  const moduleBytes = readFileSync(join(repoRoot, subdir, manifest.module));
  return {
    runtime: "wasm",
    status: "experimental",
    tool_mode: toolMode,
    note,
    subdir,
    tools: (manifest.tools ?? []).map((tool) => tool.name),
    module_sha256: createHash("sha256").update(moduleBytes).digest("hex"),
    module_size_bytes: moduleBytes.length,
    install: `graphrt plugin install https://github.com/${repository} --rev main --subdir ${subdir}`,
  };
}

/**
 * The `runtimes` of one plugin's catalog entry.
 *
 * @param pluginName - Plugin name (string)
 * @param wasmRuntimes - From readWasmRuntimes (Map)
 * @returns `[{runtime: "process", default: true}, ...wasm builds]`, or undefined without a build (object[] | undefined)
 */
export function describeRuntimes(pluginName, wasmRuntimes) {
  const builds = wasmRuntimes.get(pluginName);
  if (!builds?.length) return undefined;
  return [{ runtime: "process", default: true, note: "Node.js plugin (the release tarball): every node and tool" }, ...builds];
}

/** @returns The WebAssembly runtimes of this repository (Map) */
export function readRepositoryWasmRuntimes(repository) {
  return readWasmRuntimes(REPO_ROOT, repository);
}
