/**
 * Reads the sftp plugin's environment: the server, the pinned host key, the
 * credentials, the remote root, the local file allowlist and the limits.
 *
 * Credentials come only from the environment (never from node configs or
 * tool arguments). Every secret is collected in `secrets` for redaction.
 */
import { posix } from "node:path";
import { fileAccessVariableNames, readFileAccessSettings } from "./file-access.mjs";
import { readInteger, readOptInFlag, readText } from "./environment-readers.mjs";
import { invalidInput, setupRequired } from "./errors.mjs";
import { parseFingerprints } from "./host-key.mjs";

export const ENVIRONMENT_PREFIX = "SFTP";
export const FILE_VARIABLES = fileAccessVariableNames(ENVIRONMENT_PREFIX);
export const CONNECTION_VARIABLES = ["SFTP_HOST", "SFTP_PORT", "SFTP_USERNAME", "SFTP_PASSWORD", "SFTP_PRIVATE_KEY", "SFTP_PRIVATE_KEY_PATH", "SFTP_PRIVATE_KEY_PASSPHRASE", "SFTP_HOST_FINGERPRINT", "SFTP_ROOT"];
export const TOOL_WRITES_VARIABLE = "SFTP_TOOL_ALLOW_WRITES";
export const LIMIT_VARIABLES = ["SFTP_CONNECT_TIMEOUT_MS", "SFTP_OPERATION_TIMEOUT_MS", "SFTP_MAX_READ_BYTES"];
/** The manifest's per-call limit; an operation's own timeout stays below it. */
export const CALL_TIMEOUT_MS = 1800000;
const GIBIBYTE = 1024 ** 3;

/**
 * Builds settings from environment variables. Connection details are only checked when a call connects.
 *
 * @param environment - Environment variables (object)
 * @returns `{files, connectTimeoutMs, operationTimeoutMs, maxReadBytes, toolWritesAllowed, secrets, environment}` (object)
 * @throws PluginError kind `invalid_input` - When a limit or directory variable is invalid
 */
export function readSftpSettings(environment = {}) {
  return {
    files: readFileAccessSettings(environment, { prefix: ENVIRONMENT_PREFIX, defaultMaxInputBytes: GIBIBYTE, defaultMaxOutputBytes: GIBIBYTE, maxBytesCeiling: 64 * GIBIBYTE }),
    connectTimeoutMs: readInteger(environment, "SFTP_CONNECT_TIMEOUT_MS", 15000, { minimum: 1000, maximum: 120000 }),
    operationTimeoutMs: readInteger(environment, "SFTP_OPERATION_TIMEOUT_MS", 600000, { minimum: 1000, maximum: CALL_TIMEOUT_MS - 20000 }),
    maxReadBytes: readInteger(environment, "SFTP_MAX_READ_BYTES", 1024 * 1024, { minimum: 1024, maximum: 64 * 1024 * 1024 }),
    toolWritesAllowed: readOptInFlag(environment, TOOL_WRITES_VARIABLE),
    secrets: ["SFTP_PASSWORD", "SFTP_PRIVATE_KEY", "SFTP_PRIVATE_KEY_PASSPHRASE"].map((variableName) => environment?.[variableName]).filter(Boolean),
    environment,
  };
}

/**
 * Reads and checks what a connection needs.
 *
 * @param environment - Environment variables (object)
 * @returns `{host, port, username, password, privateKey, privateKeyPath, passphrase, fingerprints, remoteRoot}` (object)
 * @throws PluginError kinds `setup_required` (something missing), `invalid_input` (malformed value)
 */
export function readConnectionSettings(environment) {
  const fingerprintText = readText(environment, "SFTP_HOST_FINGERPRINT");
  if (!fingerprintText) {
    throw setupRequired("Set SFTP_HOST_FINGERPRINT to the server's SHA256 host key fingerprint (e.g. `ssh-keyscan -p 22 host | ssh-keygen -lf -`, checked out of band); unknown hosts are refused");
  }
  const connection = {
    host: requireText(environment, "SFTP_HOST"),
    port: readInteger(environment, "SFTP_PORT", 22, { minimum: 1, maximum: 65535 }),
    username: requireText(environment, "SFTP_USERNAME"),
    password: environment?.SFTP_PASSWORD || undefined,
    privateKey: environment?.SFTP_PRIVATE_KEY || undefined,
    privateKeyPath: readText(environment, "SFTP_PRIVATE_KEY_PATH") ?? undefined,
    passphrase: environment?.SFTP_PRIVATE_KEY_PASSPHRASE || undefined,
    fingerprints: parseFingerprints(fingerprintText),
    remoteRoot: readRemoteRoot(environment),
  };
  if (!connection.password && !connection.privateKey && !connection.privateKeyPath) {
    throw setupRequired("Set SFTP_PASSWORD, SFTP_PRIVATE_KEY (PEM/OpenSSH text) or SFTP_PRIVATE_KEY_PATH");
  }
  return connection;
}

function requireText(environment, variableName) {
  const value = readText(environment, variableName);
  if (!value) throw setupRequired(`Set ${variableName}`);
  return value;
}

function readRemoteRoot(environment) {
  const root = requireText(environment, "SFTP_ROOT");
  if (!root.startsWith("/")) throw invalidInput("SFTP_ROOT must be an absolute path on the server, e.g. /home/deploy/exchange");
  return posix.resolve(root);
}
