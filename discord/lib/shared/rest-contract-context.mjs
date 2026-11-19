/**
 * Shared state for the generated REST contract tests (rest-plugin-testing.mjs): fake credentials, a recording
 * fetch that also answers the OAuth token URL and contract file URLs, and canned job flows.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePath, writePath } from "./object-path.mjs";
import { createOperationRunner } from "./operations.mjs";
import { resolveBaseUrl } from "./rest-plugin.mjs";
import { listPlaceholders } from "./rest-spec-helpers.mjs";
import { createRecordingFetch } from "./testing.mjs";

export const FAKE_CREDENTIAL = "contract-test-credential-0001";
export const FAKE_JOB_ID = "contract-job-1";
/** Use `https://files.contract.example/<name>` for multipart file args in cases; the contract serves it. */
export const CONTRACT_FILE_HOST = "files.contract.example";
const FAKE_USER = "contract-user";
const BODY_SPECIFIERS = ["json", "form", "text", "multipart", "body"];
const publicResolver = async () => ["93.184.216.34"];

/**
 * Builds the contract context and checks the cases are complete.
 *
 * @param pluginDefinition - Definition returned by defineRestPlugin (object)
 * @param cases - Contract cases (object)
 * @returns Context used by every generated test (object)
 * @throws Error - Not a declarative definition, custom auth without checkAuth, or an incomplete case
 */
export function createContractContext(pluginDefinition, cases) {
  const restSpec = pluginDefinition.restSpec;
  if (!restSpec) throw new Error(`${pluginDefinition.name}: describeRestPluginContract needs a definition made by defineRestPlugin`);
  if (restSpec.auth.type === "custom" && typeof cases.checkAuth !== "function") throw new Error(`${pluginDefinition.name}: custom auth needs cases.checkAuth(call, credential)`);
  const scratchDirectory = mkdtempSync(join(tmpdir(), `${pluginDefinition.name}-contract-`));
  const environment = buildEnvironment(restSpec, cases.environment, scratchDirectory);
  const operationCases = cases.operations ?? {};
  const casedOperations = restSpec.operations.filter((operation) => operationCases[operation.name]);
  for (const operation of casedOperations) checkCase(pluginDefinition.name, operation, operationCases[operation.name]);
  const baseUrlFor = (operation) => new URL(resolveBaseUrl(operation.baseUrl ?? restSpec.baseUrl, environment, operation.baseUrl ? undefined : restSpec.allowedHostSuffix));
  const hasApiRequest = pluginDefinition.operations.some((operation) => operation.name === "api_request");
  return { pluginDefinition, restSpec, environment, credential: describeCredential(restSpec.auth, environment), operationCases, casedOperations, baseUrlFor, hasApiRequest, checkAuth: cases.checkAuth, scratchDirectory };
}

function checkCase(pluginName, operation, operationCase) {
  const fail = (problem) => {
    throw new Error(`${pluginName}: contract case \`${operation.name}\`: ${problem}`);
  };
  const request = operationCase.request;
  if (!operationCase.args || !request) fail("needs `args` and `request`");
  if (typeof request.url !== "string" || !/^https?:\/\//.test(request.url) || request.url.includes("?")) fail("request.url must be the full URL literal without the query, e.g. \"https://api.example.com/v1/items/1\"");
  if (request.query === undefined) fail('request.query is required: the exact query (auth param excluded), or "absent"');
  const bodySpecifiers = BODY_SPECIFIERS.filter((key) => request[key] !== undefined);
  if (!["GET", "HEAD"].includes(operation.method) && bodySpecifiers.length !== 1) fail('request needs exactly one of json, form, text, multipart or body: "absent"');
}

function buildEnvironment(restSpec, caseEnvironment = {}, scratchDirectory) {
  const auth = restSpec.auth;
  const fakeEnvironment = { GRAPHRT_POLL_INTERVAL_MS: "0" };
  for (const envName of [auth.env, auth.tokenEnv, auth.passwordEnv, auth.clientSecretEnv, auth.refreshTokenEnv]) if (envName) fakeEnvironment[envName] = FAKE_CREDENTIAL;
  for (const envName of [auth.userEnv, auth.clientIdEnv]) if (envName) fakeEnvironment[envName] = FAKE_USER;
  for (const operation of restSpec.operations) {
    if (operation.response?.binary) fakeEnvironment[operation.response.binary.envDir] = join(scratchDirectory, "binary");
  }
  return { ...fakeEnvironment, ...caseEnvironment };
}

function describeCredential(auth, environment) {
  if (auth.type === "oauth2") return FAKE_CREDENTIAL;
  const credentialEnv = auth.env ?? auth.tokenEnv ?? auth.passwordEnv;
  return credentialEnv ? environment[credentialEnv] : undefined;
}

/**
 * Runs one operation against canned responses; OAuth token and contract file requests are answered on the side.
 *
 * @param contract - Contract context (object)
 * @param operationName - Operation (string)
 * @param args - Arguments (object)
 * @param options - `{responses, source, environment, signal}` (object)
 * @returns `{output, error, calls}` (Promise<object>)
 */
export async function runContractOperation(contract, operationName, args, { responses = [{ body: {} }], source = "node", environment = {}, signal } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const tokenUrl = contract.restSpec.auth.type === "oauth2" ? contract.restSpec.auth.tokenUrl : undefined;
  const contractFetch = async (url, init) => {
    if (tokenUrl && String(url) === tokenUrl) return new Response(JSON.stringify({ access_token: FAKE_CREDENTIAL, expires_in: 3600 }), { headers: { "content-type": "application/json" } });
    if (new URL(String(url)).host === CONTRACT_FILE_HOST) return new Response("CONTRACT-FILE", { headers: { "content-type": "application/octet-stream" } });
    return recordingFetch(url, init);
  };
  const runOperation = createOperationRunner(contract.pluginDefinition, { ...contract.environment, ...environment }, { fetchImpl: contractFetch, resolveHostAddresses: publicResolver });
  const outcome = await runOperation(operationName, args, { source, signal }).then(
    (output) => ({ output }),
    (error) => ({ error }),
  );
  return { ...outcome, calls: recordingFetch.calls };
}

/**
 * Builds the value `leaf` placed at a path, turning `[]` segments into one-item arrays.
 *
 * @param pathText - e.g. "images[].url" (string)
 * @param leaf - Value at the end (any)
 * @returns e.g. `{images: [{url: leaf}]}` (any)
 */
export function buildValueAtPath(pathText, leaf) {
  return parsePath(pathText).reduceRight((inner, segment) => (segment === parsePath.FLATTEN ? [inner] : { [segment]: inner }), leaf);
}

/**
 * Canned responses for a successful call: the case's response, or a job created and finished with `resultValue`.
 *
 * @param contract - Contract context (object)
 * @param operation - Normalized operation (object)
 * @param resultValue - Job result to return (any, default `{contract_result: true}`)
 * @returns Responses for createRecordingFetch (object[])
 */
export function successResponses(contract, operation, resultValue = { contract_result: true }) {
  const operationCase = contract.operationCases[operation.name];
  if (operation.response?.binary) return [{ body: "CONTRACT-BINARY", headers: { "content-type": "application/octet-stream" } }];
  if (!operation.job) return [operationCase.response ?? { body: {} }];
  const job = operation.job;
  const finishedStatus = jobStatusResponse(operation, job.doneValues[0], job.result ? {} : { [job.resultPath ?? "contract_result"]: resultValue });
  const resultResponses = job.result ? [{ body: job.resultPath ? writePath({}, job.resultPath, resultValue) : resultValue }] : [];
  return [jobCreatedResponse(contract, operation), finishedStatus, ...resultResponses];
}

/**
 * The create response of a job: the case's response body with the fake job id (and poll/result URLs).
 *
 * @param contract - Contract context (object)
 * @param operation - Normalized operation with `job` (object)
 * @returns Response for createRecordingFetch (object)
 */
export function jobCreatedResponse(contract, operation) {
  const caseBody = structuredClone(contract.operationCases[operation.name].response?.body ?? {});
  const createBody = caseBody && typeof caseBody === "object" && !Array.isArray(caseBody) ? caseBody : {};
  writePath(createBody, operation.job.idPath, FAKE_JOB_ID);
  const origin = contract.baseUrlFor(operation).origin;
  if (operation.job.poll.urlPath) writePath(createBody, operation.job.poll.urlPath, `${origin}/contract/jobs/${FAKE_JOB_ID}/status`);
  if (operation.job.result?.urlPath) writePath(createBody, operation.job.result.urlPath, `${origin}/contract/jobs/${FAKE_JOB_ID}/result`);
  return { body: createBody };
}

/**
 * A job status response.
 *
 * @param operation - Normalized operation with `job` (object)
 * @param statusValue - Status (any)
 * @param extraFields - `{path: value}` to add (object)
 * @returns Response for createRecordingFetch (object)
 */
export function jobStatusResponse(operation, statusValue, extraFields = {}) {
  const statusBody = writePath({}, operation.job.statusPath, statusValue);
  for (const [fieldPath, fieldValue] of Object.entries(extraFields)) writePath(statusBody, fieldPath, fieldValue);
  return { body: statusBody };
}

/**
 * Whether a path param uses `{+name}` (several segments).
 *
 * @param operation - Normalized operation (object)
 * @param paramName - Param (string)
 * @returns True for multi-segment params (boolean)
 */
export function isMultiSegmentParam(operation, paramName) {
  return listPlaceholders(operation.path).some((placeholder) => placeholder.name === paramName && placeholder.multiSegment);
}
