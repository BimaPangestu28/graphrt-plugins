/**
 * Checks of a community plugin's released manifest beyond what official plugins need, because its author is a
 * third party: how graphrt starts it (only Node plugins are accepted as community plugins today).
 */
import { assertSafeArchivePath } from "./tar-archive.mjs";

const NODE_ENTRYPOINT_EXTENSIONS = [".mjs", ".js", ".cjs"];

/**
 * Lists the problems with how graphrt would start a community plugin. Only `runtime: "process"` with
 * `command: "node"` and `args: [<one pinned .mjs/.js/.cjs file inside the plugin>]` is accepted: no interpreter
 * flags (`--require`, `--import`, `-e`), no process `env` (NODE_OPTIONS), no `inherit_env`, no `cwd`, and no
 * `allow_unprefixed_kinds`.
 *
 * @param manifest - The released manifest (object)
 * @returns Human-readable problems; empty when the runtime is acceptable (string[])
 */
export function findCommunityRuntimeProblems(manifest) {
  const problems = [];
  if (manifest.runtime !== "process") problems.push(`runtime must be "process" (only Node plugins are accepted as community plugins), not ${JSON.stringify(manifest.runtime)}`);
  if (manifest.command !== "node") problems.push(`command must be "node", not ${JSON.stringify(manifest.command)}`);
  problems.push(...findEntrypointProblems(manifest.args, manifest.checksums ?? {}));
  if (manifest.env !== undefined && !(isPlainObject(manifest.env) && Object.keys(manifest.env).length === 0)) problems.push("a process `env` is not allowed for community plugins");
  if (manifest.inherit_env !== undefined && manifest.inherit_env !== false) problems.push("`inherit_env` is not allowed for community plugins");
  if (manifest.cwd !== undefined) problems.push("`cwd` is not allowed for community plugins");
  if (manifest.allow_unprefixed_kinds !== undefined && manifest.allow_unprefixed_kinds !== false) problems.push("`allow_unprefixed_kinds` is not allowed for community plugins");
  return problems;
}

function findEntrypointProblems(args, checksums) {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== "string") return ["args must be exactly one entrypoint file, e.g. [\"plugin.mjs\"]"];
  const [entrypoint] = args;
  try {
    assertSafeArchivePath(entrypoint);
  } catch {
    return [`args entrypoint \`${entrypoint}\` must be a relative path inside the plugin`];
  }
  if (entrypoint.startsWith("-")) return [`args entrypoint \`${entrypoint}\` must be a file, not a node flag`];
  if (!NODE_ENTRYPOINT_EXTENSIONS.some((extension) => entrypoint.endsWith(extension))) return [`args entrypoint \`${entrypoint}\` must be a .mjs, .js or .cjs file`];
  if (!Object.hasOwn(checksums, entrypoint)) return [`args entrypoint \`${entrypoint}\` is not pinned in checksums`];
  return [];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
