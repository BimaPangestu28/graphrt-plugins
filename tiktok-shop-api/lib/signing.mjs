/**
 * TikTok Shop Partner API request signing (pure functions, no I/O).
 *
 * Documented algorithm ("Sign your API request"):
 *   1. take the query parameters except `sign` and `access_token`, keys sorted alphabetically;
 *   2. concatenate them as {key}{value};
 *   3. prepend the request path;
 *   4. append the exact request body unless the request is multipart/form-data;
 *   5. wrap with the app secret: secret + string + secret;
 *   6. sign = hex(HMAC-SHA256(key = app secret, message = wrapped string)).
 * The access token travels in the `x-tts-access-token` header and is not signed.
 */
import { createHmac } from "node:crypto";

const EXCLUDED_KEYS = new Set(["sign", "access_token"]);

/**
 * Builds the string that is wrapped with the secret and signed (steps 1-4).
 *
 * @param signingInput - Request parts (object)
 * @param signingInput.path - Request path without host or query (string)
 * @param signingInput.query - Query parameters with string values as sent (object)
 * @param signingInput.body - Exact JSON body as sent; omit for GET and multipart requests (string, optional)
 * @returns String to sign (string)
 *
 * @example
 * buildTiktokShopStringToSign({ path: "/authorization/202309/shops", query: { app_key: "29a39d", timestamp: "1623812664" } });
 * // "/authorization/202309/shopsapp_key29a39dtimestamp1623812664"
 */
export function buildTiktokShopStringToSign({ path, query = {}, body = "" }) {
  const signedKeys = Object.keys(query)
    .filter((key) => !EXCLUDED_KEYS.has(key) && query[key] !== undefined && query[key] !== null)
    .sort();
  const parameterString = signedKeys.map((key) => `${key}${query[key]}`).join("");
  return `${path}${parameterString}${body ?? ""}`;
}

/**
 * Computes the `sign` query parameter for one request (steps 1-6).
 *
 * @param signingInput - buildTiktokShopStringToSign input plus `appSecret` (object)
 * @returns Lowercase hex HMAC-SHA256 (string)
 */
export function signTiktokShopRequest({ appSecret, ...stringToSignInput }) {
  const wrappedString = `${appSecret}${buildTiktokShopStringToSign(stringToSignInput)}${appSecret}`;
  return createHmac("sha256", Buffer.from(appSecret, "utf8")).update(Buffer.from(wrappedString, "utf8")).digest("hex");
}
