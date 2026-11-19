/**
 * YouTube Data API v3 client for captions: Bearer auth from the copied
 * youtube-api OAuth module (static token or refresh trio), Google error
 * mapping, and a size-capped caption download.
 *
 * Missing credentials are reported when a request is made, not when the
 * client is built, so `parse_captions` works without any credentials.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { createAccessTokenSource, resolveYouTubeCredentials } from "./oauth.mjs";

export const YOUTUBE_BASE_URL = "https://www.googleapis.com/youtube/v3";
const DAILY_QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded"]);
export const MAX_CAPTION_BYTES_VARIABLE = "YOUTUBE_TRANSCRIPT_MAX_CAPTION_BYTES";
const DEFAULT_MAX_CAPTION_BYTES = 5 * 1024 * 1024;
const REASON_KINDS = { rateLimitExceeded: "rate_limited", userRateLimitExceeded: "rate_limited", forbidden: "permission_denied", insufficientPermissions: "permission_denied", authorizationRequired: "auth_error" };

/**
 * The plugin's `resolveAccessToken` hook: credentials, or the missing-credentials error to raise later.
 *
 * @param inputs - `{environment, nodeToken}` (object)
 * @returns Credentials from resolveYouTubeCredentials, or `{missingCredentialsError}` (object)
 */
export function resolveCredentialsLazily(inputs) {
  try {
    return resolveYouTubeCredentials(inputs);
  } catch (credentialsError) {
    return { missingCredentialsError: credentialsError };
  }
}

/**
 * Creates the client for one call.
 *
 * @param options - `{accessToken: credentials, environment, fetchImpl}` from the runner (object)
 * @returns `{settings, request, downloadCaption}` (object)
 * @throws PluginError kind `invalid_input` - When YOUTUBE_TRANSCRIPT_MAX_CAPTION_BYTES is invalid
 */
export function createCaptionsClient({ accessToken: credentials, environment, fetchImpl }) {
  const settings = { maxCaptionBytes: readMaxCaptionBytes(environment) };
  const tokenSource = credentials.missingCredentialsError ? null : createAccessTokenSource(credentials, fetchImpl);
  const apiClient = createApiClient({
    baseUrl: YOUTUBE_BASE_URL,
    authorize: async ({ headers }) => {
      if (!tokenSource) throw credentials.missingCredentialsError;
      headers.authorization = `Bearer ${await tokenSource.getAccessToken()}`;
    },
    refreshCredentials: () => (tokenSource ? tokenSource.refreshAccessToken() : false),
    parseError: parseYouTubeError,
    fetchImpl,
  });
  return {
    settings,
    request: apiClient.request,
    downloadCaption: (requestOptions) => downloadCaption(apiClient, settings.maxCaptionBytes, requestOptions),
  };
}

function readMaxCaptionBytes(environment) {
  const rawValue = String(environment?.[MAX_CAPTION_BYTES_VARIABLE] ?? "").trim();
  if (rawValue === "") return DEFAULT_MAX_CAPTION_BYTES;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 65536 || value > 64 * 1024 * 1024) {
    throw new PluginError(`${MAX_CAPTION_BYTES_VARIABLE} must be an integer from 65536 to 67108864`, { kind: "invalid_input" });
  }
  return value;
}

async function downloadCaption(apiClient, maxCaptionBytes, { path, query, signal }) {
  const { response } = await apiClient.requestWithHeaders({ path, query, signal, rawResponse: true });
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > maxCaptionBytes) throw tooLarge(maxCaptionBytes);
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body ?? []) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxCaptionBytes) {
      await response.body.cancel?.().catch(() => {});
      throw tooLarge(maxCaptionBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function tooLarge(maxCaptionBytes) {
  return new PluginError(`The caption file is larger than ${maxCaptionBytes} bytes (${MAX_CAPTION_BYTES_VARIABLE})`, { kind: "api_error" });
}

/**
 * Maps a Google API error body (`{error: {message, errors: [{reason}]}}`) to a message and kind.
 * Same mapping as youtube-api's client, plus a scope hint for insufficientPermissions. The hint for refused
 * caption downloads is added by get_transcript, the only place it applies.
 *
 * @param status - HTTP status (number)
 * @param body - Parsed response body (object)
 * @returns `{message, kind, retryable?}`, or `{}` for non-Google bodies (object)
 */
export function parseYouTubeError(status, body) {
  const googleError = body?.error;
  if (!googleError || typeof googleError !== "object") return {};
  const reason = googleError.errors?.[0]?.reason;
  const message = reason ? `${googleError.message} (reason ${reason})` : googleError.message;
  if (DAILY_QUOTA_REASONS.has(reason)) {
    return { message: `${message}. The YouTube quota resets daily at midnight Pacific Time.`, kind: "rate_limited", retryable: false };
  }
  if (reason === "insufficientPermissions") {
    return { message: `${message}. The token needs the https://www.googleapis.com/auth/youtube.force-ssl scope.`, kind: "permission_denied" };
  }
  return { message, kind: REASON_KINDS[reason] ?? (/notFound$/i.test(reason ?? "") ? "not_found" : undefined) };
}
