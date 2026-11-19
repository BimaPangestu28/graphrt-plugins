/**
 * Maps Google API error bodies to PluginError kinds.
 *
 * Google APIs answer `{error: {code, message, status, details: [{reason}], errors: [{reason}]}}`
 * where `status` is the canonical gRPC code (UNAUTHENTICATED, PERMISSION_DENIED, ...).
 */

const STATUS_KINDS = {
  UNAUTHENTICATED: "auth_error",
  PERMISSION_DENIED: "permission_denied",
  NOT_FOUND: "not_found",
  INVALID_ARGUMENT: "invalid_input",
  FAILED_PRECONDITION: "invalid_input",
  OUT_OF_RANGE: "invalid_input",
  ALREADY_EXISTS: "invalid_input",
  RESOURCE_EXHAUSTED: "rate_limited",
};
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"]);
const DISABLED_API_REASONS = new Set(["SERVICE_DISABLED", "accessNotConfigured", "API_DISABLED"]);

/**
 * Parses a Google error body.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind}` or `{}` for non-Google bodies (object)
 *
 * @example
 * parseGoogleError(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission" } });
 * // { message: "The caller does not have permission (PERMISSION_DENIED)", kind: "permission_denied" }
 */
export function parseGoogleError(status, body) {
  const googleError = body?.error;
  if (!googleError || typeof googleError !== "object") return {};
  const reason = readReason(googleError);
  const label = [googleError.status, reason].filter(Boolean).join(", ");
  const baseMessage = googleError.message ?? "Google API error";
  const message = label ? `${baseMessage} (${label})` : baseMessage;
  if (DISABLED_API_REASONS.has(reason)) {
    return { message: `${message}. Enable the API in the Google Cloud project that owns the credentials.`, kind: "permission_denied" };
  }
  return { message, kind: kindFor(status, googleError.status, reason) };
}

function readReason(googleError) {
  const detailReason = Array.isArray(googleError.details) ? googleError.details.find((detail) => typeof detail?.reason === "string")?.reason : undefined;
  return detailReason ?? googleError.errors?.[0]?.reason;
}

function kindFor(httpStatus, grpcStatus, reason) {
  if (RATE_LIMIT_REASONS.has(reason) || httpStatus === 429) return "rate_limited";
  return STATUS_KINDS[grpcStatus];
}
