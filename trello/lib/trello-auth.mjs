/**
 * Trello auth: every request carries the API key and a user token. Trello documents an Authorization header for
 * this (https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/):
 * `Authorization: OAuth oauth_consumer_key="<key>", oauth_token="<token>"`. Using the header keeps both out of
 * URLs. The token is TRELLO_TOKEN (or a node's access_token), the key is TRELLO_API_KEY; both are returned as
 * secrets so they are redacted from every error and response.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const TOKEN_ENV = "TRELLO_TOKEN";
export const API_KEY_ENV = "TRELLO_API_KEY";
// Keys are hex and tokens alphanumeric; anything that could break the quoted header (quotes, backslashes,
// commas, whitespace, control characters) is refused.
const SAFE_CREDENTIAL_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Custom auth hook for the declarative layer: sets Trello's OAuth-style Authorization header.
 *
 * @param request - `{headers, credential, environment}` from the declarative layer (object)
 * @returns Secrets to redact: the key and the token (string[])
 * @throws PluginError kind `auth_error` - TRELLO_API_KEY is missing, or the key or token has unsafe characters
 *
 * @example
 * authorizeTrello({ headers, credential: "ATTA...", environment: { TRELLO_API_KEY: "0123..." } });
 */
export function authorizeTrello({ headers, credential, environment }) {
  const apiKey = typeof environment?.[API_KEY_ENV] === "string" ? environment[API_KEY_ENV].trim() : "";
  if (!apiKey) throw new PluginError(`No API key: set the ${API_KEY_ENV} environment variable (and allow it in permissions.env)`, { kind: "auth_error" });
  if (!SAFE_CREDENTIAL_PATTERN.test(apiKey)) throw new PluginError(`${API_KEY_ENV} has characters a Trello key cannot have`, { kind: "auth_error" });
  if (!SAFE_CREDENTIAL_PATTERN.test(String(credential ?? ""))) throw new PluginError(`${TOKEN_ENV} (or access_token) has characters a Trello token cannot have`, { kind: "auth_error" });
  headers.authorization = `OAuth oauth_consumer_key="${apiKey}", oauth_token="${credential}"`;
  return [apiKey, encodeURIComponent(apiKey), credential];
}
