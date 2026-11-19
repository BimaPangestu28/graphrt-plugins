/**
 * Path policy for the generated `api_request` operation when an agent calls it as a tool. The layer already limits
 * tools to GET and to the paths of tool-visible operations; this adds an allowlist and/or a denylist for APIs whose
 * other GET endpoints return secrets (CI variables, env vars, tokens, hook secrets). Workflow nodes are unaffected.
 *
 * Paths are normalized the way a server could read them before matching: query dropped, every segment
 * percent-decoded until stable (so `%2576` is `v`), backslashes treated as slashes, `.`/`..` resolved, lowercased,
 * and optionally a trailing format suffix stripped (GitLab/Grape serves `/variables.json` like `/variables`).
 *
 * This file is identical in every plugin that uses it (github, gitlab, sentry, vercel, cloudflare); keep it so.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const MAX_DECODE_ROUNDS = 5;
const SEPARATORS = /[\\/]/;
/** Stands for a segment that contained an encoded slash, kept whole as one id (GitLab `group%2Fproject`). */
export const ENCODED_SEGMENT = "{encoded}";

/**
 * Decodes percent-encoding until the text stops changing.
 *
 * @param text - Possibly encoded text (string)
 * @returns Decoded text; the last decodable form when the encoding is malformed (string)
 *
 * @example
 * decodePathRepeatedly("a%252Fb"); // "a/b"
 */
export function decodePathRepeatedly(text) {
  let decodedText = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let nextText;
    try {
      nextText = decodeURIComponent(decodedText);
    } catch {
      return decodedText;
    }
    if (nextText === decodedText) return decodedText;
    decodedText = nextText;
  }
  return decodedText;
}

/**
 * Normalizes an api_request path for policy matching.
 *
 * @param rawPath - Path as the caller gave it, possibly with a query (string)
 * @param options - Normalization options (object, optional)
 * @param options.encodedSlashes - "split" (default): a decoded `/` separates segments; "opaque": a segment with an
 *   encoded slash is one id, shown as `{encoded}` (APIs that take `group%2Fproject` as an id)
 * @param options.stripFormatSuffix - Drop a `.ext` suffix of the last segment (boolean, default false)
 * @returns Normalized path starting with "/" (string)
 *
 * @example
 * normalizeApiPath("/projects/42/./Variables.json", { stripFormatSuffix: true }); // "/projects/42/variables"
 */
export function normalizeApiPath(rawPath, { encodedSlashes = "split", stripFormatSuffix = false } = {}) {
  const segments = [];
  for (const rawSegment of String(rawPath).split(/[?#]/)[0].split(SEPARATORS)) {
    const decodedSegment = decodePathRepeatedly(rawSegment);
    const hasEncodedSlash = SEPARATORS.test(decodedSegment);
    const parts = hasEncodedSlash && encodedSlashes === "opaque" ? [ENCODED_SEGMENT] : decodedSegment.split(SEPARATORS);
    for (const part of parts) applySegment(segments, part.trim().toLowerCase());
  }
  if (stripFormatSuffix && segments.length > 0) segments[segments.length - 1] = segments.at(-1).replace(/\.[a-z0-9]+$/, "");
  return `/${segments.join("/")}`;
}

function applySegment(segments, segment) {
  if (segment === "" || segment === ".") return;
  if (segment === "..") {
    segments.pop();
    return;
  }
  segments.push(segment);
}

/**
 * Returns the definition with `api_request` refusing agent-tool calls whose normalized path is not allowed.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @param policy - Path policy (object)
 * @param policy.allowedPaths - When given, the normalized path must match one of these (RegExp[], optional)
 * @param policy.blockedPaths - The normalized path must match none of these (RegExp[], optional)
 * @param policy.normalizeOptions - Options for normalizeApiPath (object, optional)
 * @param policy.extraAllowedPathsEnv - Env with more allowed paths, comma-separated, a `*` segment matches one
 *   segment (see parseExtraPaths); blockedPaths still win (string, optional)
 * @param policy.reason - Why, shown in the permission_denied message (string)
 * @returns A new definition; restSpec and the other operations are unchanged (object)
 * @throws Error - The definition has no api_request operation
 *
 * @example
 * guardToolApiRequest(definition, { blockedPaths: [/(^|\/)hooks(\/|$)/], reason: "hook secrets" });
 */
export function guardToolApiRequest(pluginDefinition, { allowedPaths, blockedPaths = [], normalizeOptions = {}, extraAllowedPathsEnv, reason }) {
  if (!pluginDefinition.operations.some((operation) => operation.name === "api_request")) {
    throw new Error(`${pluginDefinition.name}: guardToolApiRequest needs the generated api_request operation`);
  }
  const isAllowed = (normalizedPath, environment) => {
    const allowlist = allowedPaths === undefined ? undefined : [...allowedPaths, ...parseExtraPaths(environment?.[extraAllowedPathsEnv], normalizeOptions)];
    const allowedByList = allowlist === undefined || allowlist.some((pattern) => pattern.test(normalizedPath));
    return allowedByList && !blockedPaths.some((pattern) => pattern.test(normalizedPath));
  };
  const guardOperation = (operation) => {
    if (operation.name !== "api_request") return operation;
    const run = (context) => {
      if (context.source === "tool" && typeof context.args?.path === "string") {
        const normalizedPath = normalizeApiPath(context.args.path, normalizeOptions);
        if (!isAllowed(normalizedPath, context.environment)) {
          throw new PluginError(`api_request cannot reach ${normalizedPath} as an agent tool: ${reason}`, { kind: "permission_denied" });
        }
      }
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(guardOperation) };
}

/**
 * Turns an extra-paths env value into patterns: each entry is normalized, `*` matches one segment.
 *
 * @param envValue - e.g. "/projects/STAR/environments,/version" with STAR = * (string, optional)
 * @param normalizeOptions - Options for normalizeApiPath (object)
 * @returns Anchored patterns (RegExp[])
 */
export function parseExtraPaths(envValue, normalizeOptions = {}) {
  if (!envValue) return [];
  return String(envValue)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const normalizedEntry = normalizeApiPath(entry.replaceAll("*", "\u0000"), { ...normalizeOptions, stripFormatSuffix: false });
      const pattern = normalizedEntry.split("\u0000").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+");
      return new RegExp(`^${pattern}$`);
    });
}
