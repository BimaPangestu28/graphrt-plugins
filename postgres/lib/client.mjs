/**
 * Builds the per-call "client" handed to operations: the resolved connection,
 * limits and policy, a redactor for its secrets, and read/write entry points on
 * the process-wide driver (which owns the pools).
 */
import { createRedactor } from "./errors.mjs";
import { resolveLimits, resolvePolicy } from "./settings.mjs";

/**
 * Creates the client for one operation call.
 *
 * @param inputs - Runner inputs (object)
 * @param inputs.accessToken - The connection from resolveConnection (object)
 * @param inputs.environment - Environment variables (object)
 * @param driver - From createPostgresDriver (object)
 * @returns `{limits, redact, readOnly(request), write(request)}`; requests carry `source` from the operation (object)
 */
export function createPostgresClient({ accessToken: connection, environment }, driver) {
  const limits = resolveLimits(environment);
  const { allowSuperuser } = resolvePolicy(environment);
  return {
    limits,
    redact: createRedactor(connection.secrets ?? []),
    readOnly: (request) => driver.runReadOnly(connection, { ...request, limits, allowSuperuser }),
    write: (request) => driver.runWrite(connection, { ...request, limits, allowSuperuser }),
  };
}
