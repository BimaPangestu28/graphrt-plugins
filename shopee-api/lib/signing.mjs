/**
 * Shopee Open Platform v2 request signing (pure functions, no I/O).
 *
 * Documented algorithm ("API calls" > "Signature calculation"):
 *   base string = partner_id + api path + timestamp [+ access_token + shop_id]   (shop APIs add the last two)
 *   sign        = hex(HMAC-SHA256(key = partner_key, message = base string))
 * The path is the request path without host or query, e.g. "/api/v2/shop/get_shop_info".
 */
import { createHmac } from "node:crypto";

/**
 * Builds the string Shopee signs.
 *
 * @param signingInput - Signed elements (object)
 * @param signingInput.partnerId - App partner id (string | number)
 * @param signingInput.path - API path without host or query (string)
 * @param signingInput.timestamp - Unix time in seconds (number | string)
 * @param signingInput.accessToken - Shop access token; omit for public APIs (string, optional)
 * @param signingInput.shopId - Shop id; omit for public APIs (string | number, optional)
 * @returns Base string (string)
 *
 * @example
 * buildShopeeBaseString({ partnerId: 2001887, path: "/api/v2/public/get_shops_by_partner", timestamp: 1655714431 });
 * // "2001887/api/v2/public/get_shops_by_partner1655714431"
 */
export function buildShopeeBaseString({ partnerId, path, timestamp, accessToken = "", shopId = "" }) {
  return `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
}

/**
 * Signs a base string with the partner key.
 *
 * @param baseString - Output of buildShopeeBaseString (string)
 * @param partnerKey - App partner key (string)
 * @returns Lowercase hex HMAC-SHA256 (string)
 */
export function signShopeeBaseString(baseString, partnerKey) {
  return createHmac("sha256", Buffer.from(partnerKey, "utf8")).update(Buffer.from(baseString, "utf8")).digest("hex");
}

/**
 * Computes the `sign` query parameter for one request.
 *
 * @param signingInput - buildShopeeBaseString input plus `partnerKey` (object)
 * @returns Lowercase hex signature (string)
 */
export function computeShopeeSignature({ partnerKey, ...baseStringInput }) {
  return signShopeeBaseString(buildShopeeBaseString(baseStringInput), partnerKey);
}
