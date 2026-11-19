/**
 * Copied from microsoft-graph/lib/graph-errors.mjs (keep the two in step).
 *
 * Microsoft Graph error mapping: errors are `{"error": {"code": "...", "message": "...", "innerError": {...}}}`
 * (https://learn.microsoft.com/en-us/graph/errors). 429 and 503 carry a Retry-After header, which the shared
 * client honours.
 */
export const GRAPH_ERRORS = {
  messagePath: "error.message",
  codePath: "error.code",
  // auth_error codes are listed last: an auth_error makes the OAuth client refresh and retry once, so the generated
  // contract test checks the mapping with the first code (a kind that is not retried).
  kindByCode: {
    Authorization_RequestDenied: "permission_denied",
    AccessDenied: "permission_denied",
    ErrorAccessDenied: "permission_denied",
    Forbidden: "permission_denied",
    accessDenied: "permission_denied",
    NotFound: "not_found",
    ItemNotFound: "not_found",
    itemNotFound: "not_found",
    ResourceNotFound: "not_found",
    ErrorItemNotFound: "not_found",
    Request_ResourceNotFound: "not_found",
    BadRequest: "invalid_input",
    InvalidRequest: "invalid_input",
    invalidRequest: "invalid_input",
    ErrorInvalidRecipients: "invalid_input",
    ErrorInvalidIdMalformed: "invalid_input",
    TooManyRequests: "rate_limited",
    ErrorTooManyRequests: "rate_limited",
    activityLimitReached: "rate_limited",
    InvalidAuthenticationToken: "auth_error",
    CompactToken_ParsingFailed: "auth_error",
    unauthenticated: "auth_error",
  },
};
