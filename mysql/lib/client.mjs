/**
 * Builds the per-call "client" handed to operations: the resolved connection,
 * limits, a redactor for its secrets, and read/write entry points on the
 * process-wide driver (which owns the pools).
 */
import { createRedactor } from "./errors.mjs";
import { resolveLimits } from "./settings.mjs";

/**
 * Creates the client for one operation call.
 *
 * @param inputs - Runner inputs (object)
 * @param inputs.accessToken - The connection from resolveConnection (object)
 * @param inputs.environment - Environment variables (object)
 * @param driver - From createMysqlDriver (object)
 * @returns `{limits, redact, readOnly(request), write(request)}` (object)
 */
export function createMysqlClient({ accessToken: connection, environment }, driver) {
  const limits = resolveLimits(environment);
  const prepare = (request) => ({ ...request, params: request.params.map(toWireValue), limits });
  return {
    limits,
    redact: createRedactor(connection.secrets ?? []),
    readOnly: (request) => driver.runReadOnly(connection, prepare(request)),
    write: (request) => driver.runWrite(connection, prepare(request)),
  };
}

// Prepared statements take scalars only: JSON values are sent as JSON text, booleans as 1 / 0.
function toWireValue(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}
