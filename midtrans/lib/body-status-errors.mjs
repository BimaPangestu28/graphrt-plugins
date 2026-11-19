/**
 * Midtrans Core API errors inside 2xx bodies. Core API answers some failures with HTTP 200 and a body
 * `{"status_code": "412", "status_message": "Merchant cannot modify the status of the transaction"}`, so the HTTP
 * status alone does not say whether a request worked. This wrapper reads `status_code` from each listed operation's
 * data and throws a PluginError unless the code is one the operation expects (e.g. "407" is a successful answer of
 * get_transaction_status for an expired transaction and of expire_transaction).
 *
 * A body error is a definite answer from Midtrans (nothing was applied), so writes are not "outcome unknown"; only
 * a body 5xx is, and it is never retryable for writes.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const KIND_BY_STATUS_CODE = {
  400: "invalid_input",
  401: "auth_error",
  402: "permission_denied",
  403: "permission_denied",
  404: "not_found",
  405: "invalid_input",
  406: "invalid_input",
  410: "permission_denied",
  411: "invalid_input",
  412: "invalid_input",
  413: "invalid_input",
  414: "invalid_input",
  429: "rate_limited",
};
const STATUS_CODE_PATTERN = /^\d{3}$/;

/**
 * Turns a Midtrans body `status_code` into an error, or null when the code is expected.
 *
 * @param body - Response body (object)
 * @param expectedCodes - Codes that mean success for this operation, e.g. ["200", "201"] (string[])
 * @param isWrite - Whether the request was a write (5xx then has an unknown outcome) (boolean)
 * @returns PluginError or null (PluginError | null)
 *
 * @example
 * describeBodyStatusError({ status_code: "404", status_message: "Transaction doesn't exist." }, ["200"], false);
 * // PluginError kind not_found
 */
export function describeBodyStatusError(body, expectedCodes, isWrite) {
  const statusCode = String(body?.status_code ?? "");
  if (!STATUS_CODE_PATTERN.test(statusCode) || expectedCodes.includes(statusCode)) return null;
  const message = `Midtrans status_code ${statusCode}: ${body.status_message ?? "no status_message"}`;
  if (statusCode.startsWith("5")) {
    const note = isWrite ? " (outcome unknown: the write may have been applied; check get_transaction_status before retrying)" : "";
    return new PluginError(`${message}${note}`, { kind: "api_error", retryable: !isWrite });
  }
  // Any 2xx status_code passes, listed or not (e.g. 201 pending, 202 denied): it is an answer about the transaction,
  // not a failed request, and the caller reads transaction_status.
  if (statusCode.startsWith("2")) return null;
  return new PluginError(message, { kind: KIND_BY_STATUS_CODE[statusCode] ?? "api_error", retryable: statusCode === "429" && !isWrite });
}

/**
 * Returns the definition with body `status_code` checks on the listed operations.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param expectedCodesByOperation - `{operationName: ["200", ...]}` (object)
 * @returns A new definition (object)
 */
export function checkBodyStatusCodes(pluginDefinition, expectedCodesByOperation) {
  const writeNames = new Set((pluginDefinition.restSpec?.operations ?? []).filter((operation) => operation.write !== "read").map((operation) => operation.name));
  const wrapOperation = (operation) => {
    const expectedCodes = expectedCodesByOperation[operation.name];
    if (!expectedCodes) return operation;
    const run = async (context) => {
      const result = await operation.run(context);
      const bodyError = describeBodyStatusError(result?.data, expectedCodes, writeNames.has(operation.name));
      if (bodyError) throw bodyError;
      return result;
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
