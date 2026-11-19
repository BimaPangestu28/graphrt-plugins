/**
 * Lazada Open Platform request signing (pure functions, no I/O).
 *
 * Algorithm (Lazada Open Platform "Signature", as implemented by the official lazop SDKs):
 *   1. take every request parameter (system and business, query and form; never `sign` itself or file bytes),
 *   2. sort them by name (byte order),
 *   3. concatenate the API path (e.g. "/orders/get", without "/rest") with name1value1name2value2...,
 *   4. sign = uppercase hex of HMAC-SHA256(key = app secret, message = that string).
 */
import { createHmac } from "node:crypto";

/**
 * Builds the string Lazada signs.
 *
 * @param apiPath - API path without host and "/rest", e.g. "/orders/get" (string)
 * @param parameters - Every parameter except `sign`, values as sent (object of strings)
 * @returns Base string (string)
 *
 * @example
 * buildLazadaBaseString("/order/get", { order_id: "1", app_key: "123" }); // "/order/getapp_key123order_id1"
 */
export function buildLazadaBaseString(apiPath, parameters) {
  const sortedNames = Object.keys(parameters)
    .filter((parameterName) => parameterName !== "sign")
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return `${apiPath}${sortedNames.map((parameterName) => `${parameterName}${parameters[parameterName]}`).join("")}`;
}

/**
 * Computes the request signature.
 *
 * @param appSecret - App secret (string)
 * @param apiPath - API path, e.g. "/orders/get" (string)
 * @param parameters - Every parameter except `sign` (object of strings)
 * @returns Uppercase hex HMAC-SHA256 (string)
 */
export function computeLazadaSignature(appSecret, apiPath, parameters) {
  return createHmac("sha256", appSecret).update(buildLazadaBaseString(apiPath, parameters), "utf8").digest("hex").toUpperCase();
}

/**
 * Turns business parameter values into the strings Lazada receives: objects and arrays as JSON, the rest as text;
 * undefined and null are dropped.
 *
 * @param parameters - Business parameters (object)
 * @returns String values (object)
 *
 * @example
 * stringifyParameters({ order_ids: [1, 2], limit: 10, status: undefined }); // { order_ids: "[1,2]", limit: "10" }
 */
export function stringifyParameters(parameters) {
  const entries = Object.entries(parameters ?? {})
    .filter(([, parameterValue]) => parameterValue !== undefined && parameterValue !== null)
    .map(([parameterName, parameterValue]) => [parameterName, typeof parameterValue === "object" ? JSON.stringify(parameterValue) : String(parameterValue)]);
  return Object.fromEntries(entries);
}
