/**
 * Allowlisted local file access for the local media plugins.
 *
 * Reads: a file must be a regular file inside `<PREFIX>_INPUT_DIRS` (or the
 * output directory, so one step's output can feed the next). The path is
 * realpath'd and compared against the realpath of every allowed directory
 * with a separator-suffixed prefix, so `/data/in-evil` never matches
 * `/data/in` and a symlink out of the allowlist is refused. FIFOs, devices,
 * sockets and directories are refused, and a missing file and a file outside
 * the allowlist get the same `not_found` error (no existence oracle).
 *
 * Inputs with more than one hard link are refused too: a hard link inside an
 * allowed directory to a file elsewhere would pass the realpath check.
 *
 * Writes: only new files in `<PREFIX>_OUTPUT_DIR`, with generated names
 * (`<hint>-<timestamp>-<random>.<ext>`), created with `wx` (O_CREAT|O_EXCL),
 * so an output never replaces an input or any existing file. Programs that
 * write by path (ffmpeg) write into a private 0700 staging directory inside
 * the output directory; the finished file is then hard-linked to its final
 * name (link() never replaces an existing file) and the staging copy removed.
 *
 * This file is identical in the ffmpeg, image-tools, pdf-tools, excel-csv,
 * ocr-tesseract, qr-code, local-files and sftp plugins; keep the copies in
 * step.
 */
import { constants as fileConstants, promises as defaultFileSystem } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import { invalidInput, notFound, operationFailed, setupRequired } from "./errors.mjs";
import { expandHome, readInteger, readText } from "./environment-readers.mjs";

const MAX_NAME_HINT_LENGTH = 48;
const MAX_NAME_ATTEMPTS = 5;
const OUTPUT_FILE_MODE = 0o644;

/** Schema for the optional `output_name` parameter shared by every operation that writes a file. */
export const OUTPUT_NAME_PARAMETER = {
  type: "string",
  description: "Start of the generated output file name (letters, digits, - and _; default: the input's name). A timestamp and random suffix are always added, so nothing is overwritten",
};

/**
 * Names of the file-access environment variables for a plugin prefix.
 *
 * @param prefix - e.g. "IMAGE_TOOLS" (string)
 * @returns `{inputDirs, outputDir, maxInputBytes, maxOutputBytes}` variable names (object)
 */
export function fileAccessVariableNames(prefix) {
  return {
    inputDirs: `${prefix}_INPUT_DIRS`,
    outputDir: `${prefix}_OUTPUT_DIR`,
    maxInputBytes: `${prefix}_MAX_INPUT_BYTES`,
    maxOutputBytes: `${prefix}_MAX_OUTPUT_BYTES`,
  };
}

/**
 * Reads the allowlist and size caps from the environment.
 *
 * @param environment - Environment variables (object)
 * @param options - `{prefix, defaultMaxInputBytes, defaultMaxOutputBytes, maxBytesCeiling}` (object)
 * @returns `{inputDirectories, outputDirectory, maxInputBytes, maxOutputBytes, variables, homeDirectory}` (object)
 * @throws PluginError kind `invalid_input` - When a variable has an invalid value
 */
export function readFileAccessSettings(environment, { prefix, defaultMaxInputBytes, defaultMaxOutputBytes, maxBytesCeiling }) {
  const variables = fileAccessVariableNames(prefix);
  const homeDirectory = environment?.HOME || homedir();
  const outputText = readText(environment, variables.outputDir);
  const byteBounds = { minimum: 1024, maximum: maxBytesCeiling };
  return {
    inputDirectories: (readText(environment, variables.inputDirs) ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => expandHome(entry, homeDirectory, variables.inputDirs)),
    outputDirectory: outputText ? expandHome(outputText, homeDirectory, variables.outputDir) : null,
    maxInputBytes: readInteger(environment, variables.maxInputBytes, defaultMaxInputBytes, byteBounds),
    maxOutputBytes: readInteger(environment, variables.maxOutputBytes, defaultMaxOutputBytes, byteBounds),
    variables,
    homeDirectory,
  };
}

/**
 * Creates the file access functions for one call.
 *
 * @param settings - From readFileAccessSettings (object)
 * @param dependencies - `{fileSystem, now, randomSuffix}` overrides for tests (object, optional)
 * @returns `{resolveInputFile, readInputFile, reserveOutputPath, createStagingOutput, writeOutputFile, writeOutputFiles, checkOutputFile, discardOutputFile, redactPaths}` (object)
 */
export function createFileAccess(settings, dependencies = {}) {
  const context = {
    settings,
    fileSystem: dependencies.fileSystem ?? defaultFileSystem,
    now: dependencies.now ?? (() => new Date()),
    randomSuffix: dependencies.randomSuffix ?? (() => randomBytes(4).toString("hex")),
  };
  return {
    resolveInputFile: (rawPath, options) => resolveInputFile(context, rawPath, options),
    readInputFile: (rawPath, options) => readInputFile(context, rawPath, options),
    reserveOutputPath: (naming) => reserveOutputPath(context, naming),
    createStagingOutput: (naming) => createStagingOutput(context, naming),
    writeOutputFile: (naming, bytes) => writeOutputFile(context, naming, bytes),
    writeOutputFiles: (items) => writeOutputFiles(context, items),
    checkOutputFile: (outputPath) => checkOutputFile(context, outputPath),
    discardOutputFile: (outputPath) => discardOutputFile(context, outputPath),
    redactPaths: (text) => redactPathsOutside(text, [...settings.inputDirectories, ...(settings.outputDirectory ? [settings.outputDirectory] : [])]),
  };
}

/**
 * Builds the hint for an output name: the caller's `output_name`, else the input file's name without extension.
 *
 * @param outputName - The `output_name` argument (string, optional)
 * @param inputPath - Path of the (first) input file (string, optional)
 * @returns Sanitised name hint, letters, digits, `-` and `_` only (string)
 */
export function buildNameHint(outputName, inputPath) {
  const rawHint = outputName ?? (inputPath ? basename(inputPath, extname(inputPath)) : "output");
  const sanitized = String(rawHint)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_NAME_HINT_LENGTH);
  return sanitized || "output";
}

async function resolveInputFile(context, rawPath, { parameterName = "input", extensions } = {}) {
  const readableDirectories = listReadableDirectories(context.settings);
  const givenPath = expandInputPath(rawPath, readableDirectories[0], context.settings.homeDirectory, parameterName);
  const outsideError = notFound(`No file at ${JSON.stringify(rawPath)} inside ${context.settings.variables.inputDirs}`);
  const realDirectories = await realpathAll(readableDirectories, context.fileSystem);
  const realPath = await context.fileSystem.realpath(givenPath).catch(() => {
    throw outsideError;
  });
  if (!isInsideAny(realPath, realDirectories)) throw outsideError;
  const fileStats = await context.fileSystem.stat(realPath);
  assertRegularFileWithinCap(fileStats, rawPath, context.settings);
  assertExtensionAllowed(realPath, extensions, parameterName);
  return { path: realPath, sizeBytes: fileStats.size };
}

function listReadableDirectories(settings) {
  const readableDirectories = [...settings.inputDirectories, ...(settings.outputDirectory ? [settings.outputDirectory] : [])];
  if (readableDirectories.length === 0) {
    throw setupRequired(`Set ${settings.variables.inputDirs} to the directories (comma-separated, absolute) that input files may be read from`);
  }
  return readableDirectories;
}

// Relative paths are taken relative to the first allowed directory; the containment check still applies.
function expandInputPath(rawPath, baseDirectory, homeDirectory, parameterName) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") throw invalidInput(`\`${parameterName}\` must be a file path`);
  if (rawPath.includes("\0")) throw invalidInput(`\`${parameterName}\` must not contain NUL characters`);
  const trimmedPath = rawPath.trim();
  if (trimmedPath === "~" || trimmedPath.startsWith("~/")) return expandHome(trimmedPath, homeDirectory, `\`${parameterName}\``);
  return isAbsolute(trimmedPath) ? resolve(trimmedPath) : resolve(baseDirectory, trimmedPath);
}

function assertRegularFileWithinCap(fileStats, rawPath, settings) {
  if (!fileStats.isFile()) throw invalidInput(`${JSON.stringify(rawPath)} is not a regular file`);
  if (fileStats.nlink > 1) throw invalidInput(`${JSON.stringify(rawPath)} has ${fileStats.nlink} hard links; copy it to a plain file first (hard links could point outside the allowed directories)`);
  if (fileStats.size > settings.maxInputBytes) {
    throw invalidInput(`${JSON.stringify(rawPath)} is ${fileStats.size} bytes, over the ${settings.maxInputBytes}-byte limit (${settings.variables.maxInputBytes})`);
  }
}

function assertExtensionAllowed(realPath, extensions, parameterName) {
  if (!extensions) return;
  const extension = extname(realPath).slice(1).toLowerCase();
  if (!extensions.includes(extension)) throw invalidInput(`\`${parameterName}\` must be a ${extensions.map((allowed) => `.${allowed}`).join(", ")} file`);
}

// O_NOFOLLOW and O_NONBLOCK: a path swapped for a symlink or FIFO after the checks fails instead of escaping or hanging.
async function readInputFile(context, rawPath, options) {
  const { path: realPath } = await resolveInputFile(context, rawPath, options);
  const fileHandle = await context.fileSystem.open(realPath, fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0) | (fileConstants.O_NONBLOCK ?? 0));
  try {
    const fileStats = await fileHandle.stat();
    assertRegularFileWithinCap(fileStats, rawPath, context.settings);
    return { path: realPath, bytes: await fileHandle.readFile() };
  } finally {
    await fileHandle.close();
  }
}

async function resolveOutputDirectory(context) {
  const { outputDirectory, variables } = context.settings;
  if (!outputDirectory) throw setupRequired(`Set ${variables.outputDir} to the directory (absolute) that output files are written to`);
  const realDirectory = await context.fileSystem.realpath(outputDirectory).catch(() => null);
  const directoryStats = realDirectory ? await context.fileSystem.stat(realDirectory) : null;
  if (!directoryStats?.isDirectory()) throw setupRequired(`${variables.outputDir} (${outputDirectory}) must be an existing directory`);
  return realDirectory;
}

/**
 * Builds a generated output file name.
 *
 * @param naming - `{nameHint, extension}` (object)
 * @param date - Timestamp to embed (Date)
 * @param suffix - Random suffix (string)
 * @returns e.g. "photo-20261119-080102-1a2b3c4d.webp" (string)
 */
export function buildOutputFileName({ nameHint, extension }, date, suffix) {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${buildNameHint(nameHint)}-${timestamp}-${suffix}.${extension}`;
}

// Creates the file exclusively, retrying with a new random suffix if the name is taken.
async function createExclusiveOutput(context, naming) {
  const realDirectory = await resolveOutputDirectory(context);
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const outputPath = join(realDirectory, buildOutputFileName(naming, context.now(), context.randomSuffix()));
    try {
      return { outputPath, fileHandle: await context.fileSystem.open(outputPath, "wx", OUTPUT_FILE_MODE) };
    } catch (openError) {
      if (openError?.code !== "EEXIST") throw operationFailed(`Could not create an output file in ${context.settings.variables.outputDir}: ${openError.message}`);
    }
  }
  throw operationFailed(`Could not find a free output file name in ${context.settings.variables.outputDir}`);
}

async function reserveOutputPath(context, naming) {
  const { outputPath, fileHandle } = await createExclusiveOutput(context, naming);
  await fileHandle.close();
  return outputPath;
}

/**
 * Builds a staging area for a program that writes its output by path.
 *
 * @param context - File access context (object)
 * @param naming - `{nameHint, extension}` for the final name (object)
 * @returns `{stagingPath, publish, discard}`; publish() links the finished file to a generated name and returns its path (object)
 */
async function createStagingOutput(context, naming) {
  const realDirectory = await resolveOutputDirectory(context);
  const stagingDirectory = await context.fileSystem.mkdtemp(join(realDirectory, ".staging-"));
  const stagingPath = join(stagingDirectory, `output.${naming.extension}`);
  const discard = () => context.fileSystem.rm(stagingDirectory, { recursive: true, force: true }).catch((removeError) => {
    process.stderr.write(`could not remove staging directory ${stagingDirectory}: ${removeError.message}\n`);
  });
  const publish = async () => {
    try {
      return await linkToFreeName(context, realDirectory, stagingPath, naming);
    } finally {
      await discard();
    }
  };
  return { stagingPath, publish, discard };
}

async function linkToFreeName(context, realDirectory, stagingPath, naming) {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const outputPath = join(realDirectory, buildOutputFileName(naming, context.now(), context.randomSuffix()));
    try {
      await context.fileSystem.link(stagingPath, outputPath);
      return outputPath;
    } catch (linkError) {
      if (linkError?.code !== "EEXIST") throw operationFailed(`Could not move the output into ${context.settings.variables.outputDir}: ${linkError.message}`);
    }
  }
  throw operationFailed(`Could not find a free output file name in ${context.settings.variables.outputDir}`);
}

// Several outputs from one call: all or nothing. On failure the ones already written are removed and named.
async function writeOutputFiles(context, items) {
  const written = [];
  try {
    for (const { naming, bytes } of items) written.push(await writeOutputFile(context, naming, bytes));
    return written;
  } catch (writeError) {
    for (const outputFile of written) await discardOutputFile(context, outputFile.path);
    const removedNote = written.length > 0 ? ` (removed the ${written.length} file(s) already written: ${written.map((outputFile) => outputFile.file_name).join(", ")})` : "";
    writeError.message = `${writeError.message}${removedNote}`;
    throw writeError;
  }
}

async function writeOutputFile(context, naming, bytes) {
  assertOutputWithinCap(context.settings, bytes.length);
  const { outputPath, fileHandle } = await createExclusiveOutput(context, naming);
  try {
    await fileHandle.writeFile(bytes);
    await fileHandle.close();
  } catch (writeError) {
    await fileHandle.close().catch(() => {});
    await discardOutputFile(context, outputPath);
    throw operationFailed(`Could not write ${outputPath}: ${writeError.message}`);
  }
  return describeOutputFile(outputPath, bytes.length);
}

function assertOutputWithinCap(settings, sizeBytes) {
  if (sizeBytes > settings.maxOutputBytes) {
    throw invalidInput(`The output would be ${sizeBytes} bytes, over the ${settings.maxOutputBytes}-byte limit (${settings.variables.maxOutputBytes}); nothing was written`);
  }
}

// For files written by an external program: checks the cap and describes the file, or removes it.
async function checkOutputFile(context, outputPath) {
  const fileStats = await context.fileSystem.stat(outputPath);
  if (fileStats.size > context.settings.maxOutputBytes) {
    await discardOutputFile(context, outputPath);
    assertOutputWithinCap(context.settings, fileStats.size);
  }
  return describeOutputFile(outputPath, fileStats.size);
}

async function discardOutputFile(context, outputPath) {
  await context.fileSystem.rm(outputPath, { force: true }).catch((removeError) => {
    process.stderr.write(`could not remove incomplete output ${outputPath}: ${removeError.message}\n`);
  });
}

/**
 * Describes a written output file for operation results.
 *
 * @param outputPath - Absolute path (string)
 * @param sizeBytes - File size (number)
 * @returns `{path, file_name, size_bytes}` (object)
 */
export function describeOutputFile(outputPath, sizeBytes) {
  return { path: outputPath, file_name: basename(outputPath), size_bytes: sizeBytes };
}

const POSIX_PATH_PATTERN = /(?<![\w.])\/[^\s'"`,;()<>|]+/g;
// A Windows path: an optional `\\?\` or `\\.\` prefix, then a drive (`C:\`, `C:/`) or two separators (`\\server`,
// `//server`), then its folders and a last name. Windows folder names often hold spaces ("Program Files (x86)",
// a user's full name), so a folder may have up to six more words after a space; the last name ends at the first space.
const WINDOWS_PATH_PATTERN = /(?<![\w.])(?:(?:\\\\[?.]\\(?:UNC\\)?)?(?:[A-Za-z]:[\\/]|[\\/]{2})|\\\\[?.]\\)(?:[^\s\\/:'"`,;()<>|]+(?: [^\s\\/:'"`,;<>|]+){0,6}[\\/])*[^\s\\/:'"`,;()<>|]*|(?<![\w.])\/[^\s'"`,;()<>|]+/gi;

/**
 * Replaces absolute paths outside the given directories with "[path]", so error messages from
 * programs (temp directories, library locations) do not reveal the rest of the file system.
 *
 * On Windows this covers drive paths with either separator (`C:\Users\me\x`, `C:/Users/me/x`), network paths
 * (`\\server\share\x`) and the long forms (`\\?\C:\x`, `\\?\UNC\server\share\x`); the comparison with the allowed
 * directories ignores letter case and the separator used, and a path with a `..` part is always hidden. Paths
 * written with a single leading `/` are hidden there too. On other systems only `/` paths are looked at.
 *
 * @param text - Message text (string)
 * @param allowedDirectories - Directories whose paths may stay (string[])
 * @param platform - `process.platform` of the system the paths come from (string, optional)
 * @returns Redacted text (string)
 *
 * @example
 * redactPathsOutside("Library not loaded: /opt/lib/x.dylib", ["/data"]); // "Library not loaded: [path]"
 * redactPathsOutside("Cannot open C:\\Users\\me\\x.dll", ["D:\\data"], "win32"); // "Cannot open [path]"
 */
export function redactPathsOutside(text, allowedDirectories, platform = process.platform) {
  if (platform !== "win32") {
    return String(text ?? "").replace(POSIX_PATH_PATTERN, (candidatePath) => (isInsideAny(candidatePath, allowedDirectories, "/") ? candidatePath : "[path]"));
  }
  const allowedKeys = allowedDirectories.map(toWindowsComparisonKey);
  return String(text ?? "").replace(WINDOWS_PATH_PATTERN, (candidatePath) => (isInsideAnyWindows(candidatePath, allowedKeys) ? candidatePath : "[path]"));
}

// The same folder can be written C:\Data\In, c:/data/in or \\?\C:\Data\In; all three give `c:\data\in`.
function toWindowsComparisonKey(windowsPath) {
  return windowsPath
    .replaceAll("/", "\\")
    .replace(/^\\\\[?.]\\UNC\\/i, "\\\\")
    .replace(/^\\\\[?.]\\(?=[A-Za-z]:)/, "")
    .replace(/\\+$/, "")
    .toLowerCase();
}

function isInsideAnyWindows(candidatePath, allowedKeys) {
  const candidateKey = toWindowsComparisonKey(candidatePath);
  if (candidateKey.split("\\").includes("..")) return false;
  return allowedKeys.some((allowedKey) => candidateKey.startsWith(`${allowedKey}\\`));
}

async function realpathAll(directories, fileSystem) {
  const realDirectories = await Promise.all(directories.map((directory) => fileSystem.realpath(directory).catch(() => null)));
  return realDirectories.filter(Boolean);
}

function isInsideAny(candidatePath, directories, separator = sep) {
  return directories.some((directory) => candidatePath.startsWith(directory.endsWith(separator) ? directory : `${directory}${separator}`));
}
