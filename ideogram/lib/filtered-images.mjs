/**
 * Safety-filtered images for ideogram: Ideogram returns an image that failed its safety check with
 * `is_image_safe: false` and an empty (or null) `url`. The layer would list an empty URL in `saved_files` as a
 * failed download; this wrapper drops such entries and reports each filtered image as
 * `{image_index, url: null, filtered: true}` instead, so callers can tell "blocked" from "download failed".
 */
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";

/**
 * Rewrites saved_files for a `{result: {data: [...]}, saved_files}` output.
 *
 * @param data - Operation data (object)
 * @returns Data with filtered images reported (object)
 */
export function reportFilteredImages(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.saved_files)) return data;
  const images = Array.isArray(data.result?.data) ? data.result.data : [];
  const filteredEntries = images.flatMap((image, imageIndex) => (hasImageUrl(image) ? [] : [{ image_index: imageIndex, url: null, filtered: true }]));
  const savedFiles = data.saved_files.filter((savedFile) => !(savedFile.url === "" && savedFile.error));
  return { ...data, saved_files: [...savedFiles, ...filteredEntries] };
}

function hasImageUrl(image) {
  return typeof image?.url === "string" && image.url.trim() !== "";
}

/**
 * Wraps a generated operation so its saved_files report filtered images.
 *
 * @param operation - Generated operation with a `data[].url` download (object)
 * @returns Operation with the same name, schema and policy (object)
 */
export function withFilteredImageReport(operation) {
  return {
    ...operation,
    run: async (context) => {
      // Run untruncated, rewrite, then truncate for tools as the layer would.
      const output = await operation.run({ ...context, source: "node" });
      const data = reportFilteredImages(output.data);
      return { ...output, data: context.source === "tool" ? truncateForTool(data, DEFAULT_TOOL_OUTPUT) : data };
    },
  };
}
