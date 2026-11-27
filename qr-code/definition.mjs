/**
 * qr-code plugin definition: generate QR codes as new PNG/SVG files in
 * QR_CODE_OUTPUT_DIR and decode QR codes from images inside QR_CODE_INPUT_DIRS.
 *
 * There is no token and no network (`localOnly`, `noCredentials`); the zxing
 * WebAssembly decoder is loaded from node_modules, never from its default CDN.
 */
import { createQrClient, FILE_VARIABLES, MAX_OUTPUT_PIXELS_VARIABLE, MAX_PIXELS_VARIABLE } from "./lib/client.mjs";
import { qrOperations } from "./operations/qr-operations.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{fileAccessDependencies}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "qr-code",
    version: "0.1.1",
    description: "QR codes: generate PNG or SVG files (error correction, size, colours) and decode QR codes from local images in allowed directories",
    extraEnv: [FILE_VARIABLES.inputDirs, FILE_VARIABLES.outputDir, FILE_VARIABLES.maxInputBytes, FILE_VARIABLES.maxOutputBytes, MAX_PIXELS_VARIABLE, MAX_OUTPUT_PIXELS_VARIABLE],
    localOnly: true,
    noCredentials: true,
    limits: { timeout_ms: 60000, max_concurrency: 4 },
    createClient: ({ environment }) => createQrClient(environment, dependencies),
    operations: qrOperations,
  };
}

export const pluginDefinition = createPluginDefinition();
