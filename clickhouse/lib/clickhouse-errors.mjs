/**
 * ClickHouse error mapping. ClickHouse answers errors with a plain-text body such as
 * `Code: 516. DB::Exception: default: Authentication failed ... (AUTHENTICATION_FAILED)`, and the HTTP status for
 * the same exception differs between versions and proxies (401, 403, 500). The exception code in the text is
 * reliable, so it decides the kind.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

// https://github.com/ClickHouse/ClickHouse/blob/master/src/Common/ErrorCodes.cpp
const KIND_BY_EXCEPTION_CODE = new Map([
  [192, "auth_error"], // UNKNOWN_USER
  [193, "auth_error"], // WRONG_PASSWORD
  [194, "auth_error"], // REQUIRED_PASSWORD
  [516, "auth_error"], // AUTHENTICATION_FAILED
  [164, "permission_denied"], // READONLY
  [497, "permission_denied"], // ACCESS_DENIED
  [16, "not_found"], // NO_SUCH_COLUMN_IN_TABLE
  [60, "not_found"], // UNKNOWN_TABLE
  [81, "not_found"], // UNKNOWN_DATABASE
  [46, "invalid_input"], // UNKNOWN_FUNCTION
  [47, "invalid_input"], // UNKNOWN_IDENTIFIER
  [62, "invalid_input"], // SYNTAX_ERROR
  [115, "invalid_input"], // UNKNOWN_SETTING
  [396, "invalid_input"], // TOO_MANY_ROWS_OR_BYTES (result limits)
  [456, "invalid_input"], // UNKNOWN_QUERY_PARAMETER
  [457, "invalid_input"], // BAD_QUERY_PARAMETER
  [159, "timeout"], // TIMEOUT_EXCEEDED
  [202, "rate_limited"], // TOO_MANY_SIMULTANEOUS_QUERIES
]);
const EXCEPTION_CODE_PATTERN = /Code: (\d+)\. DB::Exception/;

/**
 * Re-kinds a PluginError by the ClickHouse exception code in its message.
 *
 * @param pluginError - Error from the shared client (Error)
 * @returns A new PluginError with the mapped kind (only rate_limited stays retryable), or the error unchanged (Error)
 */
export function mapClickHouseError(pluginError) {
  if (!(pluginError instanceof PluginError)) return pluginError;
  const exceptionCode = Number(EXCEPTION_CODE_PATTERN.exec(pluginError.message)?.[1]);
  const kind = KIND_BY_EXCEPTION_CODE.get(exceptionCode);
  if (!kind) return pluginError;
  return new PluginError(pluginError.message, { kind, retryable: kind === "rate_limited", retryAfterMs: pluginError.retryAfterMs });
}

/**
 * Returns the definition with every operation's errors passed through mapClickHouseError.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns A new definition (object)
 */
export function mapOperationErrors(pluginDefinition) {
  const wrapOperation = (operation) => ({
    ...operation,
    run: async (context) => {
      try {
        return await operation.run(context);
      } catch (operationError) {
        throw mapClickHouseError(operationError);
      }
    },
  });
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
