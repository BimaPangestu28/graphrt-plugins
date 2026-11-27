/**
 * Settings and the client one document-templates call works with:
 * allowlisted reads (templates, logos, values files), engine tasks in a
 * killable worker, and filing of results under DOCUMENT_TEMPLATES_OUTPUT_DIR.
 */
import { extname } from "node:path";
import { createFileAccess, fileAccessVariableNames, readFileAccessSettings } from "./file-access.mjs";
import { expandHome, readInteger, readText } from "./environment-readers.mjs";
import { invalidInput } from "./errors.mjs";
import { createOutputOrganiser } from "./output-organiser.mjs";
import { createWorkerLauncher } from "./worker-launcher.mjs";

export const ENVIRONMENT_PREFIX = "DOCUMENT_TEMPLATES";
export const FILE_VARIABLES = fileAccessVariableNames(ENVIRONMENT_PREFIX);
export const FONTS_VARIABLE = "DOCUMENT_TEMPLATES_FONTS";
export const LIMIT_VARIABLES = ["DOCUMENT_TEMPLATES_MAX_PAGES", "DOCUMENT_TEMPLATES_TIMEOUT_MS", "DOCUMENT_TEMPLATES_MAX_MEMORY_MB"];
export const CALL_TIMEOUT_MS = 180000;
const MEBIBYTE = 1024 ** 2;
const MAX_EXTRA_FONTS = 8;
const FONT_EXTENSIONS = [".ttf", ".otf", ".ttc"];

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{files, maxPages, timeoutMs, maxMemoryMb, extraFontPaths}` (object)
 * @throws PluginError kind `invalid_input` - When a variable has an invalid value
 */
export function readDocumentSettings(environment = {}) {
  const files = readFileAccessSettings(environment, { prefix: ENVIRONMENT_PREFIX, defaultMaxInputBytes: 20 * MEBIBYTE, defaultMaxOutputBytes: 50 * MEBIBYTE, maxBytesCeiling: 1024 * MEBIBYTE });
  return {
    files,
    maxPages: readInteger(environment, "DOCUMENT_TEMPLATES_MAX_PAGES", 200, { minimum: 1, maximum: 5000 }),
    timeoutMs: readInteger(environment, "DOCUMENT_TEMPLATES_TIMEOUT_MS", 60000, { minimum: 1000, maximum: CALL_TIMEOUT_MS - 20000 }),
    maxMemoryMb: readInteger(environment, "DOCUMENT_TEMPLATES_MAX_MEMORY_MB", 768, { minimum: 128, maximum: 16384 }),
    extraFontPaths: readExtraFontPaths(environment, files.homeDirectory),
  };
}

// Font files are named by whoever configures the plugin, never by a call, so they may live anywhere (e.g. the system font folder).
function readExtraFontPaths(environment, homeDirectory) {
  const fontPaths = (readText(environment, FONTS_VARIABLE) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => expandHome(entry, homeDirectory, FONTS_VARIABLE));
  if (fontPaths.length > MAX_EXTRA_FONTS) throw invalidInput(`${FONTS_VARIABLE} lists ${fontPaths.length} fonts, over the limit of ${MAX_EXTRA_FONTS}`);
  for (const fontPath of fontPaths) {
    if (!FONT_EXTENSIONS.includes(extname(fontPath).toLowerCase())) throw invalidInput(`${FONTS_VARIABLE}: ${JSON.stringify(fontPath)} must be a .ttf, .otf or .ttc font file`);
  }
  return fontPaths;
}

/**
 * Creates the client for one call.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - `{runTask, fileAccessDependencies, organiserDependencies, numberingDependencies, now}` overrides for tests (object, optional)
 * @returns `{settings, fileAccess, organiser, runTask, now, numberingDependencies}` (object)
 */
export function createDocumentClient(environment, dependencies = {}) {
  const settings = readDocumentSettings(environment);
  const launchTask = dependencies.runTask ?? createWorkerLauncher();
  return {
    settings,
    fileAccess: createFileAccess(settings.files, dependencies.fileAccessDependencies),
    organiser: createOutputOrganiser(settings.files, dependencies.organiserDependencies),
    runTask: (task, payload, signal) => launchTask(task, payload, { signal, timeoutMs: settings.timeoutMs, maxMemoryMb: settings.maxMemoryMb }),
    now: dependencies.now ?? (() => new Date()),
    numberingDependencies: dependencies.numberingDependencies ?? {},
  };
}
