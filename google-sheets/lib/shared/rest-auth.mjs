/**
 * Credential handling for declarative REST plugins (rest-plugin.mjs).
 *
 * Auth types: `none`, `bearer {env}`, `header {header, env, prefix?}`, `query {param, env}`,
 * `basic {userEnv, passwordEnv}` / `basic {tokenEnv, user}` / `basic {tokenEnv, password}`, and
 * `custom {authorize, env?}`. Every credential is returned to the shared client as a secret, so it is
 * redacted from error messages and from `api_request` responses.
 */
import { PluginError } from "./graphrt-plugin.mjs";

/**
 * Names the env vars an auth spec reads.
 *
 * @param auth - Auth spec (object)
 * @returns `{tokenEnv, extraEnv}`: the credential env (undefined for none) and other envs (object)
 */
export function describeAuthEnv(auth) {
  if (auth.type === "basic") {
    return auth.passwordEnv ? { tokenEnv: auth.passwordEnv, extraEnv: [auth.userEnv] } : { tokenEnv: auth.tokenEnv, extraEnv: [] };
  }
  return { tokenEnv: auth.env, extraEnv: [] };
}

/**
 * Builds the definition's `resolveAccessToken`: a node's `access_token` wins, otherwise the trimmed env value.
 *
 * @param auth - Auth spec (object)
 * @returns `({environment, nodeToken}) => credential` (function)
 * @throws PluginError kind `auth_error` - When a required env var is missing (named in the message)
 */
export function createCredentialResolver(auth) {
  const { tokenEnv } = describeAuthEnv(auth);
  return ({ environment, nodeToken }) => {
    if (auth.type === "basic" && auth.userEnv) requireEnv(environment, auth.userEnv);
    if (nodeToken) return nodeToken;
    if (!tokenEnv) return null;
    return requireEnv(environment, tokenEnv);
  };
}

function requireEnv(environment, envName) {
  const value = typeof environment?.[envName] === "string" ? environment[envName].trim() : "";
  if (value === "") {
    throw new PluginError(`No credential: set the ${envName} environment variable (and allow it in permissions.env)`, { kind: "auth_error" });
  }
  return value;
}

/**
 * Creates the shared client's `authorize` hook for one credential.
 *
 * @param auth - Auth spec (object)
 * @param credential - Credential from createCredentialResolver (string | null)
 * @param environment - Environment variables (object)
 * @returns `({headers, query}) => secrets[]` (function)
 */
export function createAuthorizer(auth, credential, environment) {
  const credentialSecrets = credential ? [credential, encodeURIComponent(credential)] : [];
  const authorizers = {
    none: () => [],
    bearer: ({ headers }) => {
      headers.authorization = `Bearer ${credential}`;
      return credentialSecrets;
    },
    header: ({ headers }) => {
      headers[auth.header.toLowerCase()] = `${auth.prefix ?? ""}${credential}`;
      return credentialSecrets;
    },
    query: ({ query }) => {
      query[auth.param] = credential;
      return credentialSecrets;
    },
    basic: ({ headers }) => authorizeBasic(auth, credential, environment, headers),
    custom: async ({ headers, query }) => [...credentialSecrets, ...((await auth.authorize({ headers, query, credential, environment })) ?? [])],
  };
  return authorizers[auth.type];
}

function authorizeBasic(auth, credential, environment, headers) {
  const [user, password] = auth.userEnv
    ? [environment[auth.userEnv].trim(), credential]
    : typeof auth.user === "string"
      ? [auth.user, credential]
      : [credential, auth.password];
  const encoded = Buffer.from(`${user}:${password}`).toString("base64");
  headers.authorization = `Basic ${encoded}`;
  return [encoded, credential, encodeURIComponent(credential)];
}
