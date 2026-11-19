/**
 * Google Ads credentials: the shared Google OAuth auth (google-rest-auth.mjs, scope `adwords`) plus the Google Ads
 * headers read from the environment:
 *   - `developer-token` from GOOGLE_ADS_DEVELOPER_TOKEN, when set. Google sunset developer tokens on 2026-09-09
 *     (API access levels now belong to the Google Cloud project) and ignores the header, but older setups and
 *     versions still send it, so it stays optional. It is a secret and is redacted.
 *   - `login-customer-id` from GOOGLE_ADS_LOGIN_CUSTOMER_ID (the manager account to act through), digits only;
 *     dashes as shown in the Google Ads UI (123-456-7890) are removed.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { createGoogleAuth } from "./google-rest-auth.mjs";

export const ADWORDS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const GOOGLE_ADS_AUTH_ENV = ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_LOGIN_CUSTOMER_ID"];
const DEVELOPER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Normalizes a Google Ads customer id: "123-456-7890" and " 1234567890 " become "1234567890".
 *
 * @param customerId - Customer id as typed (any)
 * @returns The digits when the value is a customer id with optional dashes, otherwise the value unchanged (any)
 *
 * @example
 * normalizeCustomerId("123-456-7890"); // "1234567890"
 */
export function normalizeCustomerId(customerId) {
  if (typeof customerId !== "string" && typeof customerId !== "number") return customerId;
  const text = String(customerId).trim();
  return /^\d{3}-?\d{3}-?\d{4}$/.test(text) || /^\d+$/.test(text) ? text.replaceAll("-", "") : customerId;
}

/**
 * Builds the `auth` spec: Google OAuth bearer token plus the Google Ads headers.
 *
 * @returns `{type: "custom", env, authorize}` (object)
 * @throws PluginError kind `invalid_input` (when signing) - GOOGLE_ADS_LOGIN_CUSTOMER_ID or the developer token is malformed
 */
export function createGoogleAdsAuth() {
  const googleAuth = createGoogleAuth(ADWORDS_SCOPE);
  return {
    ...googleAuth,
    authorize: async (requestContext) => {
      const secrets = await googleAuth.authorize(requestContext);
      const developerToken = readDeveloperToken(requestContext.environment);
      const loginCustomerId = readLoginCustomerId(requestContext.environment);
      if (developerToken) requestContext.headers["developer-token"] = developerToken;
      if (loginCustomerId) requestContext.headers["login-customer-id"] = loginCustomerId;
      return developerToken ? [...secrets, developerToken] : secrets;
    },
  };
}

function readDeveloperToken(environment) {
  const developerToken = environment?.GOOGLE_ADS_DEVELOPER_TOKEN?.trim();
  if (!developerToken) return undefined;
  if (!DEVELOPER_TOKEN_PATTERN.test(developerToken)) throw new PluginError("GOOGLE_ADS_DEVELOPER_TOKEN must be letters, digits, _ or -", { kind: "invalid_input" });
  return developerToken;
}

function readLoginCustomerId(environment) {
  const rawValue = environment?.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim();
  if (!rawValue) return undefined;
  const loginCustomerId = normalizeCustomerId(rawValue);
  if (!/^\d{10}$/.test(loginCustomerId)) throw new PluginError("GOOGLE_ADS_LOGIN_CUSTOMER_ID must be a 10-digit customer id, e.g. 1234567890 or 123-456-7890", { kind: "invalid_input" });
  return loginCustomerId;
}
