/**
 * Builds the per-operation "client" handed to operations: validated settings,
 * the redactor built from the URL, the keyspace (prefix) helpers, and
 * `send` / `sendAll`, which run raw commands on the pooled connection and
 * return Buffer replies.
 *
 * Commands are always argument arrays handed to the RESP encoder; nothing is
 * ever built by string concatenation.
 */
import { cancelled } from "./errors.mjs";
import { createConnectionPool } from "./connection-pool.mjs";
import { createKeyspace } from "./keyspace.mjs";
import { buildUrlSecrets, createRedactor } from "./redaction.mjs";
import { resolveSettings } from "./settings.mjs";

/**
 * Creates a client factory with injectable side effects.
 *
 * @param dependencies - Overrides for tests (object, all optional)
 * @param dependencies.loadRedis - `async () => RedisClass` (function)
 * @param dependencies.timers - `{setTimeout, clearTimeout}` for idle closing (object)
 * @returns `{createClient({accessToken, environment}), closeAllClients(), waitForRunningOperations(timeoutMs)}` (object)
 */
export function createClientFactory(dependencies = {}) {
  const pool = createConnectionPool({ loadRedis: dependencies.loadRedis, timers: dependencies.timers });
  return {
    createClient({ accessToken, environment }) {
      const redact = createRedactor(buildUrlSecrets(accessToken));
      const settings = resolveSettings(environment, accessToken);
      const run = (work, { signal, isWrite = false } = {}) => raceWithSignal(pool.withConnection(settings, work), signal, isWrite);
      return {
        settings,
        redact,
        keyspace: createKeyspace(settings.keyPrefix),
        /** Sends one command; resolves with its (Buffer) reply. */
        send: (commandName, commandArguments, options) => run((connection) => connection.callBuffer(commandName, ...commandArguments), options),
        /** Sends several commands at once on the same connection; resolves with `{status, value|reason}` per command. */
        sendAll: (commands, options) =>
          run((connection) => Promise.allSettled(commands.map(([commandName, commandArguments]) => connection.callBuffer(commandName, ...commandArguments))), options),
      };
    },
    /** Closes every pooled connection (plugin shutdown). */
    closeAllClients: () => pool.closeAll(),
    /** Waits for running operations, at most `timeoutMs` (plugin shutdown). */
    waitForRunningOperations: (timeoutMs) => pool.waitForIdle(timeoutMs),
  };
}

/**
 * Resolves with the operation, or rejects with `cancelled` as soon as the signal aborts.
 * The command itself cannot be recalled; REDIS_COMMAND_TIMEOUT_MS bounds it.
 *
 * @param operation - Running work (Promise)
 * @param signal - Host cancel or tool deadline (AbortSignal, optional)
 * @param isWrite - Writes may already have been applied when cancelled (boolean)
 * @returns The operation's result (Promise)
 */
export function raceWithSignal(operation, signal, isWrite) {
  if (!signal) return operation;
  operation.catch(() => {});
  if (signal.aborted) return Promise.reject(cancelled(isWrite));
  let removeListener = () => {};
  const abortion = new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled(isWrite));
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = () => signal.removeEventListener("abort", onAbort);
  });
  return Promise.race([operation, abortion]).finally(removeListener);
}
