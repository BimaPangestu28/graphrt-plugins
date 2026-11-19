/**
 * Pre-authenticated URLs in agent tool results. Graph returns `@microsoft.graph.downloadUrl` on items (a short-lived
 * URL that downloads the file without any credential), and sharing permissions carry the link itself
 * (`link.webUrl`, `link.webHtml`), which for anonymous links is the access. An agent that sees either can hand
 * the file to anyone, so tool results drop them at any depth (also for `api_request`). Workflow nodes get the
 * full response; `download_item` downloads without exposing the URL.
 */
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";

const DOWNLOAD_URL_KEYS = new Set(["@microsoft.graph.downloadUrl", "@content.downloadUrl"]);
const LINK_SECRET_KEYS = new Set(["webUrl", "webHtml"]);
// Thumbnail URLs (thumbnailSet `small`/`medium`/`large`/`source` and custom sizes such as `c300x400_crop`) are
// pre-authenticated too.
const THUMBNAIL_SIZE_KEY = /^(small|medium|large|source|c\d+x\d+(_crop)?)$/;

/**
 * Removes pre-authenticated download URLs and sharing-link URLs from a value.
 *
 * @param value - Response data (any)
 * @param parentKey - Key of the object holding `value` (string, internal)
 * @returns A copy without those fields (any)
 *
 * @example
 * stripPreauthenticatedUrls({ id: "1", "@microsoft.graph.downloadUrl": "https://..." }); // { id: "1" }
 */
export function stripPreauthenticatedUrls(value, parentKey = "") {
  if (Array.isArray(value)) return value.map((item) => stripPreauthenticatedUrls(item, parentKey));
  if (!value || typeof value !== "object") return value;
  const keptEntries = Object.entries(value).filter(([key]) => !DOWNLOAD_URL_KEYS.has(key) && !(parentKey === "link" && LINK_SECRET_KEYS.has(key)) && !(key === "url" && THUMBNAIL_SIZE_KEY.test(parentKey)));
  return Object.fromEntries(keptEntries.map(([key, entryValue]) => [key, stripPreauthenticatedUrls(entryValue, key)]));
}

/**
 * Wraps an operation so tool results are passed through stripPreauthenticatedUrls and then truncated. The plugin
 * sets `toolOutput: false` so the layer does not truncate first: a truncated `preview` is JSON text, where the
 * URLs could no longer be removed field by field.
 *
 * @param operation - Operation (object)
 * @returns Operation (object)
 */
export function stripUrlsForTools(operation) {
  return {
    ...operation,
    run: async (context) => {
      const result = await operation.run(context);
      if (context.source !== "tool") return result;
      return { ...result, data: truncateForTool(stripPreauthenticatedUrls(result?.data), DEFAULT_TOOL_OUTPUT) };
    },
  };
}
