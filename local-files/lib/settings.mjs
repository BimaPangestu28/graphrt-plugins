/**
 * Reads the local-files plugin's environment: the allowed directories, the
 * tool-write opt-in and the read, write and search caps.
 *
 * The settings object also has the shape lib/file-access.mjs (copied from the
 * local media plugins) expects, so its `resolveInputFile` and path redaction
 * work with LOCAL_FILES_ALLOWED_DIRS.
 */
import { homedir } from "node:os";
import { expandHome, readInteger, readOptInFlag, readText } from "./environment-readers.mjs";

export const ALLOWED_DIRS_VARIABLE = "LOCAL_FILES_ALLOWED_DIRS";
export const TOOL_WRITES_VARIABLE = "LOCAL_FILES_TOOL_ALLOW_WRITES";
export const LIMIT_VARIABLES = {
  maxReadBytes: "LOCAL_FILES_MAX_READ_BYTES",
  maxWriteBytes: "LOCAL_FILES_MAX_WRITE_BYTES",
  maxSearchFiles: "LOCAL_FILES_MAX_SEARCH_FILES",
};
export const ALL_VARIABLES = [ALLOWED_DIRS_VARIABLE, TOOL_WRITES_VARIABLE, ...Object.values(LIMIT_VARIABLES)];
const MEBIBYTE = 1024 * 1024;
/** No file read through this plugin may be bigger than this; reads past the cap are sliced, not refused. */
const FILE_SIZE_CEILING = Number.MAX_SAFE_INTEGER;

/**
 * Builds settings from environment variables.
 *
 * @param environment - Environment variables (object)
 * @returns `{inputDirectories, outputDirectory, maxInputBytes, maxOutputBytes, variables, homeDirectory, maxReadBytes, maxWriteBytes, maxSearchFiles, toolWritesAllowed}` (object)
 * @throws PluginError kind `invalid_input` - When a variable has an invalid value
 */
export function readLocalFilesSettings(environment = {}) {
  const homeDirectory = environment?.HOME || homedir();
  const maxWriteBytes = readInteger(environment, LIMIT_VARIABLES.maxWriteBytes, 10 * MEBIBYTE, { minimum: 1024, maximum: 1024 * MEBIBYTE });
  return {
    inputDirectories: readAllowedDirectories(environment, homeDirectory),
    outputDirectory: null,
    maxInputBytes: FILE_SIZE_CEILING,
    maxOutputBytes: maxWriteBytes,
    variables: { inputDirs: ALLOWED_DIRS_VARIABLE, outputDir: ALLOWED_DIRS_VARIABLE, maxInputBytes: LIMIT_VARIABLES.maxReadBytes, maxOutputBytes: LIMIT_VARIABLES.maxWriteBytes },
    homeDirectory,
    maxReadBytes: readInteger(environment, LIMIT_VARIABLES.maxReadBytes, MEBIBYTE, { minimum: 1024, maximum: 64 * MEBIBYTE }),
    maxWriteBytes,
    maxSearchFiles: readInteger(environment, LIMIT_VARIABLES.maxSearchFiles, 10000, { minimum: 10, maximum: 200000 }),
    toolWritesAllowed: readOptInFlag(environment, TOOL_WRITES_VARIABLE),
  };
}

function readAllowedDirectories(environment, homeDirectory) {
  return (readText(environment, ALLOWED_DIRS_VARIABLE) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => expandHome(entry, homeDirectory, ALLOWED_DIRS_VARIABLE));
}
