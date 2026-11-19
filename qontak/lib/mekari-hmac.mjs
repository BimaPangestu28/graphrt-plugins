/**
 * Mekari API HMAC request signing (https://developers.mekari.com/docs/kb/hmac-authentication), which Qontak uses on
 * the api.mekari.com gateway (/qontak/chat/v1/..., /qontak/crm/...).
 *
 * The signed text is the Date header and the HTTP request line:
 *   "date: <RFC 7231 date>\n<METHOD> <path>?<query> HTTP/1.1"
 * signed with HMAC-SHA256 under the application's client secret, base64-encoded, and sent as
 *   Authorization: hmac username="<client id>", algorithm="hmac-sha256", headers="date request-line", signature="<b64>"
 * The gateway accepts a clock skew of up to 300 s. Requests with a body also send
 *   Digest: SHA-256=<base64 of the SHA-256 of the exact body bytes>
 * as Mekari's HMAC page requires (gateways that do not validate the body ignore it).
 *
 * The query is signed exactly as sent (percent-encoded), the way Kong's hmac-auth plugin rebuilds the request line;
 * Mekari's qontak-api-js SDK signs a URL-decoded query instead. The two agree for queries without encoded
 * characters. Signing has not been verified against the live gateway with real credentials.
 */
import { createHash, createHmac } from "node:crypto";

/**
 * The request line that is signed: method, path with query (exactly as sent), protocol.
 *
 * @param method - HTTP method (string)
 * @param url - Full request URL (string)
 * @returns e.g. "GET /qontak/crm/contacts?page=1 HTTP/1.1" (string)
 *
 * @example
 * buildRequestLine("get", "https://api.mekari.com/qontak/chat/v1/rooms?limit=5"); // "GET /qontak/chat/v1/rooms?limit=5 HTTP/1.1"
 */
export function buildRequestLine(method, url) {
  const parsedUrl = new URL(url);
  return `${method.toUpperCase()} ${parsedUrl.pathname}${parsedUrl.search} HTTP/1.1`;
}

/**
 * Signs one request.
 *
 * @param request - `{method, url, clientId, clientSecret, date, body?}`; date is a Date, body the exact string sent (object)
 * @returns `{date, authorization, signature, digest?}` header values; digest only when a string body is given (object)
 *
 * @example
 * signMekariRequest({ method: "GET", url, clientId: "fake-client", clientSecret: "fake-secret", date: new Date() });
 */
export function signMekariRequest({ method, url, clientId, clientSecret, date, body }) {
  const dateHeader = date.toUTCString();
  const signingText = `date: ${dateHeader}\n${buildRequestLine(method, url)}`;
  const signature = createHmac("sha256", clientSecret).update(signingText).digest("base64");
  const authorization = `hmac username="${clientId}", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`;
  const digest = typeof body === "string" ? buildBodyDigest(body) : undefined;
  return { date: dateHeader, authorization, signature, ...(digest ? { digest } : {}) };
}

/**
 * The Digest header value of a request body.
 *
 * @param body - Exact body string (string)
 * @returns "SHA-256=<base64>" (string)
 *
 * @example
 * buildBodyDigest('{"to_name":"Budi"}'); // "SHA-256=OiC3RW0PcmP04h1uNG2TxfedyRO6IQfETEcFcGPR0Go="
 */
export function buildBodyDigest(body) {
  return `SHA-256=${createHash("sha256").update(body, "utf8").digest("base64")}`;
}
