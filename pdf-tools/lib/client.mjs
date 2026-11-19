/**
 * Settings and the client one pdf-tools call works with: allowlisted reads
 * (checked to be PDFs or images by content), engine tasks in a killable
 * worker, and new output files in PDF_TOOLS_OUTPUT_DIR.
 */
import { createFileAccess, fileAccessVariableNames, readFileAccessSettings } from "./file-access.mjs";
import { readInteger } from "./environment-readers.mjs";
import { invalidInput } from "./errors.mjs";
import { createWorkerLauncher } from "./worker-launcher.mjs";

export const ENVIRONMENT_PREFIX = "PDF_TOOLS";
export const FILE_VARIABLES = fileAccessVariableNames(ENVIRONMENT_PREFIX);
export const LIMIT_VARIABLES = ["PDF_TOOLS_MAX_PAGES", "PDF_TOOLS_TIMEOUT_MS", "PDF_TOOLS_MAX_MEMORY_MB", "PDF_TOOLS_MAX_TOTAL_INPUT_BYTES"];
export const CALL_TIMEOUT_MS = 300000;
const MEBIBYTE = 1024 ** 2;

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{files, maxPages, timeoutMs, maxMemoryMb, maxTotalInputBytes}` (object)
 * @throws PluginError kind `invalid_input` - When a variable has an invalid value
 */
export function readPdfSettings(environment = {}) {
  return {
    files: readFileAccessSettings(environment, { prefix: ENVIRONMENT_PREFIX, defaultMaxInputBytes: 100 * MEBIBYTE, defaultMaxOutputBytes: 200 * MEBIBYTE, maxBytesCeiling: 1024 * MEBIBYTE }),
    maxPages: readInteger(environment, "PDF_TOOLS_MAX_PAGES", 2000, { minimum: 1, maximum: 100000 }),
    timeoutMs: readInteger(environment, "PDF_TOOLS_TIMEOUT_MS", 120000, { minimum: 1000, maximum: CALL_TIMEOUT_MS - 20000 }),
    maxMemoryMb: readInteger(environment, "PDF_TOOLS_MAX_MEMORY_MB", 1024, { minimum: 128, maximum: 16384 }),
    maxTotalInputBytes: readInteger(environment, "PDF_TOOLS_MAX_TOTAL_INPUT_BYTES", 200 * MEBIBYTE, { minimum: 1024, maximum: 4096 * MEBIBYTE }),
  };
}

/**
 * Creates the client for one call.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - `{runTask, fileAccessDependencies}` overrides for tests (object, optional)
 * @returns `{settings, fileAccess, readPdf, readInputs, runTask, saveOutputs}` (object)
 */
export function createPdfClient(environment, dependencies = {}) {
  const settings = readPdfSettings(environment);
  const fileAccess = createFileAccess(settings.files, dependencies.fileAccessDependencies);
  const launchTask = dependencies.runTask ?? createWorkerLauncher();
  return {
    settings,
    fileAccess,
    readPdf: (rawPath, parameterName) => readPdf(fileAccess, rawPath, parameterName),
    readInputs: (rawPaths, readOne) => readInputsWithinTotal(settings, rawPaths, readOne),
    runTask: (task, payload, signal) => launchTask(task, { ...payload, maxPages: settings.maxPages }, { signal, timeoutMs: settings.timeoutMs, maxMemoryMb: settings.maxMemoryMb }),
    saveOutputs: (outputs, nameHints) => saveOutputs(fileAccess, outputs, nameHints),
  };
}

/**
 * Reads an allowlisted file and checks it starts like a PDF.
 *
 * @param fileAccess - From createFileAccess (object)
 * @param rawPath - Path argument (string)
 * @param parameterName - For messages (string, default "input")
 * @returns `{path, bytes}` (object)
 * @throws PluginError kind `invalid_input` - When the content is not a PDF
 */
async function readPdf(fileAccess, rawPath, parameterName = "input") {
  const file = await fileAccess.readInputFile(rawPath, { parameterName });
  // The header may follow up to 1 KiB of junk, which readers accept too.
  if (!file.bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) throw invalidInput(`\`${parameterName}\` is not a PDF file (no %PDF- header)`);
  return file;
}

/**
 * Reads several inputs, refusing the call once their combined size passes PDF_TOOLS_MAX_TOTAL_INPUT_BYTES.
 *
 * @param settings - Client settings (object)
 * @param rawPaths - Path arguments (string[])
 * @param readOne - `(rawPath, index) => Promise<{bytes}>` (function)
 * @returns The files read (object[])
 * @throws PluginError kind `invalid_input` - When the total is over the cap
 */
async function readInputsWithinTotal(settings, rawPaths, readOne) {
  const files = [];
  let totalBytes = 0;
  for (const [index, rawPath] of rawPaths.entries()) {
    const file = await readOne(rawPath, index);
    totalBytes += file.bytes.length;
    if (totalBytes > settings.maxTotalInputBytes) throw invalidInput(`The inputs add up to more than ${settings.maxTotalInputBytes} bytes (PDF_TOOLS_MAX_TOTAL_INPUT_BYTES)`);
    files.push(file);
  }
  return files;
}

// All or nothing: if one output cannot be written, the ones already written are removed (and named in the error).
async function saveOutputs(fileAccess, outputs, nameHints) {
  const items = outputs.map((outputBytes, index) => ({ naming: { nameHint: nameHints[index] ?? nameHints[0], extension: "pdf" }, bytes: Buffer.from(outputBytes) }));
  return fileAccess.writeOutputFiles(items);
}
