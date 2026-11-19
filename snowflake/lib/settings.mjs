/**
 * snowflake configuration from the environment: account and user, key source, session defaults (warehouse,
 * database, schema, role, and the role agent tools always use), limits and the agent write opt-in.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { resolveAccountIdentifiers } from "./key-pair-jwt.mjs";

export const TOOL_WRITES_VARIABLE = "SNOWFLAKE_TOOL_ALLOW_WRITES";
export const TOOL_ROLE_VARIABLE = "SNOWFLAKE_TOOL_ROLE";
export const KEY_VARIABLES = ["SNOWFLAKE_PRIVATE_KEY_PATH", "SNOWFLAKE_PRIVATE_KEY", "SNOWFLAKE_PRIVATE_KEY_PASSPHRASE"];
export const SETTING_VARIABLES = [
  "SNOWFLAKE_ACCOUNT",
  "SNOWFLAKE_USER",
  "SNOWFLAKE_HOST",
  "SNOWFLAKE_WAREHOUSE",
  "SNOWFLAKE_DATABASE",
  "SNOWFLAKE_SCHEMA",
  "SNOWFLAKE_ROLE",
  TOOL_ROLE_VARIABLE,
  "SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS",
  "SNOWFLAKE_WAIT_MS",
  "SNOWFLAKE_MAX_RESULT_BYTES",
  TOOL_WRITES_VARIABLE,
  "GRAPHRT_POLL_INTERVAL_MS",
];
const OBJECT_NAME_PATTERN = /^([A-Za-z_][A-Za-z0-9_$]{0,254}|"[^"]{1,255}")$/;
const HOST_PATTERN = /^[a-z0-9.-]+\.snowflakecomputing\.(com|cn)$/;
const NUMBER_LIMITS = {
  SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS: { fallback: 60, min: 1, max: 3600 },
  SNOWFLAKE_WAIT_MS: { fallback: 45000, min: 1000, max: 90000 },
  SNOWFLAKE_MAX_RESULT_BYTES: { fallback: 2000000, min: 1000, max: 10000000 },
};

/**
 * Reads and validates the settings.
 *
 * @param environment - Environment variables (object)
 * @returns `{jwtAccount, host, user, defaults: {warehouse, database, schema, role}, toolRole, statementTimeoutSeconds,
 *   waitMs, maxResultBytes, allowToolWrites}` (object)
 * @throws PluginError kind `invalid_input` - When a value is missing or malformed (the message names the variable)
 */
export function resolveSettings(environment) {
  const account = readVariable(environment, "SNOWFLAKE_ACCOUNT");
  const user = readVariable(environment, "SNOWFLAKE_USER");
  if (!account || !user) throw new PluginError("Set SNOWFLAKE_ACCOUNT (e.g. myorg-myaccount) and SNOWFLAKE_USER", { kind: "invalid_input" });
  const { jwtAccount, host } = resolveAccountIdentifiers(account);
  return {
    jwtAccount,
    host: readHost(environment) ?? host,
    user,
    defaults: {
      warehouse: readObjectName(environment, "SNOWFLAKE_WAREHOUSE"),
      database: readObjectName(environment, "SNOWFLAKE_DATABASE"),
      schema: readObjectName(environment, "SNOWFLAKE_SCHEMA"),
      role: readObjectName(environment, "SNOWFLAKE_ROLE"),
    },
    toolRole: readObjectName(environment, TOOL_ROLE_VARIABLE),
    statementTimeoutSeconds: readNumber(environment, "SNOWFLAKE_STATEMENT_TIMEOUT_SECONDS"),
    waitMs: readNumber(environment, "SNOWFLAKE_WAIT_MS"),
    maxResultBytes: readNumber(environment, "SNOWFLAKE_MAX_RESULT_BYTES"),
    allowToolWrites: environment?.[TOOL_WRITES_VARIABLE] === "1",
  };
}

/**
 * Checks a warehouse, database, schema or role name (unquoted identifier or one double-quoted identifier).
 *
 * @param name - Object name (string)
 * @param label - Argument or variable name (string)
 * @returns The name (string)
 * @throws PluginError kind `invalid_input`
 */
export function checkObjectName(name, label) {
  if (!OBJECT_NAME_PATTERN.test(name)) throw new PluginError(`${label} ${JSON.stringify(name)} is not a Snowflake identifier`, { kind: "invalid_input" });
  return name;
}

// PrivateLink and other hosts: only Snowflake's own domains, so the JWT is never sent elsewhere.
function readHost(environment) {
  const host = readVariable(environment, "SNOWFLAKE_HOST")?.toLowerCase();
  if (host !== undefined && !HOST_PATTERN.test(host)) throw new PluginError("SNOWFLAKE_HOST must be a host name ending in .snowflakecomputing.com (or .cn)", { kind: "invalid_input" });
  return host;
}

function readObjectName(environment, variableName) {
  const name = readVariable(environment, variableName);
  return name === undefined ? undefined : checkObjectName(name, variableName);
}

function readNumber(environment, variableName) {
  const { fallback, min, max } = NUMBER_LIMITS[variableName];
  const rawValue = readVariable(environment, variableName);
  if (rawValue === undefined) return fallback;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < min || value > max) throw new PluginError(`${variableName} must be an integer from ${min} to ${max}`, { kind: "invalid_input" });
  return value;
}

/**
 * Reads a trimmed, non-empty variable.
 *
 * @param environment - Environment variables (object)
 * @param variableName - Name (string)
 * @returns Value or undefined (string | undefined)
 */
export function readVariable(environment, variableName) {
  const value = environment?.[variableName];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
