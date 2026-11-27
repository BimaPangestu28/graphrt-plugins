/**
 * sftp plugin definition: list, stat, read, download and upload files over
 * SFTP (ssh2), with a pinned host key, credentials only from the environment
 * (redacted everywhere), remote paths confined to SFTP_ROOT and local paths
 * to the allowlisted directories. Tool calls are read-only unless
 * SFTP_TOOL_ALLOW_WRITES=1; overwrites and deletes are for workflow nodes.
 *
 * `noCredentials` here means nodes take no `access_token`: the server
 * credentials are read from SFTP_* variables, never from configs or tools.
 */
import { createSftpClient } from "./lib/client.mjs";
import { CALL_TIMEOUT_MS, CONNECTION_VARIABLES, FILE_VARIABLES, LIMIT_VARIABLES, TOOL_WRITES_VARIABLE } from "./lib/settings.mjs";
import { browseOperations } from "./operations/browse.mjs";
import { manageOperations } from "./operations/manage.mjs";
import { transferOperations } from "./operations/transfer.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{loadSsh2, fileSystem}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "sftp",
    version: "0.1.1",
    description: "SFTP with a pinned host key: list, stat and read remote files inside SFTP_ROOT, download to an allowed local directory, upload from one (staged, no overwrite unless a node asks); agent writes opt-in, deletes node only",
    extraEnv: [...CONNECTION_VARIABLES, ...Object.values(FILE_VARIABLES), TOOL_WRITES_VARIABLE, ...LIMIT_VARIABLES],
    noCredentials: true,
    limits: { timeout_ms: CALL_TIMEOUT_MS, max_concurrency: 4 },
    createClient: ({ environment }) => createSftpClient(environment, dependencies),
    operations: [...browseOperations, ...transferOperations, ...manageOperations],
  };
}

export const pluginDefinition = createPluginDefinition();
