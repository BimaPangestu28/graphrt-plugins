/**
 * pdf-tools plugin definition: info, text extraction, merge, page extraction,
 * split, rotate, text watermark and images to PDF, on PDFs inside
 * PDF_TOOLS_INPUT_DIRS, writing new files to PDF_TOOLS_OUTPUT_DIR.
 *
 * There is no token and no network (`localOnly`, `noCredentials`). All PDF
 * parsing runs in a short-lived worker process with a heap cap, an RSS
 * watchdog (decompressed streams are typed arrays outside the heap), a
 * timeout and SIGKILL on cancel (see lib/isolated-task.mjs).
 */
import { createPdfClient, CALL_TIMEOUT_MS, FILE_VARIABLES, LIMIT_VARIABLES } from "./lib/client.mjs";
import { pdfOperations } from "./operations/pdf-operations.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{runTask, fileAccessDependencies}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "pdf-tools",
    version: "0.1.1",
    description: "Local PDFs: page count and metadata, text extraction, merge, extract or split pages, rotate, text watermark and images to PDF, on files in allowed directories",
    extraEnv: [FILE_VARIABLES.inputDirs, FILE_VARIABLES.outputDir, FILE_VARIABLES.maxInputBytes, FILE_VARIABLES.maxOutputBytes, ...LIMIT_VARIABLES],
    localOnly: true,
    noCredentials: true,
    limits: { timeout_ms: CALL_TIMEOUT_MS, max_concurrency: 4 },
    createClient: ({ environment }) => createPdfClient(environment, dependencies),
    operations: pdfOperations,
  };
}

export const pluginDefinition = createPluginDefinition();
