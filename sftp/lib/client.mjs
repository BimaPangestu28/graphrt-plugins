/**
 * The client one sftp call works with: settings, the copied local
 * file-access module (SFTP_INPUT_DIRS for uploads, SFTP_OUTPUT_DIR for
 * downloads), the redactor and the session runner.
 */
import { promises as defaultFileSystem } from "node:fs";
import { randomBytes } from "node:crypto";
import { createFileAccess } from "./file-access.mjs";
import { createRedactor } from "./error-mapping.mjs";
import { permissionDenied } from "./errors.mjs";
import { loadSsh2Module, withSftpSession } from "./session.mjs";
import { readSftpSettings, TOOL_WRITES_VARIABLE } from "./settings.mjs";

/**
 * Creates the client for one call.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - `{loadSsh2, fileSystem}` overrides for tests (object, optional)
 * @returns `{settings, fileAccess, fileSystem, redact, randomSuffix, withSession, assertWriteAllowed}` (object)
 */
export function createSftpClient(environment, dependencies = {}) {
  const settings = readSftpSettings(environment);
  const client = {
    settings,
    fileSystem: dependencies.fileSystem ?? defaultFileSystem,
    fileAccess: createFileAccess(settings.files, dependencies.fileSystem ? { fileSystem: dependencies.fileSystem } : {}),
    redact: createRedactor(settings.secrets),
    loadSsh2: dependencies.loadSsh2 ?? loadSsh2Module,
    randomSuffix: () => randomBytes(6).toString("hex"),
  };
  return {
    ...client,
    withSession: (signal, work) => withSftpSession(client, signal, work),
    assertWriteAllowed: (source, operationName) => assertWriteAllowed(settings, source, operationName),
  };
}

function assertWriteAllowed(settings, source, operationName) {
  if (source === "node" || settings.toolWritesAllowed) return;
  throw permissionDenied(`\`${operationName}\` changes files on the server, so agents may not call it. Use a workflow node, or set ${TOOL_WRITES_VARIABLE}=1 to allow it for agents.`);
}
