/**
 * The client one local-files call works with: settings, the injectable file
 * system, the copied file-access module (for regular-file reads and path
 * redaction) and the path guard (directories and new targets).
 */
import { promises as defaultFileSystem } from "node:fs";
import { randomBytes } from "node:crypto";
import { createFileAccess } from "./file-access.mjs";
import { createPathGuard } from "./path-guard.mjs";
import { readLocalFilesSettings } from "./settings.mjs";

/**
 * Creates the client for one call.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - `{fileSystem, randomSuffix}` overrides for tests (object, optional)
 * @returns `{settings, fileSystem, fileAccess, pathGuard, randomSuffix, redactPaths}` (object)
 * @throws PluginError kind `invalid_input` - When the environment is invalid
 */
export function createLocalFilesClient(environment, dependencies = {}) {
  const settings = readLocalFilesSettings(environment);
  const fileSystem = dependencies.fileSystem ?? defaultFileSystem;
  const fileAccess = createFileAccess(settings, { fileSystem });
  return {
    settings,
    fileSystem,
    fileAccess,
    pathGuard: createPathGuard(settings, fileSystem),
    randomSuffix: dependencies.randomSuffix ?? (() => randomBytes(6).toString("hex")),
    redactPaths: fileAccess.redactPaths,
  };
}
