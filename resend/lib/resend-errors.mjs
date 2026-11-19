/**
 * Resend error handling. Errors are `{"statusCode", "name", "message"}` (https://resend.com/docs/api-reference/errors).
 *
 * Resend answers an unknown or deleted API key on every endpoint except sending with
 * `400 {"name": "validation_error", "message": "API key is invalid"}`. `validation_error` also means a bad field,
 * so the declarative mapping cannot tell the two apart by code; `remapInvalidApiKeyError` turns that one message
 * into `auth_error`, and `withInvalidApiKeyAsAuthError` applies it to every operation.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const INVALID_API_KEY_PATTERN = /\bAPI key is invalid\b/i;

export const RESEND_ERRORS = {
  messagePath: "message",
  codePath: "name",
  kindByCode: {
    missing_api_key: "auth_error",
    suspended_api_key: "auth_error",
    restricted_api_key: "permission_denied",
    invalid_permission: "permission_denied",
    not_found: "not_found",
    invalid_idempotency_key: "invalid_input",
    invalid_idempotent_request: "invalid_input",
    invalid_parameter: "invalid_input",
    missing_required_field: "invalid_input",
    rate_limit_exceeded: "rate_limited",
    daily_quota_exceeded: "rate_limited",
    monthly_quota_exceeded: "rate_limited",
  },
  // Another request with the same idempotency key is still running: nothing new was applied.
  retryableCodes: ["concurrent_idempotent_requests"],
};

/**
 * Turns Resend's "API key is invalid" validation error into an auth_error.
 *
 * @param error - Error thrown by an operation (Error)
 * @returns A new PluginError kind `auth_error` for that message, otherwise the same error (Error)
 *
 * @example
 * remapInvalidApiKeyError(new PluginError("API error 400: API key is invalid (validation_error)", { kind: "invalid_input" })).kind; // "auth_error"
 */
export function remapInvalidApiKeyError(error) {
  if (error?.kind !== "invalid_input" || !INVALID_API_KEY_PATTERN.test(error.message ?? "")) return error;
  return new PluginError(error.message, { kind: "auth_error" });
}

/**
 * Wraps an operation so its invalid-key errors are auth errors.
 *
 * @param operation - Operation (object)
 * @returns Operation with the same schema (object)
 */
export function withInvalidApiKeyAsAuthError(operation) {
  return {
    ...operation,
    run: async (context) => {
      try {
        return await operation.run(context);
      } catch (error) {
        throw remapInvalidApiKeyError(error);
      }
    },
  };
}
