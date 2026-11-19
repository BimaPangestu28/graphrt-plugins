/**
 * Firestore document and collection paths relative to `.../documents`: alternating collection/document segments,
 * each URL-encoded on its own, so an id can never add segments, a query or ".." to the API path.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const MAX_PATH_BYTES = 1500;

function encodeSegments(path, label) {
  if (typeof path !== "string" || path === "" || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
    throw new PluginError(`\`${label}\` must be a non-empty path of at most ${MAX_PATH_BYTES} bytes`, { kind: "invalid_input" });
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new PluginError(`\`${label}\` ${JSON.stringify(path)} has an empty, "." or ".." segment (no leading, trailing or double slashes)`, { kind: "invalid_input" });
  }
  return segments.map((segment) => encodeURIComponent(segment));
}

/**
 * Checks and encodes a document path such as "users/u1" or "users/u1/orders/o1".
 *
 * @param documentPath - Path relative to the database's documents (string)
 * @param label - Argument name, for messages (string, default "path")
 * @returns Encoded path without a leading slash (string)
 * @throws PluginError kind `invalid_input` - Bad segments or an odd number of segments
 *
 * @example
 * checkDocumentPath("users/u 1"); // "users/u%201"
 */
export function checkDocumentPath(documentPath, label = "path") {
  const segments = encodeSegments(documentPath, label);
  if (segments.length % 2 !== 0) throw new PluginError(`\`${label}\` must be a document path (collection/document[/collection/document...])`, { kind: "invalid_input" });
  return segments.join("/");
}

/**
 * Checks and encodes a collection path such as "users" or "users/u1/orders".
 *
 * @param collectionPath - Path relative to the database's documents (string)
 * @param label - Argument name, for messages (string, default "collection_path")
 * @returns Encoded path without a leading slash (string)
 * @throws PluginError kind `invalid_input` - Bad segments or an even number of segments
 */
export function checkCollectionPath(collectionPath, label = "collection_path") {
  const segments = encodeSegments(collectionPath, label);
  if (segments.length % 2 !== 1) throw new PluginError(`\`${label}\` must be a collection path (collection[/document/collection...])`, { kind: "invalid_input" });
  return segments.join("/");
}
