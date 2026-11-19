/**
 * LINE answers 409 Conflict when a request carries an X-Line-Retry-Key that it has already accepted
 * (https://developers.line.biz/en/reference/messaging-api/#retry-api-request): the first attempt was delivered,
 * typically after a timeout or 5xx that made the shared client retry with the same key. That is a success for the
 * caller, so this fetch adapter turns such a 409 into a 200 `{already_accepted: true, accepted_request_id, note}`
 * before the client maps statuses. A 409 without a retry key on the request is left alone (a real error).
 */

const RETRY_KEY_HEADER = "x-line-retry-key";
const ACCEPTED_REQUEST_ID_HEADER = "x-line-accepted-request-id";
export const ALREADY_ACCEPTED_NOTE = "LINE had already accepted this request (same X-Line-Retry-Key): already sent; do not resend";

function readRequestHeader(headers, headerName) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(headerName) ?? undefined;
  const matchingName = Object.keys(headers).find((name) => name.toLowerCase() === headerName);
  return matchingName === undefined ? undefined : headers[matchingName];
}

/**
 * Wraps a fetch implementation so a 409 on a retry-keyed request reads as "already accepted".
 *
 * @param fetchImpl - fetch to wrap (function)
 * @returns fetch-compatible function (function)
 *
 * @example
 * const fetchWithRetryKeys = acceptRetryKeyConflicts(globalThis.fetch);
 */
export function acceptRetryKeyConflicts(fetchImpl) {
  return async (url, init) => {
    const response = await fetchImpl(url, init);
    if (response.status !== 409 || !readRequestHeader(init?.headers, RETRY_KEY_HEADER)) return response;
    const acceptedBody = { already_accepted: true, accepted_request_id: response.headers.get(ACCEPTED_REQUEST_ID_HEADER) ?? null, note: ALREADY_ACCEPTED_NOTE };
    return new Response(JSON.stringify(acceptedBody), { status: 200, headers: { "content-type": "application/json" } });
  };
}

/**
 * Gives a plugin definition a client whose fetch accepts retry-key conflicts.
 *
 * @param definition - Plugin definition from defineRestPlugin (object)
 * @returns Definition with a wrapped createClient (object)
 */
export function withRetryKeyConflictsAccepted(definition) {
  return {
    ...definition,
    createClient: (clientOptions) => {
      const fetchImpl = clientOptions.fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments));
      return definition.createClient({ ...clientOptions, fetchImpl: acceptRetryKeyConflicts(fetchImpl) });
    },
  };
}
