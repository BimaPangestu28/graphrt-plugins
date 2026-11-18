import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { clearCachedAccessTokens } from "../lib/google-auth.mjs";
import { pluginDefinition } from "../definition.mjs";

export const TEST_ENVIRONMENT = { GOOGLE_ACCESS_TOKEN: "google-token" };

export const REFRESH_ENVIRONMENT = {
  GOOGLE_REFRESH_TOKEN: "refresh-secret-value",
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "client-secret-value",
};

export const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Runs one operation against canned responses, starting from an empty token cache.
 *
 * @returns `{output, calls}` where calls are the recorded requests
 */
export async function runWithResponses(operationName, args, responses = [{ body: {} }], environment = TEST_ENVIRONMENT, source = "tool") {
  clearCachedAccessTokens();
  return runKeepingTokenCache(operationName, args, responses, environment, source);
}

/**
 * Like runWithResponses but keeps the module-level token cache from earlier runs.
 *
 * @returns `{output, calls}`
 */
export async function runKeepingTokenCache(operationName, args, responses = [{ body: {} }], environment = TEST_ENVIRONMENT, source = "tool") {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const output = await runOperation(operationName, args, { source });
  return { output, calls: recordingFetch.calls };
}

/**
 * Writes a freshly generated service account key file to a temp directory.
 *
 * @param overrides - Fields to replace in the key JSON (object)
 * @returns `{keyFilePath, publicKey, privateKeyPem, clientEmail}`
 */
export function writeTestServiceAccountKey(overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const clientEmail = "robot@test-project.iam.gserviceaccount.com";
  const keyFile = {
    type: "service_account",
    project_id: "test-project",
    private_key_id: "key-id-1",
    private_key: privateKeyPem,
    client_email: clientEmail,
    token_uri: "https://evil.example.com/token",
    ...overrides,
  };
  const keyFilePath = join(mkdtempSync(join(tmpdir(), "google-sa-")), "key.json");
  writeFileSync(keyFilePath, JSON.stringify(keyFile));
  return { keyFilePath, publicKey, privateKeyPem, clientEmail };
}

/**
 * Splits a compact JWS into decoded header, claims, signing input and signature.
 *
 * @param assertion - `header.claims.signature` (string)
 * @returns `{header, claims, signingInput, signature}` (object)
 */
export function decodeAssertion(assertion) {
  const [encodedHeader, encodedClaims, encodedSignature] = assertion.split(".");
  return {
    header: JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")),
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature: Buffer.from(encodedSignature, "base64url"),
    encodedParts: [encodedHeader, encodedClaims, encodedSignature],
  };
}

export const tokenResponse = (accessToken, expiresIn = 3599) => ({ body: { access_token: accessToken, expires_in: expiresIn, token_type: "Bearer" } });
export const unauthorizedResponse = { status: 401, body: { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } } };
export const isAuthError = (error) => error.kind === "auth_error";
export const isInvalidInput = (error) => error.kind === "invalid_input";
