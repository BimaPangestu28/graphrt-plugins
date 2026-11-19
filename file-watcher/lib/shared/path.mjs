/**
 * Safe path building: ids from users or LLMs are encoded as one path segment
 * so they can never add segments, queries or fragments to an API path.
 */
import { PluginError } from "./graphrt-plugin.mjs";

/**
 * Encodes an id as a single URL path segment.
 *
 * @param pathValue - Id or name (string | number)
 * @returns Encoded segment (string)
 * @throws PluginError kind `invalid_input` - When the value is missing, empty or "." / ".."
 *
 * @example
 * `/${pathSegment(commentId)}/replies`
 */
export function pathSegment(pathValue) {
  const segment = pathValue === undefined || pathValue === null ? "" : String(pathValue);
  if (segment === "" || segment === "." || segment === "..") {
    throw new PluginError(`Invalid id ${JSON.stringify(pathValue)} in API path`, { kind: "invalid_input" });
  }
  return encodeURIComponent(segment);
}
