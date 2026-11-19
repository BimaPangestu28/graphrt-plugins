/**
 * Builds the per-call "client" handed to operations: settings, the path
 * policy and a `run` entry point that executes statements in a worker process.
 */
import { resolveDatabasePath } from "./path-policy.mjs";
import { resolveSettings } from "./settings.mjs";

/**
 * Creates the client for one operation call.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - `{launchWorker, fileSystem}`; launchWorker is `(request, {signal, timeoutMs}) => Promise<result[]>` (object)
 * @returns `{settings, run(callRequest)}` (object)
 */
export function createSqliteClient(environment, { launchWorker, fileSystem }) {
  const settings = resolveSettings(environment);
  return {
    settings,
    limits: { statementTimeoutMs: settings.statementTimeoutMs, maxResultBytes: settings.maxResultBytes },
    /**
     * Resolves the database file and runs statements on it.
     *
     * @param callRequest - `{database, mode, createIfMissing, statements: [{sql, params, maxRows, maxBytes}], timeoutMs, signal}` (object)
     * @returns `{databasePath, results}` (object)
     */
    async run({ database, mode, createIfMissing = false, statements, timeoutMs, signal }) {
      const databasePath = await resolveDatabasePath(database, settings, { mode, createIfMissing }, fileSystem);
      const results = await launchWorker({ databasePath, mode, busyTimeoutMs: settings.busyTimeoutMs, statements }, { signal, timeoutMs });
      return { databasePath, results };
    },
  };
}
