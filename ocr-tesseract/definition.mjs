/**
 * ocr-tesseract plugin definition: text recognition with the system
 * `tesseract` on images (or PDF pages rendered by poppler's `pdftoppm`)
 * inside OCR_TESSERACT_INPUT_DIRS.
 *
 * There is no token and no network (`localOnly`, `noCredentials`). Programs
 * run with argument arrays (never a shell), a timeout, SIGKILL on cancel and
 * an output cap; inputs are recognised by content.
 */
import { createOcrClient, CALL_TIMEOUT_MS, FILE_VARIABLES, OTHER_VARIABLES } from "./lib/client.mjs";
import { ocrOperations } from "./operations/ocr-operations.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{runProcess, fileAccessDependencies}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "ocr-tesseract",
    version: "0.1.0",
    description: "OCR with the system Tesseract: text, hOCR or TSV from images or PDF pages in allowed directories, with language and page segmentation choices",
    extraEnv: [FILE_VARIABLES.inputDirs, FILE_VARIABLES.outputDir, FILE_VARIABLES.maxInputBytes, FILE_VARIABLES.maxOutputBytes, ...OTHER_VARIABLES],
    localOnly: true,
    noCredentials: true,
    limits: { timeout_ms: CALL_TIMEOUT_MS, max_concurrency: 2 },
    createClient: ({ environment }) => createOcrClient(environment, dependencies),
    operations: ocrOperations,
  };
}

export const pluginDefinition = createPluginDefinition();
