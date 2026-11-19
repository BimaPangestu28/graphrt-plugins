/**
 * Settings and the client one OCR call works with: allowlisted reads checked
 * by content, the system `tesseract` (and `pdftoppm` for PDF pages) run with
 * argument arrays, timeouts and output caps.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileAccess, fileAccessVariableNames, readFileAccessSettings } from "./file-access.mjs";
import { readExecutable, readInteger } from "./environment-readers.mjs";
import { createProcessRunner } from "./process-runner.mjs";
import { invalidInput, operationFailed, setupRequired } from "./errors.mjs";

export const ENVIRONMENT_PREFIX = "OCR_TESSERACT";
export const FILE_VARIABLES = fileAccessVariableNames(ENVIRONMENT_PREFIX);
export const OTHER_VARIABLES = ["OCR_TESSERACT_TIMEOUT_MS", "OCR_TESSERACT_MAX_INPUT_PIXELS", "TESSERACT_BINARY", "PDFTOPPM_BINARY"];
export const CALL_TIMEOUT_MS = 300000;
const MEBIBYTE = 1024 ** 2;
const MAX_OCR_OUTPUT_BYTES = 8 * MEBIBYTE;
const TESSERACT_HINT = "Install Tesseract (`brew install tesseract`, `apt install tesseract-ocr`, plus language packs such as `tesseract-lang`), or set TESSERACT_BINARY.";
const PDFTOPPM_HINT = "PDF pages are rendered with poppler's pdftoppm: install poppler (`brew install poppler`, `apt install poppler-utils`), or set PDFTOPPM_BINARY.";

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{files, timeoutMs, maxInputPixels, tesseractCommand, pdftoppmCommand}` (object)
 */
export function readOcrSettings(environment = {}) {
  return {
    files: readFileAccessSettings(environment, { prefix: ENVIRONMENT_PREFIX, defaultMaxInputBytes: 50 * MEBIBYTE, defaultMaxOutputBytes: 50 * MEBIBYTE, maxBytesCeiling: 1024 * MEBIBYTE }),
    timeoutMs: readInteger(environment, "OCR_TESSERACT_TIMEOUT_MS", 120000, { minimum: 1000, maximum: CALL_TIMEOUT_MS - 20000 }),
    maxInputPixels: readInteger(environment, "OCR_TESSERACT_MAX_INPUT_PIXELS", 40_000_000, { minimum: 10_000, maximum: 400_000_000 }),
    tesseractCommand: readExecutable(environment, "TESSERACT_BINARY", "tesseract"),
    pdftoppmCommand: readExecutable(environment, "PDFTOPPM_BINARY", "pdftoppm"),
  };
}

/**
 * Creates the client for one call.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - `{runProcess, fileAccessDependencies}` overrides for tests (object, optional)
 * @returns `{settings, fileAccess, listLanguages, recognize, withRenderedPdfPage}` (object)
 */
export function createOcrClient(environment, dependencies = {}) {
  const settings = readOcrSettings(environment);
  const fileAccess = createFileAccess(settings.files, dependencies.fileAccessDependencies);
  const context = { settings, redactPaths: fileAccess.redactPaths, runProcess: dependencies.runProcess ?? createProcessRunner() };
  return {
    settings,
    fileAccess,
    listLanguages: (signal) => listLanguages(context, signal),
    recognize: (request) => recognize(context, request),
    withRenderedPdfPage: (request, work) => withRenderedPdfPage(context, request, work),
  };
}

function runTesseract(context, args, signal) {
  return context.runProcess({ command: context.settings.tesseractCommand, args, timeoutMs: context.settings.timeoutMs, signal, maxStdoutBytes: MAX_OCR_OUTPUT_BYTES, displayName: "tesseract", setupHint: TESSERACT_HINT });
}

/**
 * Lists installed Tesseract languages.
 *
 * @param context - Client context (object)
 * @param signal - AbortSignal (AbortSignal, optional)
 * @returns `{languages, data_directory}` (object)
 */
async function listLanguages(context, signal) {
  const runResult = await runTesseract(context, ["--list-langs"], signal);
  if (runResult.exitCode !== 0) throw describeFailure("tesseract", runResult, TESSERACT_HINT, context.redactPaths);
  const lines = `${runResult.stdout.toString("utf8")}\n${runResult.stderr}`.split("\n").map((line) => line.trim()).filter(Boolean);
  const header = lines.find((line) => /^List of available languages/i.test(line)) ?? "";
  const languages = lines.filter((line) => line !== header && /^[A-Za-z0-9_]+$/.test(line));
  return { languages, data_directory: /"([^"]+)"/.exec(header)?.[1] ?? null };
}

/**
 * Runs OCR on one image file and returns stdout as text.
 *
 * @param context - Client context (object)
 * @param request - `{imagePath, languages, psm, outputFormat, dpi, signal}`; values already validated (object)
 * @returns `{text, truncated}` (object)
 */
async function recognize(context, { imagePath, languages, psm, outputFormat, dpi, signal }) {
  const args = [imagePath, "stdout", "-l", languages.join("+"), "--psm", String(psm), ...(dpi ? ["--dpi", String(dpi)] : []), ...(outputFormat === "text" ? [] : [outputFormat])];
  const runResult = await runTesseract(context, args, signal);
  if (runResult.exitCode !== 0 && !runResult.stdoutTruncated) throw describeFailure("tesseract", runResult, TESSERACT_HINT, context.redactPaths);
  return { text: runResult.stdout.toString("utf8"), truncated: runResult.stdoutTruncated };
}

/**
 * Renders one PDF page to a PNG in a private temp directory for the duration of `work`.
 *
 * @param context - Client context (object)
 * @param request - `{pdfPath, page, dpi, maxSide: {width, height}, signal}`; pdftoppm crops the render to maxSide
 *   pixels, so its memory stays bounded even when the page size is unknown (object)
 * @param work - `async (pngPath) => result` (function)
 * @returns Promise of work's result
 */
async function withRenderedPdfPage(context, { pdfPath, page, dpi, maxSide, signal }, work) {
  const scratchDirectory = await mkdtemp(join(tmpdir(), "graphrt-ocr-"));
  try {
    const cropArguments = ["-x", "0", "-y", "0", "-W", String(maxSide.width), "-H", String(maxSide.height)];
    const args = ["-f", String(page), "-l", String(page), "-r", String(dpi), ...cropArguments, "-png", "-singlefile", pdfPath, join(scratchDirectory, "page")];
    const runResult = await context.runProcess({ command: context.settings.pdftoppmCommand, args, timeoutMs: context.settings.timeoutMs, signal, maxStdoutBytes: 65536, displayName: "pdftoppm", setupHint: PDFTOPPM_HINT });
    if (runResult.exitCode !== 0) throw describeFailure("pdftoppm", runResult, PDFTOPPM_HINT, context.redactPaths);
    const [pngName] = (await readdir(scratchDirectory)).filter((fileName) => fileName.endsWith(".png"));
    if (!pngName) throw operationFailed("pdftoppm finished without writing the page image");
    return await work(join(scratchDirectory, pngName));
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

/**
 * Maps a failed run: a broken install (missing libraries, killed at load) is setup_required,
 * a bad page or unreadable file invalid_input, anything else plugin_error.
 *
 * @param displayName - Program name (string)
 * @param runResult - `{exitCode, signalCode, stderr}` (object)
 * @param setupHint - Install hint (string)
 * @param redactPaths - Hides paths outside the allowed directories, e.g. library locations (function, optional)
 * @returns PluginError
 */
export function describeFailure(displayName, { exitCode, signalCode, stderr }, setupHint, redactPaths = (text) => text) {
  // The first lines name the problem (e.g. "Library not loaded: ..."); later ones list paths tried.
  const firstLines = String(stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" | ");
  const detail = redactPaths(firstLines).slice(0, 300) || (signalCode ? `stopped by ${signalCode}` : `exit code ${exitCode}`);
  const fullText = String(stderr ?? "");
  if (/Library not loaded|error while loading shared libraries|image not found|Failed loading language|Error opening data file/i.test(fullText)) return setupRequired(`${displayName} cannot run: ${detail}. ${setupHint}`);
  if (/Wrong page range|Couldn't open file|Syntax Error|Error in pixReadStream|Unsupported image type|Image file .* cannot be read/i.test(fullText)) return invalidInput(`${displayName} could not read the input: ${detail}`);
  return operationFailed(`${displayName} failed: ${detail}`);
}
