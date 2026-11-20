/**
 * Load-time validation of a declarative REST plugin spec (see rest-plugin.mjs): plugin fields, auth and errors here,
 * operations in rest-operation-validation.mjs.
 *
 * A spec is code written by a plugin author, so problems throw a plain Error that names the plugin, the operation
 * and the field.
 */
import { validateOperation } from "./rest-operation-validation.mjs";
import {
  checkBaseUrl,
  checkEnvName,
  checkHeaderName,
  ERROR_KINDS,
  rejectUnknownKeys,
  requireText,
  validateRequestTimeout,
  validateToolOutput,
} from "./rest-spec-helpers.mjs";

const SPEC_KEYS = [
  "name",
  "version",
  "description",
  "apiName",
  "baseUrl",
  "allowedHostSuffix",
  "auth",
  "extraEnv",
  "limits",
  "defaultHeaders",
  "errors",
  "apiRequest",
  "timeoutMs",
  "maxRetries",
  "idempotencyKeyHeader",
  "toolOutput",
  "toolUserToken",
  "operations",
];
const AUTH_KEYS = {
  none: ["type"],
  bearer: ["type", "env"],
  header: ["type", "env", "header", "prefix"],
  query: ["type", "env", "param"],
  basic: ["type", "userEnv", "passwordEnv", "tokenEnv", "user", "password"],
  oauth2: ["type", "grant", "tokenUrl", "clientIdEnv", "clientSecretEnv", "refreshTokenEnv", "scope", "audience", "clientAuth"],
  custom: ["type", "env", "authorize"],
};
const ERROR_KEYS = ["messagePath", "codePath", "retryAfterPath", "retryAfterUnit", "kindByCode", "kindByStatus", "retryableCodes", "okPath", "okValue", "errorPath"];
const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function validateToolUserToken(spec, fail) {
  const { toolUserToken } = spec;
  if (toolUserToken === undefined || toolUserToken === false) return;
  if (spec.auth?.type === "none") fail("`toolUserToken` needs a credential; auth type `none` has none");
  if (toolUserToken === true) return;
  const credentialEnv = toolUserToken?.credentialEnv;
  const isEnvList = Array.isArray(credentialEnv) && credentialEnv.every((envName) => typeof envName === "string" && envName !== "");
  if (typeof toolUserToken !== "object" || Object.keys(toolUserToken).some((key) => key !== "credentialEnv") || (credentialEnv !== undefined && !isEnvList)) {
    fail("`toolUserToken` must be true or `{credentialEnv: [env names]}`");
  }
}

/**
 * Validates a REST plugin spec, throwing on the first problem.
 *
 * @param spec - Spec passed to defineRestPlugin (object)
 * @returns Nothing; the spec is valid when this returns
 * @throws Error - "<plugin>: <where>: <problem>" for the first problem found
 *
 * @example
 * validateRestSpec({ name: "x", ... }); // throws 'x: operation `get`: path placeholder {id} has no `in: "path"` param'
 */
export function validateRestSpec(spec) {
  if (!spec || typeof spec !== "object") throw new Error("rest plugin: the spec must be an object");
  const fail = (problem) => {
    throw new Error(`${typeof spec.name === "string" && spec.name ? spec.name : "rest plugin"}: ${problem}`);
  };
  validatePluginBasics(spec, fail);
  validateAuth(spec.auth, fail);
  validateErrors(spec.errors, fail);
  validateOperations(spec, fail);
}

function validatePluginBasics(spec, fail) {
  rejectUnknownKeys(spec, SPEC_KEYS, "spec", fail);
  if (typeof spec.name !== "string" || spec.name === "") fail("`name` is required");
  if (!KEBAB_CASE.test(spec.name)) fail(`\`name\` "${spec.name}" must be kebab-case`);
  if (typeof spec.version !== "string" || spec.version === "") fail("`version` is required");
  requireText(spec.description, "`description`", fail);
  validateHostSuffix(spec, fail);
  validateToolUserToken(spec, fail);
  if (typeof spec.baseUrl !== "function") checkBaseUrl(spec.baseUrl, fail, spec.allowedHostSuffix);
  for (const envName of spec.extraEnv ?? []) checkEnvName(envName, "extraEnv", fail);
  for (const headerName of Object.keys(spec.defaultHeaders ?? {})) checkHeaderName(headerName, "defaultHeaders:", fail);
  if (spec.idempotencyKeyHeader !== undefined) checkHeaderName(spec.idempotencyKeyHeader, "idempotencyKeyHeader", fail);
  validateToolOutput(spec.toolOutput, "toolOutput", fail);
  validateRequestTimeout(spec.timeoutMs, spec.limits, "timeoutMs", fail);
}

function validateHostSuffix(spec, fail) {
  if (spec.allowedHostSuffix === undefined) return;
  if (typeof spec.allowedHostSuffix !== "string" || !/^\.[a-z0-9.-]+$/i.test(spec.allowedHostSuffix)) {
    fail('`allowedHostSuffix` must start with "." and be a host suffix, e.g. ".atlassian.net"');
  }
}

function validateAuth(auth, fail) {
  if (!auth || typeof auth !== "object") fail("`auth` is required, e.g. {type: \"bearer\", env: \"API_TOKEN\"} or {type: \"none\"}");
  const allowedKeys = AUTH_KEYS[auth.type];
  if (!allowedKeys) fail(`auth type \`${auth.type}\` is unknown; use one of ${Object.keys(AUTH_KEYS).join(", ")}`);
  rejectUnknownKeys(auth, allowedKeys, "auth", fail);
  const authCheckers = {
    bearer: () => checkEnvName(auth.env, "auth.env", fail),
    header: () => (checkEnvName(auth.env, "auth.env", fail), checkHeaderName(auth.header, "auth.header", fail)),
    query: () => (checkEnvName(auth.env, "auth.env", fail), requireText(auth.param, "auth.param", fail)),
    basic: () => validateBasicAuth(auth, fail),
    oauth2: () => validateOAuthAuth(auth, fail),
    custom: () => validateCustomAuth(auth, fail),
  };
  authCheckers[auth.type]?.();
}

function validateBasicAuth(auth, fail) {
  const hasEnvPair = auth.userEnv !== undefined || auth.passwordEnv !== undefined;
  if (hasEnvPair) {
    checkEnvName(auth.userEnv, "auth.userEnv", fail);
    return checkEnvName(auth.passwordEnv, "auth.passwordEnv", fail);
  }
  if (auth.tokenEnv === undefined) fail("basic auth needs {userEnv, passwordEnv} or {tokenEnv, user} or {tokenEnv, password}");
  checkEnvName(auth.tokenEnv, "auth.tokenEnv", fail);
  if ((typeof auth.user === "string") === (typeof auth.password === "string")) fail("basic auth with tokenEnv needs exactly one of `user` or `password`");
}

function validateOAuthAuth(auth, fail) {
  if (!["client_credentials", "refresh_token"].includes(auth.grant)) fail('auth.grant must be "client_credentials" or "refresh_token"');
  let tokenUrl;
  try {
    tokenUrl = new URL(auth.tokenUrl);
  } catch {
    fail("auth.tokenUrl must be an https URL");
  }
  if (tokenUrl.protocol !== "https:") fail("auth.tokenUrl must be an https URL");
  checkEnvName(auth.clientIdEnv, "auth.clientIdEnv", fail);
  checkEnvName(auth.clientSecretEnv, "auth.clientSecretEnv", fail);
  if (auth.grant === "refresh_token") checkEnvName(auth.refreshTokenEnv, "auth.refreshTokenEnv", fail);
  if (auth.clientAuth !== undefined && !["body", "basic"].includes(auth.clientAuth)) fail('auth.clientAuth must be "body" or "basic"');
}

function validateCustomAuth(auth, fail) {
  if (typeof auth.authorize !== "function") fail("auth.authorize must be a function `({method, url, headers, query, body, credential, environment}) => secrets[]`");
  if (auth.env !== undefined) checkEnvName(auth.env, "auth.env", fail);
}

function validateErrors(errors, fail) {
  if (errors === undefined) return;
  rejectUnknownKeys(errors, ERROR_KEYS, "errors", fail);
  for (const kind of [...Object.values(errors.kindByCode ?? {}), ...Object.values(errors.kindByStatus ?? {})]) {
    if (!ERROR_KINDS.includes(kind)) fail(`errors: kind \`${kind}\` is unknown; use one of ${ERROR_KINDS.join(", ")}`);
  }
  if (errors.retryAfterUnit !== undefined && !["seconds", "milliseconds"].includes(errors.retryAfterUnit)) fail('errors.retryAfterUnit must be "seconds" or "milliseconds"');
}

function validateOperations(spec, fail) {
  if (!Array.isArray(spec.operations) || spec.operations.length === 0) fail("the spec needs at least one operation");
  const seenNames = new Set();
  for (const operation of spec.operations) {
    const operationName = operation?.name;
    if (seenNames.has(operationName)) fail(`duplicate operation \`${operationName}\``);
    seenNames.add(operationName);
    if (operationName === "api_request" && spec.apiRequest !== false) fail("operation `api_request` is generated; set `apiRequest: false` to define your own");
    validateOperation(spec, operation, (problem) => fail(`operation \`${operationName}\`: ${problem}`));
  }
}
