/**
 * Generated contract tests for declarative REST plugins (rest-plugin.mjs).
 *
 * `describeRestPluginContract(pluginDefinition, cases)` registers node:test tests that check, for every operation:
 * the request shape (method, path, encoded path params, query, body, headers) and the credential's placement;
 * refusal of missing required params and of path traversal; redaction of the credential from errors and
 * `api_request` responses; no retry of unsafe writes after a 5xx (and a retry for reads and idempotent writes);
 * nodeOnly and `toolPolicy` refusals for agent tools; `api_request` POST refused for tools; limit/cursor
 * pagination mapping; and async jobs that finish, fail and time out.
 *
 * Only tests import this module (it imports node:test).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readPath, writePath } from "./object-path.mjs";
import { createOperationRunner } from "./operations.mjs";
import { resolveBaseUrl } from "./rest-plugin.mjs";
import { createRecordingFetch } from "./testing.mjs";

const FAKE_CREDENTIAL = "contract-test-credential-0001";
const FAKE_USER = "contract-user";
const FAKE_JOB_ID = "contract-job-1";
const NEXT_CURSOR_VALUE = "contract-next-cursor";
const PENDING_STATUS = "contract-pending";
const publicResolver = async () => ["93.184.216.34"];
const serverFailure = () => ({ status: 503, headers: { "retry-after": "0" }, body: { message: "temporarily unavailable" } });

/**
 * Registers the generated contract tests in a `describe` block named after the plugin.
 *
 * @param pluginDefinition - Definition returned by defineRestPlugin (object)
 * @param cases - Contract cases (object)
 * @param cases.operations - `{operationName: {args, request: {method, path, query?, json?, form?, headers?}, response?}}`;
 *   `path` is relative to the base URL and URL-encoded, `query` is compared exactly (auth param excluded), `json`
 *   and `form` exactly, `headers` as a subset; `response` is the canned success `{status?, body, headers?}` (object)
 * @param cases.environment - Extra env for every run; fake credentials are filled in by default (object, optional)
 * @param cases.checkAuth - `(call, credential) => void` for `custom` auth (function, optional)
 * @returns Nothing; tests are registered with node:test
 *
 * @example
 * describeRestPluginContract(pluginDefinition, {
 *   operations: { get_forecast: { args: { latitude: 1, longitude: 2 }, request: { method: "GET", path: "/v1/forecast", query: { latitude: "1", longitude: "2" } } } },
 * });
 */
export function describeRestPluginContract(pluginDefinition, cases) {
  describe(`${pluginDefinition.name} REST contract`, () => {
    for (const contractTest of buildContractTests(pluginDefinition, cases)) test(contractTest.name, contractTest.run);
  });
}

/**
 * Lists the names of the tests describeRestPluginContract would register.
 *
 * @param pluginDefinition - Definition returned by defineRestPlugin (object)
 * @param cases - Contract cases (object)
 * @returns Test names (string[])
 */
export function listContractTestNames(pluginDefinition, cases) {
  return buildContractTests(pluginDefinition, cases).map((contractTest) => contractTest.name);
}

function buildContractTests(pluginDefinition, cases) {
  const contract = createContractContext(pluginDefinition, cases);
  return [
    coverageTest(contract),
    ...contract.casedOperations.flatMap((operation) => [
      requestShapeTest(contract, operation),
      ...requiredParamTests(contract, operation),
      ...pathTraversalTests(contract, operation),
      ...retryTests(contract, operation),
      ...toolPolicyTests(contract, operation),
      ...paginationTests(contract, operation),
      ...jobTests(contract, operation),
    ]),
    ...redactionTests(contract),
    ...apiRequestTests(contract),
  ];
}

function createContractContext(pluginDefinition, cases) {
  const restSpec = pluginDefinition.restSpec;
  if (!restSpec) throw new Error(`${pluginDefinition.name}: describeRestPluginContract needs a definition made by defineRestPlugin`);
  const environment = buildEnvironment(restSpec.auth, cases.environment);
  const credential = describeCredential(restSpec.auth, environment);
  const operationCases = cases.operations ?? {};
  const casedOperations = restSpec.operations.filter((operation) => operationCases[operation.name]);
  const basePath = new URL(resolveBaseUrl(restSpec.baseUrl, environment)).pathname.replace(/\/$/, "");
  const baseOrigin = new URL(resolveBaseUrl(restSpec.baseUrl, environment)).origin;
  const hasApiRequest = pluginDefinition.operations.some((operation) => operation.name === "api_request") && restSpec.apiRequest !== false;
  return { pluginDefinition, restSpec, environment, credential, operationCases, casedOperations, basePath, baseOrigin, hasApiRequest, checkAuth: cases.checkAuth };
}

function buildEnvironment(auth, caseEnvironment = {}) {
  const fakeEnvironment = { GRAPHRT_POLL_INTERVAL_MS: "0" };
  for (const envName of [auth.env, auth.tokenEnv, auth.passwordEnv]) if (envName) fakeEnvironment[envName] = FAKE_CREDENTIAL;
  if (auth.userEnv) fakeEnvironment[auth.userEnv] = FAKE_USER;
  return { ...fakeEnvironment, ...caseEnvironment };
}

function describeCredential(auth, environment) {
  const credentialEnv = auth.env ?? auth.tokenEnv ?? auth.passwordEnv;
  return credentialEnv ? environment[credentialEnv] : undefined;
}

async function runContractOperation(contract, operationName, args, { responses = [{ body: {} }], source = "node", environment = {} } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(contract.pluginDefinition, { ...contract.environment, ...environment }, { fetchImpl: recordingFetch, resolveHostAddresses: publicResolver });
  const outcome = await runOperation(operationName, args, { source }).then(
    (output) => ({ output }),
    (error) => ({ error }),
  );
  return { ...outcome, calls: recordingFetch.calls };
}

function successResponses(contract, operation) {
  const operationCase = contract.operationCases[operation.name];
  if (!operation.job) return [operationCase.response ?? { body: {} }];
  return [jobCreatedResponse(operation, operationCase), jobStatusResponse(operation, operation.job.doneValues[0])];
}

// --- coverage and request shape -------------------------------------------------------------

function coverageTest(contract) {
  return {
    name: "every operation has a contract case",
    run: () => {
      const missingNames = contract.restSpec.operations.map((operation) => operation.name).filter((operationName) => !contract.operationCases[operationName]);
      assert.deepEqual(missingNames, [], `add a contract case for: ${missingNames.join(", ")}`);
    },
  };
}

function requestShapeTest(contract, operation) {
  const { args, request: expected } = contract.operationCases[operation.name];
  return {
    name: `${operation.name} sends ${expected.method} ${expected.path} with the credential in place`,
    run: async () => {
      const { error, calls } = await runContractOperation(contract, operation.name, args, { responses: successResponses(contract, operation) });
      if (error) throw error;
      assertRequestShape(contract, calls[0], expected);
      assertAuthPlacement(contract, calls[0]);
    },
  };
}

function assertRequestShape(contract, call, expected) {
  assert.equal(call.method, expected.method, "method");
  assert.equal(call.path, `${contract.basePath}${expected.path}`, "path");
  if (expected.query !== undefined) assert.deepEqual(withoutAuthQuery(contract, call.query), expected.query, "query");
  if (expected.json !== undefined) assert.deepEqual(call.json, expected.json, "json body");
  if (expected.form !== undefined) assert.deepEqual(call.form, expected.form, "form body");
  if (expected.json === undefined && expected.form === undefined && ["GET", "HEAD", "DELETE"].includes(expected.method)) assert.equal(call.body, undefined, "no body");
  for (const [headerName, headerValue] of Object.entries(expected.headers ?? {})) assert.equal(call.headers[headerName.toLowerCase()], headerValue, `header ${headerName}`);
}

function withoutAuthQuery(contract, query) {
  const auth = contract.restSpec.auth;
  if (auth.type !== "query") return query;
  return Object.fromEntries(Object.entries(query).filter(([queryName]) => queryName !== auth.param));
}

function assertAuthPlacement(contract, call) {
  const { auth } = contract.restSpec;
  const credential = contract.credential;
  const authChecks = {
    none: () => assert.equal(call.headers.authorization, undefined, "no credential is sent"),
    bearer: () => assert.equal(call.headers.authorization, `Bearer ${credential}`),
    header: () => assert.equal(call.headers[auth.header.toLowerCase()], `${auth.prefix ?? ""}${credential}`),
    query: () => assert.equal(call.query[auth.param], credential),
    basic: () => assert.match(Buffer.from(String(call.headers.authorization).replace(/^Basic /, ""), "base64").toString(), new RegExp(credential)),
    custom: () => contract.checkAuth?.(call, credential),
  };
  authChecks[auth.type]();
}

// --- input validation ----------------------------------------------------------------------

function requiredParamTests(contract, operation) {
  const { args } = contract.operationCases[operation.name];
  return Object.entries(operation.params)
    .filter(([, paramSpec]) => paramSpec.required)
    .map(([paramName]) => ({
      name: `${operation.name} refuses a missing required \`${paramName}\``,
      run: async () => {
        const argsWithoutParam = Object.fromEntries(Object.entries(args).filter(([argName]) => argName !== paramName));
        const { error, calls } = await runContractOperation(contract, operation.name, argsWithoutParam);
        assert.equal(error?.kind, "invalid_input", `expected invalid_input, got ${error?.kind ?? "success"}`);
        assert.equal(calls.length, 0, "no request is sent");
      },
    }));
}

function pathTraversalTests(contract, operation) {
  const { args } = contract.operationCases[operation.name];
  return Object.entries(operation.params)
    .filter(([, paramSpec]) => paramSpec.in === "path" && paramSpec.type === "string" && !paramSpec.enum)
    .map(([paramName]) => ({
      name: `${operation.name} refuses path traversal in \`${paramName}\``,
      run: async () => {
        const dotted = await runContractOperation(contract, operation.name, { ...args, [paramName]: ".." });
        assert.equal(dotted.error?.kind, "invalid_input", "'..' is refused");
        assert.equal(dotted.calls.length, 0);
        const escaping = await runContractOperation(contract, operation.name, { ...args, [paramName]: "../../escape" }, { responses: successResponses(contract, operation) });
        assert.ok(escaping.calls[0]?.path.includes("..%2F..%2Fescape"), `"../../escape" must stay one encoded segment, got ${escaping.calls[0]?.path}`);
      },
    }));
}

// --- write safety --------------------------------------------------------------------------

function retryTests(contract, operation) {
  const { args } = contract.operationCases[operation.name];
  if (operation.write === "unsafe") {
    return [{
      name: `${operation.name} (unsafe) is never retried after a 5xx and says the outcome is unknown`,
      run: async () => {
        const { error, calls } = await runContractOperation(contract, operation.name, args, { responses: [serverFailure(), ...successResponses(contract, operation)] });
        assert.equal(calls.length, 1, "exactly one attempt");
        assert.equal(error?.retryable, false, "not retryable");
        assert.match(error.message, /outcome unknown/);
      },
    }];
  }
  if (operation.job || contract.restSpec.maxRetries === 0) return [];
  return [{
    name: `${operation.name} (${operation.write}) is retried after a 5xx`,
    run: async () => {
      const { error, calls } = await runContractOperation(contract, operation.name, args, { responses: [serverFailure(), ...successResponses(contract, operation)] });
      if (error) throw error;
      assert.equal(calls.length, 2);
    },
  }];
}

function toolPolicyTests(contract, operation) {
  const { args } = contract.operationCases[operation.name];
  const toolArgs = operation.job ? { ...args, wait: false } : args;
  if (operation.nodeOnly) {
    return [{
      name: `${operation.name} is not offered as an agent tool`,
      run: async () => {
        const { error, calls } = await runContractOperation(contract, operation.name, toolArgs, { source: "tool" });
        assert.equal(error?.kind, "invalid_input");
        assert.equal(calls.length, 0);
      },
    }];
  }
  if (!operation.toolPolicy) return [];
  const envName = operation.toolPolicy.replace(/^optIn:/, "");
  return [{
    name: `${operation.name} needs ${envName}=1 as an agent tool`,
    run: async () => {
      const refused = await runContractOperation(contract, operation.name, toolArgs, { source: "tool", environment: { [envName]: "" } });
      assert.equal(refused.error?.kind, "permission_denied");
      assert.equal(refused.calls.length, 0);
      const allowed = await runContractOperation(contract, operation.name, toolArgs, { source: "tool", environment: { [envName]: "1" }, responses: successResponses(contract, operation) });
      if (allowed.error) throw allowed.error;
      assert.ok(allowed.calls.length >= 1);
    },
  }];
}

function redactionTests(contract) {
  const firstOperation = contract.casedOperations[0];
  if (!contract.credential || !firstOperation) return [];
  const { args } = contract.operationCases[firstOperation.name];
  const echoedMessage = `invalid credential ${contract.credential}`;
  const echoingBody = { message: echoedMessage, error: { message: echoedMessage, code: echoedMessage }, error_description: echoedMessage, detail: echoedMessage, description: echoedMessage, reason: echoedMessage };
  return [{
    name: "redacts the credential from API errors",
    run: async () => {
      const { error } = await runContractOperation(contract, firstOperation.name, args, { responses: [{ status: 400, body: echoingBody }] });
      assert.ok(error, "the 400 response fails the operation");
      assert.equal(error.message.includes(contract.credential), false, `credential leaked: ${error.message}`);
    },
  }];
}

function apiRequestTests(contract) {
  if (!contract.hasApiRequest) return [];
  const tests = [{
    name: "api_request refuses POST as an agent tool",
    run: async () => {
      const { error, calls } = await runContractOperation(contract, "api_request", { method: "POST", path: "/anything", body: {} }, { source: "tool" });
      assert.equal(error?.kind, "permission_denied");
      assert.equal(calls.length, 0);
    },
  }];
  if (!contract.credential) return tests;
  tests.push({
    name: "api_request redacts the credential from responses",
    run: async () => {
      const { output, error } = await runContractOperation(contract, "api_request", { path: "/anything" }, { source: "tool", responses: [{ body: { echoed: `key=${contract.credential}` } }] });
      if (error) throw error;
      assert.equal(JSON.stringify(output).includes(contract.credential), false);
    },
  });
  return tests;
}

// --- pagination ----------------------------------------------------------------------------

function paginationTests(contract, operation) {
  if (!operation.pagination) return [];
  const style = operation.pagination.style;
  return [{
    name: `${operation.name} maps limit/cursor (${style} pagination) and returns next_cursor`,
    run: () => (style === "link" ? checkLinkPagination(contract, operation) : checkFieldPagination(contract, operation)),
  }];
}

function paginationLimit(contract, operation) {
  const generatedOperation = contract.pluginDefinition.operations.find((candidate) => candidate.name === operation.name);
  const limitSchema = generatedOperation.parameters.properties.limit;
  if (!limitSchema) return undefined;
  return Math.min(2, limitSchema.maximum ?? 2);
}

async function checkFieldPagination(contract, operation) {
  const { args } = contract.operationCases[operation.name];
  const limit = paginationLimit(contract, operation);
  // Without a limit param the API's page size is unknown; two items still count as a non-empty page.
  const pageSize = limit ?? 2;
  const pagination = describeFieldPagination(operation, pageSize);
  const pageArgs = { ...args, cursor: pagination.cursor, ...(limit === undefined ? {} : { limit }) };
  const { output, error, calls } = await runContractOperation(contract, operation.name, pageArgs, { responses: [{ body: pagination.buildBody(pageSize) }] });
  if (error) throw error;
  assertPaginationParam(operation, calls[0], pagination.cursorWireName, pagination.cursorWireValue);
  if (limit !== undefined) assertPaginationParam(operation, calls[0], pagination.limitWireName, limit);
  assert.equal(output.next_cursor, pagination.expectedNextCursor, "next_cursor");
}

function describeFieldPagination(operation, pageSize) {
  const response = operation.response;
  const buildItems = (count) => Array.from({ length: count }, (unused, index) => ({ contract_item: index }));
  const buildBodyWithItems = (count) => (response.dataPath ? writePath({}, response.dataPath, buildItems(count)) : buildItems(count));
  const styles = {
    cursor: () => ({
      cursor: "contract-cursor",
      cursorWireName: response.cursorParam,
      cursorWireValue: "contract-cursor",
      limitWireName: response.limitParam,
      expectedNextCursor: NEXT_CURSOR_VALUE,
      buildBody: (count) => {
        const body = response.dataPath ? writePath({}, response.dataPath, buildItems(count)) : {};
        writePath(body, response.cursorPath, NEXT_CURSOR_VALUE);
        if (response.hasMorePath) writePath(body, response.hasMorePath, true);
        return body;
      },
    }),
    page: () => {
      const currentPage = (response.pagePagination.firstPage ?? 1) + 1;
      const buildBody = (count) => withTotal(buildBodyWithItems(count), response.pagePagination.totalPagesPath, 1000);
      return { cursor: String(currentPage), cursorWireName: response.pagePagination.pageParam, cursorWireValue: currentPage, limitWireName: response.pagePagination.sizeParam, expectedNextCursor: String(currentPage + 1), buildBody };
    },
    offset: () => {
      const buildBody = (count) => withTotal(buildBodyWithItems(count), response.offsetPagination.totalPath, 1000);
      return { cursor: "10", cursorWireName: response.offsetPagination.offsetParam, cursorWireValue: 10, limitWireName: response.offsetPagination.limitParam, expectedNextCursor: String(10 + pageSize), buildBody };
    },
  };
  return styles[operation.pagination.style]();
}

function withTotal(body, totalPath, total) {
  if (totalPath && body && typeof body === "object" && !Array.isArray(body)) writePath(body, totalPath, total);
  return body;
}

function assertPaginationParam(operation, call, wireName, expectedValue) {
  const sentValue = operation.pagination.paramsIn === "body" ? readPath(call.json ?? call.form, wireName) : call.query[wireName];
  assert.equal(String(sentValue), String(expectedValue), `pagination param ${wireName}`);
}

async function checkLinkPagination(contract, operation) {
  const { args, request } = contract.operationCases[operation.name];
  const limit = paginationLimit(contract, operation);
  const nextUrl = `${contract.baseOrigin}${contract.basePath}${request.path}?contract_page=2`;
  const firstArgs = limit === undefined ? args : { ...args, limit };
  const first = await runContractOperation(contract, operation.name, firstArgs, { responses: [{ body: [{}], headers: { link: `<${nextUrl}>; rel="next"` } }] });
  if (first.error) throw first.error;
  if (limit !== undefined) assert.equal(first.calls[0].query[operation.response.limitParam], String(limit), "limit param");
  assert.equal(first.output.next_cursor, nextUrl, "next_cursor is the next link");
  const second = await runContractOperation(contract, operation.name, { ...args, cursor: nextUrl }, { responses: [{ body: [] }] });
  if (second.error) throw second.error;
  assert.equal(new URL(second.calls[0].url).searchParams.get("contract_page"), "2", "the cursor URL is requested");
  assert.equal(second.output.next_cursor, null);
}

// --- jobs ----------------------------------------------------------------------------------

function jobCreatedResponse(operation, operationCase) {
  const createBody = structuredClone(operationCase.response?.body ?? {});
  return { body: writePath(createBody && typeof createBody === "object" ? createBody : {}, operation.job.idPath, FAKE_JOB_ID) };
}

function jobStatusResponse(operation, statusValue, extraFields = {}) {
  const statusBody = writePath({}, operation.job.statusPath, statusValue);
  if (operation.job.resultPath && statusValue === operation.job.doneValues[0]) writePath(statusBody, operation.job.resultPath, { contract_result: true });
  for (const [fieldPath, fieldValue] of Object.entries(extraFields)) writePath(statusBody, fieldPath, fieldValue);
  return { body: statusBody };
}

function jobTests(contract, operation) {
  if (!operation.job) return [];
  const operationCase = contract.operationCases[operation.name];
  const job = operation.job;
  const tests = [{
    name: `${operation.name} job: done returns the job id, status and result`,
    run: async () => {
      const { output, error, calls } = await runContractOperation(contract, operation.name, operationCase.args, { responses: successResponses(contract, operation) });
      if (error) throw error;
      assert.equal(output.data.job_id, FAKE_JOB_ID);
      assert.equal(output.data.status, job.doneValues[0]);
      assert.ok(calls.slice(1).some((call) => call.url.includes(FAKE_JOB_ID)), "the status is polled with the job id");
    },
  }];
  if (job.failedValues?.length) {
    tests.push({
      name: `${operation.name} job: failed is reported with the job id and is not retryable`,
      run: async () => {
        const failedStatus = jobStatusResponse(operation, job.failedValues[0], job.errorPath ? { [job.errorPath]: "contract failure reason" } : {});
        const { error } = await runContractOperation(contract, operation.name, operationCase.args, { responses: [jobCreatedResponse(operation, operationCase), failedStatus] });
        assert.equal(error?.kind, "api_error");
        assert.equal(error.retryable, false);
        assert.match(error.message, new RegExp(FAKE_JOB_ID));
      },
    });
  }
  tests.push({
    name: `${operation.name} job: timeout returns the job id with retryable false`,
    run: async () => {
      const pendingStatuses = Array.from({ length: 20 }, () => jobStatusResponse(operation, PENDING_STATUS));
      const { error } = await runContractOperation(contract, operation.name, operationCase.args, {
        responses: [jobCreatedResponse(operation, operationCase), ...pendingStatuses],
        environment: { GRAPHRT_JOB_TIMEOUT_MS: "1" },
      });
      assert.equal(error?.kind, "timeout");
      assert.equal(error.retryable, false);
      assert.match(error.message, new RegExp(FAKE_JOB_ID));
    },
  });
  return tests;
}
