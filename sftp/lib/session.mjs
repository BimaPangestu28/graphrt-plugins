/**
 * One SFTP session per call: connect (host key pinned, env credentials, no
 * SSH agent, no keyboard-interactive), open the SFTP subsystem, run the
 * work, always close. The whole call is bounded by SFTP_OPERATION_TIMEOUT_MS
 * and the caller's signal; either closes the connection at once, which fails
 * every pending request.
 *
 * ssh2 is imported lazily, so a missing `npm install` is `setup_required`.
 */
import { promises as defaultFileSystem } from "node:fs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { cancelled, classifyImportError, timedOut } from "./errors.mjs";
import { createHostVerifier } from "./host-key.mjs";
import { readConnectionSettings } from "./settings.mjs";
import { mapSftpError } from "./error-mapping.mjs";

/**
 * Loads the ssh2 module.
 *
 * @returns The ssh2 module (Promise<object>)
 * @throws PluginError kind `setup_required` - When ssh2 is not installed
 */
export async function loadSsh2Module() {
  try {
    return await import("ssh2");
  } catch (importError) {
    throw classifyImportError("ssh2", "sftp", importError);
  }
}

/**
 * Runs `work(sftp, connection)` inside a fresh, pinned SFTP session.
 *
 * @param client - `{settings, loadSsh2, fileSystem, redact}` (object)
 * @param signal - Caller's signal (AbortSignal, optional)
 * @param work - `async (sftp, connection) => result`; connection has `remoteRoot` (function)
 * @returns work's result (Promise)
 * @throws PluginError kinds `setup_required`, `auth_error`, `network_error`, `timeout`, `cancelled`, `not_found`, ...
 */
export async function withSftpSession(client, signal, work) {
  const connection = readConnectionSettings(client.settings.environment);
  const privateKey = connection.privateKey ?? (connection.privateKeyPath ? await readPrivateKey(client.fileSystem ?? defaultFileSystem, connection.privateKeyPath) : undefined);
  const ssh2 = await client.loadSsh2();
  const hostVerifier = createHostVerifier(connection.fingerprints);
  const sshClient = new ssh2.Client();
  let isClosed = false;
  const closeConnection = () => {
    if (isClosed) return;
    isClosed = true;
    sshClient.end();
  };
  const stopper = createStopper(client.settings.operationTimeoutMs, signal, closeConnection);
  try {
    const sftp = await stopper.race(connectAndOpenSftp(sshClient, { connection, privateKey, hostVerifier, connectTimeoutMs: client.settings.connectTimeoutMs }));
    return await stopper.race(work(sftp, connection));
  } catch (sessionError) {
    throw mapSftpError(stopper.reason() ?? sessionError, { redact: client.redact, rejectedFingerprint: hostVerifier.rejectedFingerprint() });
  } finally {
    stopper.dispose();
    sshClient.removeAllListeners("error");
    sshClient.on("error", () => {});
    closeConnection();
  }
}

async function readPrivateKey(fileSystem, privateKeyPath) {
  try {
    return await fileSystem.readFile(privateKeyPath);
  } catch (readError) {
    throw new PluginError(`Could not read SFTP_PRIVATE_KEY_PATH: ${readError.code ?? readError.message}`, { kind: "setup_required" });
  }
}

function connectAndOpenSftp(sshClient, { connection, privateKey, hostVerifier, connectTimeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    sshClient.once("error", rejectPromise);
    sshClient.once("close", () => rejectPromise(new PluginError("The SSH connection closed before the SFTP session opened", { kind: "network_error", retryable: true })));
    sshClient.once("ready", () => {
      sshClient.sftp((sftpError, sftp) => (sftpError ? rejectPromise(sftpError) : resolvePromise(sftp)));
    });
    sshClient.connect({
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      privateKey,
      passphrase: connection.passphrase,
      agent: undefined,
      tryKeyboard: false,
      readyTimeout: connectTimeoutMs,
      keepaliveInterval: 10000,
      hostVerifier: hostVerifier.verify,
    });
  });
}

// One timer and one abort listener for the whole call; `race` makes every awaited step stop when they fire.
function createStopper(timeoutMs, signal, closeConnection) {
  let stopReason = null;
  let rejectStopped;
  const stopped = new Promise((unused, reject) => {
    rejectStopped = reject;
  });
  stopped.catch(() => {});
  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    closeConnection();
    rejectStopped(reason);
  };
  const timer = setTimeout(() => stop(timedOut("The SFTP operation", timeoutMs)), timeoutMs);
  const onAbort = () => stop(cancelled("The SFTP operation"));
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    race: (promise) => Promise.race([promise, stopped]),
    reason: () => stopReason,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}
