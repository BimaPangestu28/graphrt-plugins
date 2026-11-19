/**
 * DynamoDB JSON 1.0 client: every action is `POST /` with `X-Amz-Target: DynamoDB_20120810.<Action>`, signed with
 * SigV4 (lib/aws-sigv4.mjs) through the shared api-client's `signRequest` hook.
 *
 * Reads are marked idempotent (retried after 5xx and network errors); writes are not, so their unknown-outcome
 * errors say so. Throttling (400 ProvisionedThroughputExceededException, ThrottlingException) is `rate_limited` and
 * retried for every action: DynamoDB applied nothing.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { hashPayload, signRequestHeaders } from "./aws-sigv4.mjs";
import { resolveSettings } from "./settings.mjs";

const TARGET_PREFIX = "DynamoDB_20120810";
const KIND_BY_ERROR_CODE = {
  UnrecognizedClientException: "auth_error",
  InvalidSignatureException: "auth_error",
  MissingAuthenticationTokenException: "auth_error",
  IncompleteSignatureException: "auth_error",
  ExpiredTokenException: "auth_error",
  InvalidClientTokenId: "auth_error",
  AccessDeniedException: "permission_denied",
  ResourceNotFoundException: "not_found",
  ProvisionedThroughputExceededException: "rate_limited",
  ThrottlingException: "rate_limited",
  RequestLimitExceeded: "rate_limited",
  LimitExceededException: "rate_limited",
  ConditionalCheckFailedException: "invalid_input",
  ValidationException: "invalid_input",
  SerializationException: "invalid_input",
  ItemCollectionSizeLimitExceededException: "invalid_input",
};

/**
 * Maps a DynamoDB error body (`{__type: "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException", message}`).
 *
 * @param status - HTTP status (number)
 * @param body - Parsed body (object)
 * @returns `{message, kind?}` for the shared client (object)
 *
 * @example
 * parseDynamoError(400, { __type: "com.amazon.coral.service#UnrecognizedClientException", message: "bad token" });
 * // { message: "UnrecognizedClientException: bad token", kind: "auth_error" }
 */
export function parseDynamoError(status, body) {
  const errorType = typeof body?.__type === "string" ? body.__type.slice(body.__type.lastIndexOf("#") + 1) : undefined;
  const detail = body?.message ?? body?.Message;
  if (!errorType) return {};
  const message = detail ? `${errorType}: ${detail}` : errorType;
  return { message, kind: KIND_BY_ERROR_CODE[errorType] ?? (status >= 500 ? "api_error" : undefined) };
}

/**
 * Creates the client the operations receive.
 *
 * @param runnerInputs - `{accessToken, environment, fetchImpl}`; accessToken is the result of resolveCredentials (object)
 * @param dependencies - `{now, retryBaseDelayMs}`, for tests (object, optional)
 * @returns `{settings, call(action, payload, {signal, isRead}) => Promise<object>, unprocessedRetryDelayMs}` (object)
 */
export function createDynamoClient({ accessToken: credentials, environment, fetchImpl }, dependencies = {}) {
  const settings = resolveSettings(environment);
  const now = dependencies.now ?? (() => new Date());
  const apiClient = createApiClient({
    baseUrl: settings.endpoint,
    defaultHeaders: { "content-type": "application/x-amz-json-1.0" },
    signRequest: ({ method, url, headers, body }) => {
      Object.assign(headers, signRequestHeaders({ method, url, headers, payloadHash: hashPayload(body), credentials, region: settings.region, service: "dynamodb", now: now() }));
      return [credentials.secretAccessKey, credentials.sessionToken].filter(Boolean);
    },
    parseError: parseDynamoError,
    timeoutMs: settings.timeoutMs,
    retryBaseDelayMs: dependencies.retryBaseDelayMs,
    fetchImpl,
  });
  const call = (action, payload, { signal, isRead }) =>
    apiClient.request({ method: "POST", path: "/", headers: { "x-amz-target": `${TARGET_PREFIX}.${action}` }, body: JSON.stringify(payload), signal, idempotent: isRead, redactResponse: true });
  return { settings, call, unprocessedRetryDelayMs: dependencies.retryBaseDelayMs ?? 200 };
}
