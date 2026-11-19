/**
 * Google service account authentication (OAuth 2.0 JWT-bearer grant).
 *
 * Reads the JSON key file named by GOOGLE_SERVICE_ACCOUNT_JSON, signs a
 * short-lived RS256 JWT with `node:crypto` and exchanges it at Google's token
 * endpoint. The private key never leaves this module: it is not logged, not
 * put in error messages and not returned. The key file's own `token_uri` is
 * ignored, so the signed assertion is only ever sent to oauth2.googleapis.com.
 */
import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { GOOGLE_TOKEN_URL, requestGoogleAccessToken } from "./google-token-endpoint.mjs";

const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
// Google accepts at most one hour between iat and exp.
const ASSERTION_LIFETIME_SECONDS = 3600;

/**
 * Reads and checks a service account key file.
 *
 * @param keyFilePath - Path from GOOGLE_SERVICE_ACCOUNT_JSON (string)
 * @param readFileImpl - `(path, encoding) => Promise<string>` (function, default fs.readFile)
 * @returns `{clientEmail, privateKeyId, privateKey}`; privateKey is a KeyObject (Promise<object>)
 * @throws PluginError kind `auth_error` - When the file is unreadable, not JSON, or not a service account key
 */
export async function readServiceAccountKey(keyFilePath, readFileImpl = readFile) {
  const keyFileText = await readKeyFileText(keyFilePath, readFileImpl);
  let keyFile;
  try {
    keyFile = JSON.parse(keyFileText);
  } catch {
    // The parser's message can quote the file's content, i.e. the private key: never include it.
    throw rejectKeyFile(keyFilePath, "is not valid JSON");
  }
  if (keyFile?.type !== undefined && keyFile.type !== "service_account") {
    throw rejectKeyFile(keyFilePath, `has type "${String(keyFile.type)}"; a service account key has type "service_account"`);
  }
  if (typeof keyFile?.client_email !== "string" || !keyFile.client_email.includes("@")) throw rejectKeyFile(keyFilePath, "has no client_email");
  if (typeof keyFile?.private_key !== "string" || keyFile.private_key === "") throw rejectKeyFile(keyFilePath, "has no private_key");
  return {
    clientEmail: keyFile.client_email,
    privateKeyId: typeof keyFile.private_key_id === "string" ? keyFile.private_key_id : undefined,
    privateKey: parsePrivateKey(keyFile.private_key, keyFilePath),
  };
}

async function readKeyFileText(keyFilePath, readFileImpl) {
  try {
    return await readFileImpl(keyFilePath, "utf8");
  } catch (readError) {
    throw rejectKeyFile(keyFilePath, `cannot be read (${readError?.code ?? "read error"})`);
  }
}

function parsePrivateKey(privateKeyPem, keyFilePath) {
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== "rsa") throw new Error("not RSA");
    return privateKey;
  } catch {
    throw rejectKeyFile(keyFilePath, "has a private_key that is not a PEM RSA private key");
  }
}

function rejectKeyFile(keyFilePath, problem) {
  return new PluginError(`The service account key file GOOGLE_SERVICE_ACCOUNT_JSON (${keyFilePath}) ${problem}`, { kind: "auth_error" });
}

/**
 * Builds the signed JWT assertion for the token request.
 *
 * @param serviceAccountKey - Result of readServiceAccountKey (object)
 * @param scope - Space-separated OAuth scopes (string)
 * @param nowMs - Current time in ms (number, default Date.now())
 * @returns Compact JWS `header.claims.signature` (string)
 *
 * @example
 * buildServiceAccountAssertion(key, "https://www.googleapis.com/auth/spreadsheets");
 */
export function buildServiceAccountAssertion(serviceAccountKey, scope, nowMs = Date.now()) {
  const issuedAtSeconds = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(serviceAccountKey.privateKeyId ? { kid: serviceAccountKey.privateKeyId } : {}) };
  const claims = {
    iss: serviceAccountKey.clientEmail,
    scope,
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + ASSERTION_LIFETIME_SECONDS,
  };
  const signingInput = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(claims))}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), serviceAccountKey.privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function encodeBase64Url(text) {
  return Buffer.from(text, "utf8").toString("base64url");
}

/**
 * Reads the key file, signs an assertion and exchanges it for an access token.
 *
 * @param serviceAccountGrant - `{keyFilePath, scope}` (object)
 * @param dependencies - `{fetchImpl, readFileImpl}`, both optional (object)
 * @returns `{accessToken, expiresAtMs}` (Promise<object>)
 * @throws PluginError kinds `auth_error` (bad key file, rejected assertion), `rate_limited`, `api_error`, `network_error`
 */
export async function fetchAccessTokenWithServiceAccount(serviceAccountGrant, { fetchImpl, readFileImpl } = {}) {
  const serviceAccountKey = await readServiceAccountKey(serviceAccountGrant.keyFilePath, readFileImpl);
  const assertion = buildServiceAccountAssertion(serviceAccountKey, serviceAccountGrant.scope);
  const form = { grant_type: JWT_BEARER_GRANT_TYPE, assertion };
  return requestGoogleAccessToken({ form, secrets: [assertion], flowName: `service account token request for ${serviceAccountKey.clientEmail}` }, fetchImpl);
}

