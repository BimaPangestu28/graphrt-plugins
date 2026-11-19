/**
 * s3 configuration from the environment: credentials, region, endpoint and addressing style, local directories
 * and size/time limits. Every value is validated here, so a bad env var fails before any request is sent.
 */
import { isAbsolute } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const TOOL_WRITES_VARIABLE = "S3_TOOL_ALLOW_WRITES";
export const DOWNLOAD_DIR_VARIABLE = "S3_DOWNLOAD_DIR";
export const UPLOAD_DIR_VARIABLE = "S3_UPLOAD_DIR";
export const CREDENTIAL_VARIABLES = ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_SESSION_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
export const SETTING_VARIABLES = [
  "S3_REGION",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "S3_ENDPOINT",
  "S3_FORCE_PATH_STYLE",
  DOWNLOAD_DIR_VARIABLE,
  UPLOAD_DIR_VARIABLE,
  "S3_MAX_DOWNLOAD_BYTES",
  "S3_MAX_UPLOAD_BYTES",
  "S3_MAX_TEXT_BYTES",
  "S3_TIMEOUT_MS",
  "S3_TRANSFER_TIMEOUT_MS",
  "S3_ALLOWED_BUCKETS",
  "S3_EXPECTED_BUCKET_OWNER",
  TOOL_WRITES_VARIABLE,
];
const MEBIBYTE = 1024 * 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NUMBER_LIMITS = {
  S3_MAX_DOWNLOAD_BYTES: { fallback: 100 * MEBIBYTE, min: 1, max: 5 * 1024 * MEBIBYTE },
  S3_MAX_UPLOAD_BYTES: { fallback: 100 * MEBIBYTE, min: 1, max: 1024 * MEBIBYTE },
  S3_MAX_TEXT_BYTES: { fallback: MEBIBYTE, min: 1, max: 8 * MEBIBYTE },
  S3_TIMEOUT_MS: { fallback: 30000, min: 1000, max: 120000 },
  S3_TRANSFER_TIMEOUT_MS: { fallback: 300000, min: 1000, max: 340000 },
};

/**
 * Picks the AWS credentials: a node's `access_token` (`ACCESS_KEY_ID:SECRET[:SESSION_TOKEN]`), else the
 * S3_* variables (for R2, MinIO and other S3-compatible stores), else the standard AWS_* variables.
 *
 * @param inputs - `{environment, nodeToken}` from the runner (object)
 * @returns `{accessKeyId, secretAccessKey, sessionToken?}` (object)
 * @throws PluginError kind `auth_error` - When no complete key pair is configured (values are never echoed)
 */
export function resolveCredentials({ environment, nodeToken }) {
  if (nodeToken) return parseNodeCredentials(nodeToken);
  for (const prefix of ["S3", "AWS"]) {
    const accessKeyId = readVariable(environment, `${prefix}_ACCESS_KEY_ID`);
    const secretAccessKey = readVariable(environment, `${prefix}_SECRET_ACCESS_KEY`);
    if (!accessKeyId && !secretAccessKey) continue;
    if (!accessKeyId || !secretAccessKey) {
      throw new PluginError(`Incomplete credentials: set both ${prefix}_ACCESS_KEY_ID and ${prefix}_SECRET_ACCESS_KEY`, { kind: "auth_error" });
    }
    return { accessKeyId, secretAccessKey, sessionToken: readVariable(environment, `${prefix}_SESSION_TOKEN`) };
  }
  throw new PluginError(
    "No credentials: set S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, optional *_SESSION_TOKEN) and allow them in permissions.env",
    { kind: "auth_error" },
  );
}

function parseNodeCredentials(nodeToken) {
  const [accessKeyId, secretAccessKey, sessionToken, ...extraParts] = nodeToken.split(":");
  if (!accessKeyId || !secretAccessKey || extraParts.length > 0) {
    throw new PluginError("A node's access_token must be ACCESS_KEY_ID:SECRET_ACCESS_KEY or ACCESS_KEY_ID:SECRET_ACCESS_KEY:SESSION_TOKEN", { kind: "auth_error" });
  }
  return { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined };
}

/**
 * Reads and validates every non-credential setting.
 *
 * @param environment - Environment variables (object)
 * @returns `{region, endpoint, isCustomEndpoint, forcePathStyle, downloadDirectory, uploadDirectory, maxDownloadBytes,
 *   maxUploadBytes, maxTextBytes, timeoutMs, transferTimeoutMs, allowToolWrites, allowedBuckets, expectedBucketOwner}`; allowedBuckets
 *   is a Set (agent tools only) or null (object)
 * @throws PluginError kind `invalid_input` - When a value is malformed (the message names the variable)
 */
export function resolveSettings(environment) {
  const region = readVariable(environment, "S3_REGION") ?? readVariable(environment, "AWS_REGION") ?? readVariable(environment, "AWS_DEFAULT_REGION") ?? "us-east-1";
  if (!/^[a-z0-9-]{1,40}$/.test(region)) throw invalidSetting("S3_REGION", "must look like us-east-1 (or auto for Cloudflare R2)");
  const customEndpoint = readVariable(environment, "S3_ENDPOINT");
  const endpoint = customEndpoint ? parseEndpoint(customEndpoint) : `https://s3.${region}.amazonaws.com`;
  return {
    region,
    endpoint,
    isCustomEndpoint: Boolean(customEndpoint),
    forcePathStyle: readPathStyle(environment, Boolean(customEndpoint)),
    downloadDirectory: readDirectory(environment, DOWNLOAD_DIR_VARIABLE),
    uploadDirectory: readDirectory(environment, UPLOAD_DIR_VARIABLE),
    maxDownloadBytes: readNumber(environment, "S3_MAX_DOWNLOAD_BYTES"),
    maxUploadBytes: readNumber(environment, "S3_MAX_UPLOAD_BYTES"),
    maxTextBytes: readNumber(environment, "S3_MAX_TEXT_BYTES"),
    timeoutMs: readNumber(environment, "S3_TIMEOUT_MS"),
    transferTimeoutMs: readNumber(environment, "S3_TRANSFER_TIMEOUT_MS"),
    allowToolWrites: environment?.[TOOL_WRITES_VARIABLE] === "1",
    allowedBuckets: readAllowedBuckets(environment),
    expectedBucketOwner: readExpectedBucketOwner(environment),
  };
}

// https only, except plain http to this machine (MinIO in development). No path, query or credentials in the URL.
function parseEndpoint(rawEndpoint) {
  let endpointUrl;
  try {
    endpointUrl = new URL(rawEndpoint);
  } catch {
    throw invalidSetting("S3_ENDPOINT", "is not a URL");
  }
  const isLocalHttp = endpointUrl.protocol === "http:" && LOCAL_HOSTS.has(endpointUrl.hostname);
  if (endpointUrl.protocol !== "https:" && !isLocalHttp) throw invalidSetting("S3_ENDPOINT", "must be https (http only for localhost)");
  if (endpointUrl.username || endpointUrl.password) throw invalidSetting("S3_ENDPOINT", "must not contain credentials");
  if (endpointUrl.pathname !== "/" || endpointUrl.search || endpointUrl.hash) throw invalidSetting("S3_ENDPOINT", "must be an origin like https://<account>.r2.cloudflarestorage.com, without a path");
  return endpointUrl.origin;
}

// Comma-separated bucket names agent tools may touch; unset means no extra limit.
function readAllowedBuckets(environment) {
  const rawValue = readVariable(environment, "S3_ALLOWED_BUCKETS");
  if (rawValue === undefined) return null;
  return new Set(rawValue.split(",").map((bucket) => bucket.trim()).filter(Boolean));
}

function readExpectedBucketOwner(environment) {
  const accountId = readVariable(environment, "S3_EXPECTED_BUCKET_OWNER");
  if (accountId !== undefined && !/^\d{12}$/.test(accountId)) throw invalidSetting("S3_EXPECTED_BUCKET_OWNER", "must be a 12-digit AWS account id");
  return accountId;
}

function readPathStyle(environment, isCustomEndpoint) {
  const rawValue = readVariable(environment, "S3_FORCE_PATH_STYLE");
  if (rawValue === undefined) return isCustomEndpoint;
  if (/^(1|true)$/i.test(rawValue)) return true;
  if (/^(0|false)$/i.test(rawValue)) return false;
  throw invalidSetting("S3_FORCE_PATH_STYLE", "must be 1/true or 0/false");
}

function readDirectory(environment, variableName) {
  const directory = readVariable(environment, variableName);
  if (directory !== undefined && !isAbsolute(directory)) throw invalidSetting(variableName, "must be an absolute directory path");
  return directory;
}

function readNumber(environment, variableName) {
  const { fallback, min, max } = NUMBER_LIMITS[variableName];
  const rawValue = readVariable(environment, variableName);
  if (rawValue === undefined) return fallback;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < min || value > max) throw invalidSetting(variableName, `must be an integer from ${min} to ${max}`);
  return value;
}

function readVariable(environment, variableName) {
  const value = environment?.[variableName];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function invalidSetting(variableName, problem) {
  return new PluginError(`${variableName} ${problem}`, { kind: "invalid_input" });
}
