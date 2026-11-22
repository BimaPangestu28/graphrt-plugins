/**
 * Checks of a community plugin's released manifest beyond what official plugins need, because its author is a
 * third party: how graphrt starts it (only Node plugins are accepted as community plugins today), and the text
 * it puts in the catalog and in front of LLMs (lengths, no control/format characters, no markup brackets).
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

/** Length caps of manifest- and README-derived text a community plugin shows in the catalog or hands an LLM. */
export const COMMUNITY_TEXT_LIMITS = {
  description: 300, nodeTitle: 100, nodeDescription: 1000, nodeKind: 128, toolName: 64, toolDescription: 1000, schemaText: 1000, warning: 1000,
};
const MAX_PERMISSION_ENV_NAMES = 64;
// Control characters, format characters (bidi overrides, zero-width), line/paragraph separators, and the angle
// brackets an HTML renderer could read as markup.
const UNSAFE_COMMUNITY_TEXT_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const SCHEMA_TEXT_KEYS = new Set(["description", "title"]);

/**
 * Lists the problems in the text a community manifest and README put in the catalog (and, for tools and schema
 * descriptions, in front of an LLM): the plugin description, node titles, descriptions and kinds, tool names and
 * descriptions, schema `description`/`title` strings, the README warning and the `permissions`.
 *
 * @param pluginName - Registry name (string)
 * @param manifest - The released manifest (object)
 * @param warningText - The README warning that becomes the catalog `warning`, or null (string|null)
 * @returns Human-readable problems; empty when the text is acceptable (string[])
 */
export function findCommunityTextProblems(pluginName, manifest, warningText) {
  const tools = manifest.tools ?? [];
  return [
    ...findTextProblems("description", manifest.description ?? "", COMMUNITY_TEXT_LIMITS.description),
    ...(warningText === null ? [] : findTextProblems("README warning", warningText, COMMUNITY_TEXT_LIMITS.warning)),
    ...(Array.isArray(manifest.nodes) ? manifest.nodes.flatMap((node, index) => findNodeProblems(pluginName, node, index)) : ["nodes must be an array"]),
    ...(Array.isArray(tools) ? tools.flatMap((tool, index) => findToolProblems(tool, index)) : ["tools must be an array"]),
    ...findPermissionProblems(manifest.permissions),
  ];
}

function findNodeProblems(pluginName, node, index) {
  if (!isPlainObject(node)) return [`nodes[${index}] must be an object`];
  const label = `node ${typeof node.kind === "string" ? `\`${node.kind}\`` : `#${index}`}`;
  const problems = [];
  if (typeof node.kind !== "string" || !node.kind.startsWith(`${pluginName}.`) || node.kind.length === pluginName.length + 1) problems.push(`${label}: kind must start with \`${pluginName}.\``);
  else problems.push(...findTextProblems(`${label} kind`, node.kind, COMMUNITY_TEXT_LIMITS.nodeKind));
  if (node.title !== undefined) problems.push(...findTextProblems(`${label} title`, node.title, COMMUNITY_TEXT_LIMITS.nodeTitle));
  if (node.description !== undefined) problems.push(...findTextProblems(`${label} description`, node.description, COMMUNITY_TEXT_LIMITS.nodeDescription));
  problems.push(...findSchemaTextProblems(`${label} config_schema`, node.config_schema));
  return problems;
}

function findToolProblems(tool, index) {
  if (!isPlainObject(tool)) return [`tools[${index}] must be an object`];
  const label = `tool ${typeof tool.name === "string" ? `\`${tool.name}\`` : `#${index}`}`;
  const problems = [];
  if (typeof tool.name !== "string" || !TOOL_NAME_PATTERN.test(tool.name) || tool.name.length > COMMUNITY_TEXT_LIMITS.toolName) {
    problems.push(`${label}: name must be letters, digits, _ and - (at most ${COMMUNITY_TEXT_LIMITS.toolName})`);
  }
  if (tool.description !== undefined) problems.push(...findTextProblems(`${label} description`, tool.description, COMMUNITY_TEXT_LIMITS.toolDescription));
  problems.push(...findSchemaTextProblems(`${label} parameters`, tool.parameters));
  return problems;
}

/** Every `description` and `title` string anywhere in a JSON schema. */
function findSchemaTextProblems(label, schema) {
  const problems = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (SCHEMA_TEXT_KEYS.has(key) && typeof child === "string") problems.push(...findTextProblems(`${label} ${key}`, child, COMMUNITY_TEXT_LIMITS.schemaText));
        else visit(child);
      }
    }
  };
  visit(schema);
  return problems;
}

function findPermissionProblems(permissions) {
  if (permissions === undefined) return [];
  if (!isPlainObject(permissions)) return ["permissions must be an object"];
  const problems = [];
  for (const flagName of ["network", "secrets"]) {
    if (permissions[flagName] !== undefined && typeof permissions[flagName] !== "boolean") problems.push(`permissions.${flagName} must be true or false`);
  }
  const envNames = permissions.env;
  if (envNames === undefined) return problems;
  if (!Array.isArray(envNames) || envNames.length > MAX_PERMISSION_ENV_NAMES) return [...problems, `permissions.env must be an array of at most ${MAX_PERMISSION_ENV_NAMES} names`];
  const badNames = envNames.filter((envName) => typeof envName !== "string" || !ENV_NAME_PATTERN.test(envName));
  if (badNames.length > 0) problems.push(`permissions.env names must match ${ENV_NAME_PATTERN.source}: ${badNames.slice(0, 5).map((envName) => JSON.stringify(envName)).join(", ")}`);
  return problems;
}

function findTextProblems(label, text, maxLength) {
  if (typeof text !== "string") return [`${label} must be a string`];
  if (text.length > maxLength) return [`${label} is longer than ${maxLength} characters`];
  if (UNSAFE_COMMUNITY_TEXT_PATTERN.test(text)) return [`${label} holds control, format (bidi, zero-width) or < > characters`];
  return [];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
