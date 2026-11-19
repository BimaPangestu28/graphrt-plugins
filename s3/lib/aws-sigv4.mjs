/**
 * AWS Signature Version 4 (AWS4-HMAC-SHA256): header signing and presigned URLs.
 *
 * Pure functions over node:crypto, with no other imports, so the s3 and dynamodb plugins carry byte-identical
 * copies of this file (their tests check that). Verified against the official AWS SigV4 test suite and the
 * worked examples in the Amazon S3 documentation (see test/aws-sigv4.test.mjs).
 *
 * Path encoding (`pathEncoding`):
 *   - "s3": the URL path is used exactly as sent; the caller must already have URI-encoded each key segment
 *     (S3 signs the encoded path once and never normalizes it).
 *   - "double" (every other service): the path as sent is URI-encoded once more, as the AWS SDKs do.
 * The URL is read as a raw string (never re-parsed with WHATWG URL), so what is signed is what is sent.
 *
 * Secrets: the secret access key only feeds the HMAC chain and is never returned. The session token is a
 * header (or query parameter) value by design; callers must redact it, together with the secret, from errors.
 */
import { createHash, createHmac } from "node:crypto";

export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const MAX_PRESIGN_SECONDS = 604800;
const ALGORITHM = "AWS4-HMAC-SHA256";
const SCOPE_PART_PATTERN = /^[a-z0-9-]+$/;
const RAW_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i;

/**
 * Hex SHA-256 of a request body.
 *
 * @param body - Body as sent; undefined or null for none (string | Buffer | Uint8Array | undefined)
 * @returns Lowercase hex digest (string)
 *
 * @example
 * hashPayload(""); // EMPTY_PAYLOAD_SHA256
 */
export function hashPayload(body) {
  return createHash("sha256").update(body ?? "").digest("hex");
}

/**
 * URI-encodes a string the SigV4 way: everything except A-Z a-z 0-9 - _ . ~ is percent-encoded (UTF-8, uppercase).
 *
 * @param text - Text to encode (string)
 * @param encodeSlash - Whether "/" is encoded too (boolean)
 * @returns Encoded text (string)
 *
 * @example
 * uriEncode("a b/c", false); // "a%20b/c"
 */
export function uriEncode(text, encodeSlash) {
  let encoded = "";
  for (const character of String(text)) {
    if (/^[A-Za-z0-9\-_.~]$/.test(character) || (character === "/" && !encodeSlash)) {
      encoded += character;
      continue;
    }
    for (const byte of Buffer.from(character, "utf8")) encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/**
 * Derives the SigV4 signing key: HMAC chain over date, region, service and "aws4_request".
 *
 * @param secretAccessKey - AWS secret access key (string)
 * @param dateStamp - YYYYMMDD (string)
 * @param region - e.g. "us-east-1" (string)
 * @param service - e.g. "s3" (string)
 * @returns The signing key (Buffer)
 */
export function deriveSigningKey(secretAccessKey, dateStamp, region, service) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

/**
 * Builds the canonical request for a URL and headers.
 *
 * @param request - Request description (object)
 * @param request.method - HTTP method (string)
 * @param request.url - Absolute URL exactly as it will be sent (string)
 * @param request.headers - Headers to sign, any case; must include host (object)
 * @param request.payloadHash - Hex SHA-256 of the body, or UNSIGNED_PAYLOAD (string)
 * @param request.pathEncoding - "s3" or "double" (string, default "double")
 * @returns `{canonicalRequest, signedHeaderNames}` (object)
 */
export function buildCanonicalRequest({ method, url, headers, payloadHash, pathEncoding = "double" }) {
  const { path, query } = splitRawUrl(url);
  const canonicalHeaders = canonicalizeHeaders(headers);
  const signedHeaderNames = canonicalHeaders.map(([headerName]) => headerName).join(";");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalizePath(path, pathEncoding),
    canonicalizeQuery(query),
    canonicalHeaders.map(([headerName, headerValue]) => `${headerName}:${headerValue}\n`).join(""),
    signedHeaderNames,
    payloadHash,
  ].join("\n");
  return { canonicalRequest, signedHeaderNames };
}

/**
 * Signs a request with an Authorization header.
 *
 * @param request - Request to sign (object)
 * @param request.method - HTTP method (string)
 * @param request.url - Absolute URL exactly as it will be sent (string)
 * @param request.headers - Headers that will be sent and signed (object, not modified)
 * @param request.payloadHash - From hashPayload, or UNSIGNED_PAYLOAD (string)
 * @param request.credentials - `{accessKeyId, secretAccessKey, sessionToken?}` (object)
 * @param request.region - Signing region (string)
 * @param request.service - Signing service name, e.g. "s3", "dynamodb" (string)
 * @param request.now - Signing time (Date, default now)
 * @param request.pathEncoding - "s3" or "double" (string, default "double")
 * @param request.includeContentSha256Header - Also send and sign x-amz-content-sha256 (S3 requires it) (boolean)
 * @returns Headers to add: `authorization`, `x-amz-date`, and `x-amz-security-token` / `x-amz-content-sha256` when used (object)
 * @throws Error - When credentials, region or service are missing or malformed
 *
 * @example
 * Object.assign(headers, signRequestHeaders({ method: "GET", url, headers, payloadHash: EMPTY_PAYLOAD_SHA256, credentials, region: "us-east-1", service: "s3", pathEncoding: "s3", includeContentSha256Header: true }));
 */
export function signRequestHeaders(request) {
  assertSigningInputs(request);
  const amzDate = formatAmzDate(request.now ?? new Date());
  const addedHeaders = { "x-amz-date": amzDate };
  if (request.credentials.sessionToken) addedHeaders["x-amz-security-token"] = request.credentials.sessionToken;
  if (request.includeContentSha256Header) addedHeaders["x-amz-content-sha256"] = request.payloadHash;
  const headersToSign = { ...withHostHeader(request.headers, request.url), ...addedHeaders };
  const { canonicalRequest, signedHeaderNames } = buildCanonicalRequest({ ...request, headers: headersToSign });
  const credentialScope = buildCredentialScope(amzDate, request.region, request.service);
  const signature = signCanonicalRequest(canonicalRequest, amzDate, credentialScope, request);
  addedHeaders.authorization = `${ALGORITHM} Credential=${request.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;
  return addedHeaders;
}

/**
 * Builds a presigned URL (query-string authentication; only the host header is signed).
 *
 * @param request - `{method, url, payloadHash, credentials, region, service, now?, pathEncoding?, expiresInSeconds}` (object)
 * @returns The URL with X-Amz-* parameters and X-Amz-Signature (string)
 * @throws Error - When inputs are invalid or expiresInSeconds is outside 1..604800
 *
 * @example
 * presignUrl({ method: "GET", url, payloadHash: UNSIGNED_PAYLOAD, credentials, region, service: "s3", pathEncoding: "s3", expiresInSeconds: 900 });
 */
export function presignUrl(request) {
  assertSigningInputs(request);
  const expiresInSeconds = request.expiresInSeconds;
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_PRESIGN_SECONDS) {
    throw new Error(`Presigned URLs expire after 1 to ${MAX_PRESIGN_SECONDS} seconds`);
  }
  const amzDate = formatAmzDate(request.now ?? new Date());
  const credentialScope = buildCredentialScope(amzDate, request.region, request.service);
  const authQuery = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${request.credentials.accessKeyId}/${credentialScope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresInSeconds)],
    ...(request.credentials.sessionToken ? [["X-Amz-Security-Token", request.credentials.sessionToken]] : []),
    ["X-Amz-SignedHeaders", "host"],
  ];
  const { origin, path, query } = splitRawUrl(request.url);
  const fullQuery = [query, ...authQuery.map(([name, value]) => `${uriEncode(name, true)}=${uriEncode(value, true)}`)].filter(Boolean).join("&");
  const unsignedUrl = `${origin}${path || "/"}?${fullQuery}`;
  const { canonicalRequest } = buildCanonicalRequest({ ...request, url: unsignedUrl, headers: withHostHeader({}, request.url) });
  const signature = signCanonicalRequest(canonicalRequest, amzDate, credentialScope, request);
  return `${origin}${path || "/"}?${canonicalizeQuery(fullQuery)}&X-Amz-Signature=${signature}`;
}

function signCanonicalRequest(canonicalRequest, amzDate, credentialScope, { credentials, region, service }) {
  const stringToSign = [ALGORITHM, amzDate, credentialScope, hashPayload(canonicalRequest)].join("\n");
  const signingKey = deriveSigningKey(credentials.secretAccessKey, amzDate.slice(0, 8), region, service);
  return createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
}

function assertSigningInputs({ credentials, region, service }) {
  if (typeof credentials?.accessKeyId !== "string" || credentials.accessKeyId === "") throw new Error("SigV4 signing needs an access key id");
  if (typeof credentials.secretAccessKey !== "string" || credentials.secretAccessKey === "") throw new Error("SigV4 signing needs a secret access key");
  if (!SCOPE_PART_PATTERN.test(region ?? "")) throw new Error(`Invalid SigV4 region ${JSON.stringify(region)}`);
  if (!SCOPE_PART_PATTERN.test(service ?? "")) throw new Error(`Invalid SigV4 service ${JSON.stringify(service)}`);
}

function buildCredentialScope(amzDate, region, service) {
  return `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function hmac(key, text) {
  return createHmac("sha256", key).update(text, "utf8").digest();
}

function splitRawUrl(url) {
  const match = RAW_URL_PATTERN.exec(String(url));
  if (!match) throw new Error("SigV4 signing needs an absolute URL");
  const scheme = String(url).slice(0, String(url).indexOf(":"));
  return { origin: `${scheme}://${match[1]}`, authority: match[1].toLowerCase(), path: match[2], query: match[3] ?? "" };
}

function withHostHeader(headers, url) {
  const hasHost = Object.keys(headers ?? {}).some((headerName) => headerName.toLowerCase() === "host");
  return hasHost ? { ...headers } : { ...headers, host: stripDefaultPort(splitRawUrl(url)) };
}

function stripDefaultPort({ origin, authority }) {
  const isDefaultPort = (origin.startsWith("https:") && authority.endsWith(":443")) || (origin.startsWith("http:") && authority.endsWith(":80"));
  return isDefaultPort ? authority.replace(/:\d+$/, "") : authority;
}

function canonicalizePath(path, pathEncoding) {
  const nonEmptyPath = path === "" ? "/" : path;
  if (pathEncoding === "s3") return nonEmptyPath;
  return uriEncode(nonEmptyPath, false);
}

function canonicalizeQuery(rawQuery) {
  if (!rawQuery) return "";
  const encodedPairs = rawQuery
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const separatorIndex = pair.indexOf("=");
      const [rawName, rawValue] = separatorIndex === -1 ? [pair, ""] : [pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1)];
      return [uriEncode(decodeComponent(rawName), true), uriEncode(decodeComponent(rawValue), true)];
    });
  encodedPairs.sort(([nameA, valueA], [nameB, valueB]) => compareCodeUnits(nameA, nameB) || compareCodeUnits(valueA, valueB));
  return encodedPairs.map(([name, value]) => `${name}=${value}`).join("&");
}

function decodeComponent(component) {
  try {
    return decodeURIComponent(component);
  } catch {
    return component;
  }
}

function compareCodeUnits(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function canonicalizeHeaders(headers) {
  const canonicalEntries = Object.entries(headers ?? {})
    .filter(([, headerValue]) => headerValue !== undefined && headerValue !== null)
    .map(([headerName, headerValue]) => [headerName.toLowerCase(), String(headerValue).trim().replace(/\s+/g, " ")]);
  return canonicalEntries.sort(([nameA], [nameB]) => compareCodeUnits(nameA, nameB));
}
