/**
 * document-templates plugin definition: invoices and other documents from
 * templates, fully local. Layout templates (the built-in invoice or your own
 * .json) render to PDF, fillable PDF forms are filled, Word .docx templates
 * are filled, and every result is filed under DOCUMENT_TEMPLATES_OUTPUT_DIR
 * with a predictable folder and name.
 *
 * There is no token and no network (`localOnly`, `noCredentials`). Templates
 * are data: placeholders, loops and conditions, never code. Everything that
 * parses a supplied file or lays out pages runs in a short-lived worker
 * process with a heap cap, an RSS watchdog, a timeout and SIGKILL on cancel
 * (see lib/isolated-task.mjs).
 */
import { CALL_TIMEOUT_MS, FILE_VARIABLES, FONTS_VARIABLE, LIMIT_VARIABLES, createDocumentClient } from "./lib/client.mjs";
import { brandOperations } from "./operations/brand-operations.mjs";
import { documentOperations } from "./operations/document-operations.mjs";
import { templateOperations } from "./operations/template-operations.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{runTask, fileAccessDependencies, organiserDependencies, numberingDependencies, now}` overrides (object)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "document-templates",
    version: "0.5.0",
    description: "Invoices and other documents from templates, fully local: a ready-made invoice with your logo, colour and wording or your own layout to PDF, fillable PDF forms and Word templates filled in, saved in tidy folders with running numbers",
    // The output folder first: it is the one setting a user has to fill in; every other one has a default.
    extraEnv: [FILE_VARIABLES.outputDir, FILE_VARIABLES.inputDirs, FILE_VARIABLES.maxInputBytes, FILE_VARIABLES.maxOutputBytes, ...LIMIT_VARIABLES, FONTS_VARIABLE],
    localOnly: true,
    noCredentials: true,
    limits: { timeout_ms: CALL_TIMEOUT_MS, max_concurrency: 4 },
    createClient: ({ environment }) => createDocumentClient(environment, dependencies),
    operations: [...templateOperations, ...brandOperations, ...documentOperations],
  };
}

export const pluginDefinition = createPluginDefinition();
