/**
 * excel-csv plugin definition: list sheets, read, write and convert CSV/TSV
 * and XLSX files inside EXCEL_CSV_INPUT_DIRS, writing new files to
 * EXCEL_CSV_OUTPUT_DIR.
 *
 * There is no token and no network (`localOnly`, `noCredentials`). XLSX
 * files are checked for zip bombs before unpacking; all parsing runs in a
 * killable worker process under a memory budget (heap cap and RSS watchdog)
 * and a cell budget; CSV output is protected against formula injection.
 */
import { CALL_TIMEOUT_MS, createTableClient, FILE_VARIABLES, LIMIT_VARIABLES } from "./lib/client.mjs";
import { tableOperations } from "./operations/table-operations.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{runTask, fileAccessDependencies}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "excel-csv",
    version: "0.1.0",
    description: "Local CSV/TSV and XLSX files: list sheets, read rows (sheet, A1 range, header row, row cap; formulas as values), write and convert, with CSV-injection protection",
    extraEnv: [FILE_VARIABLES.inputDirs, FILE_VARIABLES.outputDir, FILE_VARIABLES.maxInputBytes, FILE_VARIABLES.maxOutputBytes, ...LIMIT_VARIABLES],
    localOnly: true,
    noCredentials: true,
    limits: { timeout_ms: CALL_TIMEOUT_MS, max_concurrency: 4 },
    createClient: ({ environment }) => createTableClient(environment, dependencies),
    operations: tableOperations,
  };
}

export const pluginDefinition = createPluginDefinition();
