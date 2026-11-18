/**
 * LinkedIn REST API client: base URL, version headers, Bearer auth, LinkedIn
 * error mapping, Rest.li URN encoding and pagination helpers shared by the
 * operation files.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { downloadImage, uploadImageBytes } from "./image-transfer.mjs";

export const DEFAULT_LINKEDIN_VERSION = "202611";
const LINKEDIN_ORIGIN = "https://api.linkedin.com";
export const USERINFO_URL = `${LINKEDIN_ORIGIN}/v2/userinfo`;
const LINKEDIN_VERSION_PATTERN = /^\d{6}$/;
const AUTH_SERVICE_ERROR_CODES = new Set([65600, 65601, 65602, 65603, 65604]);
const PERMISSION_ERROR_CODES = new Set(["ACCESS_DENIED", "UNAUTHORIZED_SCOPE_ERROR"]);
// LinkedIn documents no Retry-After on 429 (daily limits), so the shared backoff applies.
const STATUS_KINDS = { 400: "invalid_input", 401: "auth_error", 403: "permission_denied", 404: "not_found", 422: "invalid_input", 429: "rate_limited" };
const ACTOR_URN_PATTERN = /^urn:li:(person|organization):[^\s]+$/;
const MAX_PAGE_SIZE = 100;

/**
 * Creates a LinkedIn client for the given token.
 *
 * The REST client sends `Linkedin-Version` and `X-Restli-Protocol-Version`; the
 * OpenID userinfo endpoint lives under /v2 on the same origin and is reached
 * through `requestUserinfo` with an absolute URL.
 *
 * @param options - `{accessToken, environment, fetchImpl, resolveHostAddresses?}` (object)
 * @returns `{request, requestWithHeaders, deleteResource, requestUserinfo, downloadImage, uploadImageBytes}` (object)
 * @throws PluginError kind `invalid_input` - When LINKEDIN_VERSION is malformed
 */
export function createLinkedInClient({ accessToken, environment, fetchImpl, resolveHostAddresses }) {
  const linkedInVersion = readLinkedInVersion(environment);
  const buildRestClient = (clientFetch) =>
    createApiClient({
      baseUrl: `${LINKEDIN_ORIGIN}/rest`,
      authorize: ({ headers }) => {
        headers.authorization = `Bearer ${accessToken}`;
      },
      parseError: parseLinkedInError,
      defaultHeaders: { "linkedin-version": linkedInVersion, "x-restli-protocol-version": "2.0.0" },
      fetchImpl: clientFetch,
    });
  const restClient = buildRestClient(fetchImpl);
  const resolvedFetch = fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments));
  return {
    ...restClient,
    deleteResource: (requestOptions) => deleteToleratingRetriedNotFound({ buildRestClient, fetchImpl: resolvedFetch }, requestOptions),
    requestUserinfo: (signal) => restClient.request({ path: USERINFO_URL, signal }),
    downloadImage: (imageUrl, signal) => downloadImage({ fetchImpl: resolvedFetch, imageUrl, signal, resolveHostAddresses }),
    uploadImageBytes: (uploadUrl, imageBytes, signal) => uploadImageBytes({ fetchImpl: resolvedFetch, uploadUrl, accessToken, imageBytes, signal }),
  };
}

/**
 * Sends a Rest.li DELETE that the shared client may retry after a 5xx or network failure. If an earlier attempt may
 * have applied the delete and a retry then gets 404, the resource is gone: report success instead of not_found.
 *
 * @param clientParts - `{buildRestClient, fetchImpl}` (object)
 * @param requestOptions - `{path, query?, signal}` (object)
 * @returns `{alreadyAbsent}` (Promise<object>)
 * @throws PluginError - Any other failure, or a 404 on the first attempt
 */
async function deleteToleratingRetriedNotFound({ buildRestClient, fetchImpl }, requestOptions) {
  let hadUncertainAttempt = false;
  const observingFetch = async (...fetchArguments) => {
    try {
      const fetchResponse = await fetchImpl(...fetchArguments);
      if (fetchResponse.status >= 500) hadUncertainAttempt = true;
      return fetchResponse;
    } catch (transportError) {
      hadUncertainAttempt = true;
      throw transportError;
    }
  };
  const headers = { ...requestOptions.headers, "x-restli-method": "DELETE" };
  try {
    await buildRestClient(observingFetch).request({ ...requestOptions, method: "DELETE", headers });
    return { alreadyAbsent: false };
  } catch (deleteError) {
    if (deleteError instanceof PluginError && deleteError.kind === "not_found" && hadUncertainAttempt) return { alreadyAbsent: true };
    throw deleteError;
  }
}

function readLinkedInVersion(environment) {
  const linkedInVersion = environment?.LINKEDIN_VERSION || DEFAULT_LINKEDIN_VERSION;
  if (!LINKEDIN_VERSION_PATTERN.test(linkedInVersion)) {
    throw new PluginError(`LINKEDIN_VERSION must be YYYYMM, e.g. "${DEFAULT_LINKEDIN_VERSION}", got "${linkedInVersion}"`, { kind: "invalid_input" });
  }
  return linkedInVersion;
}

/**
 * Maps a LinkedIn error body `{status, serviceErrorCode, code, message}` to a message and error kind.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind}` (kind may be undefined to keep the status default) or `{}` for non-LinkedIn bodies
 */
export function parseLinkedInError(status, body) {
  const hasLinkedInShape = body && typeof body.message === "string" && (body.status !== undefined || body.serviceErrorCode !== undefined || body.code);
  if (!hasLinkedInShape) return {};
  const details = [body.serviceErrorCode !== undefined && `serviceErrorCode ${body.serviceErrorCode}`, body.code].filter(Boolean);
  const isVersionError = status === 426 || body.code === "NONEXISTENT_VERSION";
  const hint = isVersionError ? ". Set LINKEDIN_VERSION to an active YYYYMM version (LinkedIn supports roughly the last 12 months)" : "";
  const message = `${body.message}${details.length ? ` (${details.join(", ")})` : ""}${hint}`;
  return { message, kind: kindForLinkedInError(status, body, isVersionError) };
}

function kindForLinkedInError(status, body, isVersionError) {
  if (isVersionError) return "invalid_input";
  if (AUTH_SERVICE_ERROR_CODES.has(Number(body.serviceErrorCode))) return "auth_error";
  if (PERMISSION_ERROR_CODES.has(body.code)) return "permission_denied";
  return STATUS_KINDS[status];
}

/**
 * Percent-encodes a value for a Rest.li 2.0 path or key, including the
 * characters encodeURIComponent leaves alone but Rest.li reserves.
 *
 * @param value - URN or other key (string)
 * @returns Encoded value (string)
 *
 * @example
 * encodeRestliValue("urn:li:comment:(urn:li:activity:1,2)"); // "urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A1%2C2%29"
 */
export function encodeRestliValue(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Validates that a value is a LinkedIn URN (`urn:li:...`).
 *
 * @param urn - Candidate URN (string)
 * @param argumentName - Argument name for the error message (string)
 * @returns The URN (string)
 * @throws PluginError kind `invalid_input` - When it is not a URN
 */
export function requireUrn(urn, argumentName) {
  if (!/^urn:li:[A-Za-z]+:\S+$/.test(urn)) rejectInput(`\`${argumentName}\` must be a LinkedIn URN like "urn:li:share:123", got "${urn}"`);
  return urn;
}

/**
 * Resolves the acting member/organization from the argument or LINKEDIN_AUTHOR_URN, and validates it.
 *
 * @param providedUrn - URN from the arguments (string | undefined)
 * @param environment - Environment variables (object)
 * @param argumentName - Argument name for error messages (string)
 * @returns `urn:li:person:...` or `urn:li:organization:...` (string)
 * @throws PluginError kind `invalid_input` - When missing or not a person/organization URN
 */
export function resolveActorUrn(providedUrn, environment, argumentName) {
  const actorUrn = providedUrn || environment?.LINKEDIN_AUTHOR_URN;
  if (!actorUrn) rejectInput(`Pass \`${argumentName}\` or set the LINKEDIN_AUTHOR_URN environment variable`);
  if (!ACTOR_URN_PATTERN.test(actorUrn)) {
    rejectInput(`\`${argumentName}\` (or LINKEDIN_AUTHOR_URN) must start with urn:li:person: or urn:li:organization:, got "${actorUrn}"`);
  }
  return actorUrn;
}

/**
 * Builds the shared pagination parameters for list operations.
 *
 * @param defaultLimit - Default page size (number)
 * @returns JSON-schema properties `{limit, cursor}` (object)
 */
export function paginationProperties(defaultLimit = 25) {
  return {
    limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, default: defaultLimit, description: "Page size (count)" },
    cursor: { type: "string", description: "next_cursor from a previous call (a start offset)" },
  };
}

/**
 * Converts `limit`/`cursor` arguments into LinkedIn `start`/`count` query parameters.
 *
 * @param args - Validated arguments with `limit` and optional `cursor` (object)
 * @returns `{start, count}` (object)
 * @throws PluginError kind `invalid_input` - When the cursor is not a non-negative integer
 */
export function toPagingQuery(args) {
  const cursorText = args.cursor ?? "0";
  if (!/^\d+$/.test(cursorText)) rejectInput(`\`cursor\` must be a next_cursor value (a start offset), got "${cursorText}"`);
  return { start: Number(cursorText), count: args.limit };
}

/**
 * Converts a LinkedIn collection response into the operation output shape.
 *
 * There is a next page when `paging.links` has rel=next, or when the page is
 * full and `paging.total` (if present) is not yet reached.
 *
 * @param responseBody - `{elements, paging}` from LinkedIn (object)
 * @param pagingQuery - The `{start, count}` that was requested (object)
 * @returns `{data, next_cursor}` where next_cursor is the next start offset or null
 */
export function toPage(responseBody, pagingQuery) {
  const elements = responseBody?.elements ?? [];
  const paging = responseBody?.paging ?? {};
  const nextStart = pagingQuery.start + pagingQuery.count;
  const hasNextLink = Array.isArray(paging.links) && paging.links.some((pageLink) => pageLink?.rel === "next");
  const totalReached = typeof paging.total === "number" && nextStart >= paging.total;
  const hasNextPage = hasNextLink || (elements.length > 0 && elements.length >= pagingQuery.count && !totalReached);
  return { data: elements, next_cursor: hasNextPage ? String(nextStart) : null };
}

/**
 * Throws invalid_input with a message.
 *
 * @param message - What is wrong (string)
 * @throws PluginError kind `invalid_input`
 */
export function rejectInput(message) {
  throw new PluginError(message, { kind: "invalid_input" });
}
