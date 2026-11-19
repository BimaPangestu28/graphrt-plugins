/**
 * Snowflake key-pair authentication for the SQL API: an RS256 JWT signed with the user's RSA private key
 * (node:crypto only).
 *
 * Claims (Snowflake "Using key-pair authentication"):
 *   iss = <ACCOUNT>.<USER>.SHA256:<base64 SHA-256 of the public key's DER SubjectPublicKeyInfo>
 *   sub = <ACCOUNT>.<USER>
 *   iat = now, exp = now + 59 minutes (Snowflake accepts at most one hour)
 * ACCOUNT and USER are uppercase. ACCOUNT is the account identifier without region or cloud: "MYORG-MYACCOUNT"
 * for the organization form, or the bare locator "XY12345" for "xy12345.us-east-2.aws". The API host keeps the
 * full identifier, lowercase, with "_" replaced by "-" (underscores are not valid in host names).
 *
 * The private key is read once per run, never logged and never put in an error message.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const JWT_LIFETIME_SECONDS = 3540;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;

/**
 * Derives the JWT account name and the API host from SNOWFLAKE_ACCOUNT.
 *
 * @param rawAccount - Account identifier ("myorg-myaccount", "xy12345.us-east-2.aws") or its https URL (string)
 * @returns `{jwtAccount, host}` (object)
 * @throws PluginError kind `invalid_input` - When the identifier has characters an account cannot have
 *
 * @example
 * resolveAccountIdentifiers("xy12345.us-east-2.aws"); // { jwtAccount: "XY12345", host: "xy12345.us-east-2.aws.snowflakecomputing.com" }
 */
export function resolveAccountIdentifiers(rawAccount) {
  const account = String(rawAccount ?? "").trim().replace(/^https:\/\//i, "").replace(/\/$/, "").replace(/\.snowflakecomputing\.com$/i, "");
  if (!ACCOUNT_PATTERN.test(account) || account.length > 255) {
    throw new PluginError("SNOWFLAKE_ACCOUNT must be an account identifier such as myorg-myaccount or xy12345.us-east-2.aws", { kind: "invalid_input" });
  }
  return { jwtAccount: account.split(".")[0].toUpperCase(), host: `${account.toLowerCase().replace(/_/g, "-")}.snowflakecomputing.com` };
}

/**
 * Computes the public key fingerprint Snowflake stores as RSA_PUBLIC_KEY_FP.
 *
 * @param privateKey - RSA private key (KeyObject)
 * @returns "SHA256:<base64>" (string)
 */
export function computePublicKeyFingerprint(privateKey) {
  const publicKeyDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(publicKeyDer).digest("base64")}`;
}

/**
 * Builds the signed JWT.
 *
 * @param options - `{privateKey, jwtAccount, user, nowMs?}` (object)
 * @returns Compact JWS (string)
 */
export function buildKeyPairJwt({ privateKey, jwtAccount, user, nowMs = Date.now() }) {
  const qualifiedUser = `${jwtAccount}.${String(user).toUpperCase()}`;
  const issuedAtSeconds = Math.floor(nowMs / 1000);
  const claims = { iss: `${qualifiedUser}.${computePublicKeyFingerprint(privateKey)}`, sub: qualifiedUser, iat: issuedAtSeconds, exp: issuedAtSeconds + JWT_LIFETIME_SECONDS };
  const signingInput = `${encodeSegment({ alg: "RS256", typ: "JWT" })}.${encodeSegment(claims)}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

function encodeSegment(json) {
  return Buffer.from(JSON.stringify(json), "utf8").toString("base64url");
}

/**
 * Loads the private key from SNOWFLAKE_PRIVATE_KEY (PEM text) or SNOWFLAKE_PRIVATE_KEY_PATH (PEM file), decrypting it
 * with SNOWFLAKE_PRIVATE_KEY_PASSPHRASE when given.
 *
 * @param keySource - `{pemText?, keyPath?, passphrase?}` (object)
 * @param readFileImpl - `(path, encoding) => Promise<string>` (function, default fs.readFile)
 * @returns RSA private key (Promise<KeyObject>)
 * @throws PluginError kind `auth_error` - Missing, unreadable, encrypted without passphrase, or not an RSA key
 */
export async function loadPrivateKey({ pemText, keyPath, passphrase }, readFileImpl = readFile) {
  if (!pemText && !keyPath) throw new PluginError("No private key: set SNOWFLAKE_PRIVATE_KEY_PATH (or SNOWFLAKE_PRIVATE_KEY) and allow it in permissions.env", { kind: "auth_error" });
  const keyText = pemText ?? (await readKeyFile(keyPath, readFileImpl));
  try {
    const privateKey = createPrivateKey({ key: keyText.replace(/\\n/g, "\n"), format: "pem", passphrase });
    if (privateKey.asymmetricKeyType !== "rsa") throw new Error("not RSA");
    return privateKey;
  } catch {
    // The parser's message can quote key material: never include it.
    throw new PluginError("The Snowflake private key is not a PEM RSA private key, or it is encrypted and SNOWFLAKE_PRIVATE_KEY_PASSPHRASE is missing or wrong", { kind: "auth_error" });
  }
}

async function readKeyFile(keyPath, readFileImpl) {
  try {
    return await readFileImpl(keyPath, "utf8");
  } catch (readError) {
    throw new PluginError(`SNOWFLAKE_PRIVATE_KEY_PATH (${keyPath}) cannot be read (${readError?.code ?? "read error"})`, { kind: "auth_error" });
  }
}
