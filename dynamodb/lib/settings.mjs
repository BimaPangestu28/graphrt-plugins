/**
 * dynamodb configuration from the environment: credentials, region, endpoint (DynamoDB Local), timeout and the
 * agent write opt-in.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const TOOL_WRITES_VARIABLE = "DYNAMODB_TOOL_ALLOW_WRITES";
export const CREDENTIAL_VARIABLES = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
export const SETTING_VARIABLES = ["DYNAMODB_REGION", "AWS_REGION", "AWS_DEFAULT_REGION", "DYNAMODB_ENDPOINT", "DYNAMODB_TIMEOUT_MS", "DYNAMODB_ALLOWED_TABLES", TOOL_WRITES_VARIABLE];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Picks the AWS credentials: a node's `access_token` (`ACCESS_KEY_ID:SECRET[:SESSION_TOKEN]`), else AWS_* variables.
 *
 * @param inputs - `{environment, nodeToken}` from the runner (object)
 * @returns `{accessKeyId, secretAccessKey, sessionToken?}` (object)
 * @throws PluginError kind `auth_error` - When no complete key pair is configured (values are never echoed)
 */
export function resolveCredentials({ environment, nodeToken }) {
  if (nodeToken) {
    const [accessKeyId, secretAccessKey, sessionToken, ...extraParts] = nodeToken.split(":");
    if (!accessKeyId || !secretAccessKey || extraParts.length > 0) {
      throw new PluginError("A node's access_token must be ACCESS_KEY_ID:SECRET_ACCESS_KEY or ACCESS_KEY_ID:SECRET_ACCESS_KEY:SESSION_TOKEN", { kind: "auth_error" });
    }
    return { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined };
  }
  const accessKeyId = readVariable(environment, "AWS_ACCESS_KEY_ID");
  const secretAccessKey = readVariable(environment, "AWS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new PluginError("No credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (optional AWS_SESSION_TOKEN) and allow them in permissions.env", { kind: "auth_error" });
  }
  return { accessKeyId, secretAccessKey, sessionToken: readVariable(environment, "AWS_SESSION_TOKEN") };
}

/**
 * Reads and validates the non-credential settings.
 *
 * @param environment - Environment variables (object)
 * @returns `{region, endpoint, timeoutMs, allowToolWrites, allowedTables}`; allowedTables is a Set (agent tools only) or null (object)
 * @throws PluginError kind `invalid_input` - When a value is malformed (the message names the variable)
 */
export function resolveSettings(environment) {
  const region = readVariable(environment, "DYNAMODB_REGION") ?? readVariable(environment, "AWS_REGION") ?? readVariable(environment, "AWS_DEFAULT_REGION") ?? "us-east-1";
  if (!/^[a-z0-9-]{1,40}$/.test(region)) throw invalidSetting("DYNAMODB_REGION", "must look like us-east-1");
  const customEndpoint = readVariable(environment, "DYNAMODB_ENDPOINT");
  const rawTimeout = readVariable(environment, "DYNAMODB_TIMEOUT_MS");
  const timeoutMs = rawTimeout === undefined ? 30000 : Number(rawTimeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 100000) throw invalidSetting("DYNAMODB_TIMEOUT_MS", "must be an integer from 1000 to 100000");
  return {
    region,
    endpoint: customEndpoint ? parseEndpoint(customEndpoint) : `https://dynamodb.${region}.amazonaws.com`,
    timeoutMs,
    allowToolWrites: environment?.[TOOL_WRITES_VARIABLE] === "1",
    allowedTables: readAllowedTables(environment),
  };
}

// https only, except plain http to this machine (DynamoDB Local). An origin only.
function parseEndpoint(rawEndpoint) {
  let endpointUrl;
  try {
    endpointUrl = new URL(rawEndpoint);
  } catch {
    throw invalidSetting("DYNAMODB_ENDPOINT", "is not a URL");
  }
  const isLocalHttp = endpointUrl.protocol === "http:" && LOCAL_HOSTS.has(endpointUrl.hostname);
  if (endpointUrl.protocol !== "https:" && !isLocalHttp) throw invalidSetting("DYNAMODB_ENDPOINT", "must be https (http only for localhost)");
  if (endpointUrl.username || endpointUrl.password || endpointUrl.pathname !== "/" || endpointUrl.search || endpointUrl.hash) {
    throw invalidSetting("DYNAMODB_ENDPOINT", "must be an origin like http://localhost:8000, without a path or credentials");
  }
  return endpointUrl.origin;
}

// Comma-separated table names or ARNs agent tools may use; unset means any table name (but no ARNs).
function readAllowedTables(environment) {
  const rawValue = readVariable(environment, "DYNAMODB_ALLOWED_TABLES");
  if (rawValue === undefined) return null;
  return new Set(rawValue.split(",").map((table) => table.trim()).filter(Boolean));
}

function readVariable(environment, variableName) {
  const value = environment?.[variableName];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function invalidSetting(variableName, problem) {
  return new PluginError(`${variableName} ${problem}`, { kind: "invalid_input" });
}
