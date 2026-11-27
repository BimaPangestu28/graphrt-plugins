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
 * This file is copied from shared/optional into the plugins that
 * shared/optional/plugins.json names (npm run sync); edit it only there.
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

// How far a path in a message goes. A path starts at `/` (or, on Windows, a drive `C:\`, `C:/`, two separators
// `\\server`, `//server`, or a `\\?\` / `\\.\` prefix) and the end is found by these rules, in order:
//  1. A path right after a quote (' " ` ‘ “) runs to the matching closing quote on the same line, spaces and all.
//  2. Otherwise its folders may hold spaces ("Program Files (x86)", "Budi Santoso"): a folder is up to seven words
//     that end in a separator.
//  3. The last name ends at the first space, unless its first word has no file extension and the text goes on with
//     a single space: then it runs over up to six more words, to the first one with an extension ("My File.txt",
//     "Invoice (1).pdf"), or else over the words that start with a capital letter ("C:\Users\Budi Santoso").
//  4. A `.` or `:` at the very end is the sentence's, not the path's.
// Words never run past a line break, a separator, another drive or punctuation such as `:` `,` `;` `)`, so in
// "x.dll: not found", "C:\Docs failed" or "(os error 2)" the text after the path stays. When a rule cannot tell,
// it hides more, not less.
const MAX_FOLDER_EXTRA_WORDS = 6;
const MAX_NAME_EXTRA_WORDS = 6;
const QUOTE_PAIRS = { "'": "'", "\"": "\"", "`": "`'", "\u2018": "\u2019", "\u201C": "\u201D" };
const AFTER_CLOSING_QUOTE = /[\s:,.;)\]]/;
const FILE_EXTENSION = /\.(?=[0-9]*[A-Za-z])[A-Za-z0-9]{1,8}$/;
const CAPITALISED = /^\p{Lu}/u;

function buildPathForm({ start, separator, nameCharacter, wordCharacter }) {
  return {
    start,
    separator: new RegExp(`^${separator}$`),
    folders: new RegExp(`(?:(?:${nameCharacter}+(?: ${wordCharacter}+){0,${MAX_FOLDER_EXTRA_WORDS}})?${separator})*`, "uy"),
    firstWord: new RegExp(`${nameCharacter}*`, "uy"),
    word: new RegExp(`${wordCharacter}+`, "uy"),
  };
}

const PATH_FORMS = {
  posix: buildPathForm({
    start: /(?<![\w.])\//g,
    separator: "\\/",
    nameCharacter: "[^\\s\\/'\"`,;()<>|]",
    wordCharacter: "[^\\s\\/:'\"`,;<>|]",
  }),
  win32: buildPathForm({
    start: /(?<![\w.])(?:(?:\\\\[?.]\\(?:UNC\\)?)?(?:[A-Za-z]:[\\/]|[\\/]{2})|\\\\[?.]\\|\/)/gi,
    separator: "[\\\\\\/]",
    nameCharacter: "[^\\s\\\\\\/:'\"`,;()<>|]",
    wordCharacter: "[^\\s\\\\\\/:'\"`,;<>|]",
  }),
};

/**
 * Replaces absolute paths outside the given directories with "[path]", so error messages from
 * programs (temp directories, library locations) do not reveal the rest of the file system.
 *
 * On Windows this covers drive paths with either separator (`C:\Users\me\x`, `C:/Users/me/x`), network paths
 * (`\\server\share\x`) and the long forms (`\\?\C:\x`, `\\?\UNC\server\share\x`); the comparison with the allowed
 * directories ignores letter case and the separator used. Paths written with a single leading `/` are hidden there
 * too. On other systems only `/` paths are looked at. A path with a `..` part is always hidden. Names with spaces
 * are hidden whole (see the rules above PATH_FORMS).
 *
 * @param text - Message text (string)
 * @param allowedDirectories - Directories whose paths may stay (string[])
 * @param platform - `process.platform` of the system the paths come from (string, optional)
 * @returns Redacted text (string)
 *
 * @example
 * redactPathsOutside("Library not loaded: /opt/lib/x.dylib", ["/data"]); // "Library not loaded: [path]"
 * redactPathsOutside("Cannot open C:\\Users\\me\\My File.dll: denied", ["D:\\data"], "win32"); // "Cannot open [path]: denied"
 */
export function redactPathsOutside(text, allowedDirectories, platform = process.platform) {
  const message = String(text ?? "");
  if (platform !== "win32") return replacePaths(message, PATH_FORMS.posix, (candidatePath) => isInsideAnyPosix(candidatePath, allowedDirectories));
  const allowedKeys = allowedDirectories.map(toWindowsComparisonKey);
  return replacePaths(message, PATH_FORMS.win32, (candidatePath) => isInsideAnyWindows(candidatePath, allowedKeys));
}

function replacePaths(message, form, isAllowed) {
  const startPattern = new RegExp(form.start.source, form.start.flags);
  let redacted = "";
  let copiedUpTo = 0;
  for (let match = startPattern.exec(message); match !== null; match = startPattern.exec(message)) {
    const pathStart = match.index;
    const pathEnd = findPathEnd(message, pathStart, pathStart + match[0].length, form);
    // A lone "/" (as in "4 / 3") is not a path.
    if (match[0] === "/" && pathEnd === pathStart + 1) continue;
    const candidatePath = message.slice(pathStart, pathEnd);
    redacted += message.slice(copiedUpTo, pathStart) + (isAllowed(candidatePath) ? candidatePath : "[path]");
    copiedUpTo = pathEnd;
    startPattern.lastIndex = pathEnd;
  }
  return redacted + message.slice(copiedUpTo);
}

function findPathEnd(message, pathStart, bodyStart, form) {
  const closingQuote = findClosingQuote(message, pathStart);
  if (closingQuote !== -1) return closingQuote;
  const nameStart = matchEnd(form.folders, message, bodyStart);
  const firstWordEnd = matchEnd(form.firstWord, message, nameStart);
  const lastNameEnd = extendLastName(message, nameStart, firstWordEnd, form);
  return trimSentencePunctuation(message, nameStart, lastNameEnd);
}

function matchEnd(stickyPattern, message, position) {
  stickyPattern.lastIndex = position;
  return stickyPattern.test(message) ? stickyPattern.lastIndex : position;
}

// The closing quote must be followed by a space, punctuation or the end: "Budi's File.txt" keeps its apostrophe.
function findClosingQuote(message, pathStart) {
  const closingQuotes = QUOTE_PAIRS[message[pathStart - 1]];
  if (!closingQuotes) return -1;
  for (let position = pathStart; position < message.length && message[position] !== "\n"; position += 1) {
    const isFollowedByBreak = position + 1 === message.length || AFTER_CLOSING_QUOTE.test(message[position + 1]);
    if (closingQuotes.includes(message[position]) && isFollowedByBreak) return position;
  }
  return -1;
}

function extendLastName(message, nameStart, firstWordEnd, form) {
  const firstWord = message.slice(nameStart, firstWordEnd);
  if (firstWord === "" || /[.:]$/.test(firstWord) || FILE_EXTENSION.test(firstWord) || message[firstWordEnd] !== " ") return firstWordEnd;
  const followingWords = readFollowingWords(message, firstWordEnd, form);
  const wordWithExtension = followingWords.find((followingWord) => FILE_EXTENSION.test(followingWord.text));
  if (wordWithExtension) return wordWithExtension.end;
  let lastNameEnd = firstWordEnd;
  for (const followingWord of followingWords) {
    if (!CAPITALISED.test(followingWord.text)) break;
    lastNameEnd = followingWord.end;
  }
  return lastNameEnd;
}

// The words after a name, each after one space: `{text, end}`. A word that is followed by anything but a space
// (punctuation, a line break, the end) or that ends with a dot is the last one.
function readFollowingWords(message, position, form) {
  const followingWords = [];
  let wordStart = position + 1;
  while (followingWords.length < MAX_NAME_EXTRA_WORDS && message[wordStart - 1] === " ") {
    const wordEnd = matchEnd(form.word, message, wordStart);
    const nextCharacter = message[wordEnd] ?? "";
    // Not a word: nothing there, or the start of something else, such as a separator or a drive ("C:\").
    if (wordEnd === wordStart || form.separator.test(nextCharacter) || (nextCharacter === ":" && form.separator.test(message[wordEnd + 1] ?? ""))) break;
    const word = message.slice(wordStart, wordEnd);
    followingWords.push({ text: word.replace(/\.+$/, ""), end: wordEnd });
    if (nextCharacter !== " " || word.endsWith(".")) break;
    wordStart = wordEnd + 1;
  }
  return followingWords;
}

// "x.mp4." and "x.so:" end a sentence or start a message; a name that is only dots ("..") stays as it is.
function trimSentencePunctuation(message, nameStart, nameEnd) {
  let end = nameEnd;
  while (end > nameStart + 1 && /[.:]/.test(message[end - 1]) && !/[.:]/.test(message[nameStart])) end -= 1;
  return end;
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

function isInsideAnyPosix(candidatePath, allowedDirectories) {
  if (candidatePath.split("/").includes("..")) return false;
  return isInsideAny(candidatePath, allowedDirectories, "/");
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
