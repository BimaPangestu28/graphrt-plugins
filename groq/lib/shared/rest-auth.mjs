/**
 * Credential handling for declarative REST plugins (rest-plugin.mjs).
 *
 * Auth types: `none`, `bearer {env}`, `header {header, env, prefix?}`, `query {param, env}`,
 * `basic {userEnv, passwordEnv}` / `basic {tokenEnv, user}` / `basic {tokenEnv, password}`,
 * `oauth2 {grant, tokenUrl, clientIdEnv, clientSecretEnv, refreshTokenEnv?, scope?, audience?, clientAuth?}` and
 * `custom {authorize, env?}`, where authorize runs after the URL and body are final so it can sign them.
 * Every credential is returned to the shared client as a secret, so it is redacted from error messages and
 * responses.
 */
import { PluginError } from "./graphrt-plugin.mjs";
import { createOAuthTokenSource, listOAuthEnv } from "./rest-oauth.mjs";

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
  if (auth.type === "oauth2") return { tokenEnv: auth.clientSecretEnv, extraEnv: listOAuthEnv(auth).filter((envName) => envName !== auth.clientSecretEnv) };
  return { tokenEnv: auth.env, extraEnv: [] };
}

/**
 * Builds the definition's `resolveAccessToken`: a node's `access_token` wins, otherwise the trimmed env value.
 * For oauth2 it only checks that the client envs are set and returns null (the token comes from the token URL).
 *
 * @param auth - Auth spec (object)
 * @returns `({environment, nodeToken}) => credential | null` (function)
 * @throws PluginError kind `auth_error` - When a required env var is missing (named in the message)
 */
export function createCredentialResolver(auth) {
  const { tokenEnv } = describeAuthEnv(auth);
  return ({ environment, nodeToken }) => {
    if (nodeToken) return nodeToken;
    if (auth.type === "oauth2") {
      for (const envName of listOAuthEnv(auth)) requireEnv(environment, envName);
      return null;
    }
    if (auth.type === "basic" && auth.userEnv) requireEnv(environment, auth.userEnv);
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
 * Creates the shared client's credential hooks for one run.
 *
 * @param auth - Auth spec (object)
 * @param credential - Credential from createCredentialResolver; for oauth2 a node token or null (string | null)
 * @param environment - Environment variables (object)
 * @param fetchImpl - fetch implementation, for the OAuth token request (function)
 * @returns `{authorize?, signRequest?, refreshCredentials?}` for createApiClient (object)
 */
export function createAuthHooks(auth, credential, environment, fetchImpl) {
  if (auth.type === "none") return {};
  if (auth.type === "custom") return { signRequest: createCustomSigner(auth, credential, environment) };
  if (auth.type === "oauth2" && !credential) return createOAuthHooks(auth, environment, fetchImpl);
  if (auth.type === "oauth2") return { authorize: createAuthorizer({ type: "bearer" }, credential, environment) };
  return { authorize: createAuthorizer(auth, credential, environment) };
}

function createCustomSigner(auth, credential, environment) {
  const credentialSecrets = credential ? [credential, encodeURIComponent(credential)] : [];
  return async ({ method, url, headers, body }) => {
    const query = Object.fromEntries(new URL(url).searchParams);
    const signingSecrets = await auth.authorize({ method, url, headers, query, body, credential, environment });
    return [...credentialSecrets, ...(Array.isArray(signingSecrets) ? signingSecrets : [])];
  };
}

function createOAuthHooks(auth, environment, fetchImpl) {
  const tokenSource = createOAuthTokenSource(auth, environment, fetchImpl);
  return {
    authorize: async ({ headers }) => {
      headers.authorization = `Bearer ${await tokenSource.getAccessToken()}`;
      return tokenSource.listSecrets();
    },
    refreshCredentials: () => tokenSource.refresh(),
  };
}

/**
 * Creates the shared client's `authorize` hook for one static credential.
 *
 * @param auth - Auth spec of type bearer, header, query or basic (object)
 * @param credential - Credential from createCredentialResolver (string | null)
 * @param environment - Environment variables (object)
 * @returns `({headers, query}) => secrets[]` (function)
 */
export function createAuthorizer(auth, credential, environment) {
  const credentialSecrets = credential ? [credential, encodeURIComponent(credential)] : [];
  const authorizers = {
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
