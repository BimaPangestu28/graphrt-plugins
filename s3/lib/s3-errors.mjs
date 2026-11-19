/**
 * Maps S3 error responses (`<Error><Code>..</Code><Message>..</Message></Error>`) and statuses to PluginError
 * kinds. HEAD responses have no body, so only the status is known for them.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { childText, parseXml } from "./xml.mjs";

const KIND_BY_CODE = {
  InvalidAccessKeyId: "auth_error",
  SignatureDoesNotMatch: "auth_error",
  ExpiredToken: "auth_error",
  InvalidToken: "auth_error",
  TokenRefreshRequired: "auth_error",
  MissingSecurityHeader: "auth_error",
  AccessDenied: "permission_denied",
  AllAccessDisabled: "permission_denied",
  AccountProblem: "permission_denied",
  NoSuchBucket: "not_found",
  NoSuchKey: "not_found",
  NoSuchVersion: "not_found",
  RequestTimeTooSkewed: "auth_error",
  SlowDown: "rate_limited",
  RequestLimitExceeded: "rate_limited",
  TooManyRequests: "rate_limited",
  ServiceUnavailable: "rate_limited",
};
const KIND_BY_STATUS = { 400: "invalid_input", 401: "auth_error", 403: "permission_denied", 404: "not_found", 409: "invalid_input", 411: "invalid_input", 412: "invalid_input", 416: "invalid_input", 429: "rate_limited", 503: "rate_limited" };

/**
 * Reads the code and message of an S3 XML error body.
 *
 * @param bodyText - Response body (string)
 * @returns `{code, message, region}`; fields are undefined when the body is not an S3 error (object)
 */
export function readS3ErrorBody(bodyText) {
  if (!bodyText || !bodyText.trimStart().startsWith("<")) return {};
  try {
    const root = parseXml(bodyText);
    if (root.name !== "Error") return {};
    return { code: childText(root, "Code"), message: childText(root, "Message"), region: childText(root, "Region") };
  } catch {
    // Not XML after all (an HTML proxy page, say): the status alone decides the kind.
    return {};
  }
}

/**
 * Builds the PluginError for a failed S3 response.
 *
 * @param details - `{status, method, bodyText, regionHeader, isIdempotent, redact}` (object)
 * @returns PluginError with kind, retryable and a redacted message (PluginError)
 *
 * @example
 * buildS3Error({ status: 404, method: "GET", bodyText: "<Error><Code>NoSuchKey</Code></Error>", redact: (text) => text });
 */
export function buildS3Error({ status, method, bodyText, regionHeader, isIdempotent = true, redact = (text) => text }) {
  const { code, message, region } = readS3ErrorBody(bodyText);
  const kind = (code && KIND_BY_CODE[code]) ?? KIND_BY_STATUS[status] ?? (status >= 300 && status < 400 ? "invalid_input" : "api_error");
  const isTransient = kind === "rate_limited" || status >= 500;
  const detail = [code, message].filter(Boolean).join(": ") || describeStatusOnly(status, method);
  const regionHint = code === "RequestTimeTooSkewed" ? ". This machine's clock is off by more than 15 minutes: sync it (NTP) and retry" : describeRegionHint(status, region ?? regionHeader);
  const outcomeNote = isTransient && !isIdempotent ? " (outcome unknown: the write may have been applied; check before retrying)" : "";
  return new PluginError(redact(`S3 error ${status}: ${detail}${regionHint}${outcomeNote}`), { kind, retryable: isTransient && isIdempotent });
}

function describeStatusOnly(status, method) {
  if (method === "HEAD" && status === 403) return "Forbidden (HEAD responses carry no error code: check the credentials and the s3:GetObject permission)";
  if (method === "HEAD" && status === 404) return "Not Found (no such bucket or key)";
  return `HTTP ${status}`;
}

function describeRegionHint(status, region) {
  if (!region || (status !== 301 && status !== 307 && status !== 400)) return "";
  return `. The bucket is in region ${region}: set S3_REGION=${region}`;
}
