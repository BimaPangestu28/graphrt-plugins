/**
 * Google credentials for a declarative REST plugin: adapts the shared Google auth files (google-auth.mjs,
 * google-token-endpoint.mjs, service-account.mjs, copied byte for byte from google-sheets) to the layer's `custom`
 * auth. Errors are mapped declaratively by createGoogleErrors (google-sheets' google-errors.mjs is not needed).
 *
 * Credentials, in order: a node's `access_token`; the refresh trio GOOGLE_REFRESH_TOKEN + GOOGLE_CLIENT_ID +
 * GOOGLE_CLIENT_SECRET; GOOGLE_SERVICE_ACCOUNT_JSON (key file path); GOOGLE_ACCESS_TOKEN. The custom auth hook has
 * no "refresh after 401" step, so a configured grant is preferred over a static GOOGLE_ACCESS_TOKEN (whose expiry is
 * unknown) instead of only taking over after a 401 as in google-sheets. Grant tokens are cached in module scope
 * until a minute before they expire. Every access token is returned as a secret, so it is redacted everywhere.
 */
import { createAccessTokenSource, GOOGLE_AUTH_ENV, resolveGoogleCredentials } from "./google-auth.mjs";

export const GOOGLE_ACCESS_TOKEN_ENV = "GOOGLE_ACCESS_TOKEN";
export { GOOGLE_AUTH_ENV };

/**
 * Builds the `auth` spec for defineRestPlugin.
 *
 * @param scope - Space-separated OAuth scopes for the service account grant (string)
 * @returns `{type: "custom", env, authorize}` (object)
 *
 * @example
 * defineRestPlugin({ ..., auth: createGoogleAuth("https://www.googleapis.com/auth/gmail.modify") });
 */
export function createGoogleAuth(scope) {
  return {
    type: "custom",
    env: GOOGLE_ACCESS_TOKEN_ENV,
    authorize: async ({ headers, credential, environment }) => {
      const credentials = credential ? { staticToken: credential } : preferGrant(resolveGoogleCredentials({ environment }));
      const accessToken = await createAccessTokenSource(credentials, { scope }).getAccessToken();
      headers.authorization = `Bearer ${accessToken}`;
      return [accessToken];
    },
  };
}

function preferGrant(credentials) {
  return credentials.grant ? { grant: credentials.grant } : credentials;
}

/**
 * The definition's `resolveAccessToken`: checks that some Google credential is configured, and passes only a
 * node's `access_token` on (env credentials are read when each request is signed).
 *
 * @param options - `{environment, nodeToken}` (object)
 * @returns The node token, or null (string | null)
 * @throws PluginError kind `auth_error` - When no Google credential is configured
 */
export function resolveGoogleNodeToken({ environment, nodeToken }) {
  resolveGoogleCredentials({ environment, nodeToken });
  return nodeToken ?? null;
}

/**
 * Google error mapping for the layer. Google bodies are `{error: {code, message, status?, errors?: [{reason}]}}`;
 * older APIs (Gmail, Drive) put the useful code in `errors[0].reason` (e.g. userRateLimitExceeded on a 403),
 * newer ones (Docs) in `status`.
 *
 * @param codePath - "error.errors.0.reason" or "error.status" (string)
 * @returns `errors` spec (object)
 */
export function createGoogleErrors(codePath) {
  return {
    messagePath: "error.message",
    codePath,
    kindByCode: {
      PERMISSION_DENIED: "permission_denied",
      insufficientPermissions: "permission_denied",
      insufficientFilePermissions: "permission_denied",
      forbidden: "permission_denied",
      accessNotConfigured: "permission_denied",
      SERVICE_DISABLED: "permission_denied",
      NOT_FOUND: "not_found",
      notFound: "not_found",
      INVALID_ARGUMENT: "invalid_input",
      FAILED_PRECONDITION: "invalid_input",
      OUT_OF_RANGE: "invalid_input",
      ALREADY_EXISTS: "invalid_input",
      invalidArgument: "invalid_input",
      badRequest: "invalid_input",
      failedPrecondition: "invalid_input",
      UNAUTHENTICATED: "auth_error",
      authError: "auth_error",
      RESOURCE_EXHAUSTED: "rate_limited",
      rateLimitExceeded: "rate_limited",
      userRateLimitExceeded: "rate_limited",
    },
  };
}

/**
 * Adds the Google credential resolver and env to a definition made by defineRestPlugin.
 *
 * @param definition - Plugin definition (object)
 * @returns Definition that accepts any of the Google credentials (object)
 */
export function withGoogleCredentials(definition) {
  return { ...definition, resolveAccessToken: resolveGoogleNodeToken, extraEnv: [...new Set([...GOOGLE_AUTH_ENV, ...definition.extraEnv])] };
}
