/**
 * image-tools plugin definition: metadata, resize, crop, rotate, convert,
 * compress, watermark and thumbnails with sharp (libvips), on images inside
 * IMAGE_TOOLS_INPUT_DIRS, writing new files to IMAGE_TOOLS_OUTPUT_DIR.
 *
 * There is no token and no network (`localOnly`, `noCredentials`). Inputs are
 * recognised by content (raster formats only, never SVG), decoding is capped
 * by IMAGE_TOOLS_MAX_INPUT_PIXELS and every pipeline has a timeout.
 */
import { createImageClient } from "./lib/client.mjs";
import { FILE_VARIABLES, MAX_PIXELS_VARIABLE, TIMEOUT_VARIABLE } from "./lib/settings.mjs";
import { transformOperations } from "./operations/transform.mjs";
import { watermarkOperations } from "./operations/watermark.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{loadSharp, fileAccessDependencies}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "image-tools",
    version: "0.1.1",
    description: "Local images with sharp: metadata, resize, crop, rotate, convert (jpeg/png/webp/avif), compress, text or image watermarks and thumbnails, on files in allowed directories",
    extraEnv: [FILE_VARIABLES.inputDirs, FILE_VARIABLES.outputDir, FILE_VARIABLES.maxInputBytes, FILE_VARIABLES.maxOutputBytes, MAX_PIXELS_VARIABLE, TIMEOUT_VARIABLE],
    localOnly: true,
    noCredentials: true,
    limits: { timeout_ms: 120000, max_concurrency: 4 },
    createClient: ({ environment }) => createImageClient(environment, dependencies),
    operations: [...transformOperations, ...watermarkOperations],
  };
}

export const pluginDefinition = createPluginDefinition();
