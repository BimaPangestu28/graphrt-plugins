/**
 * Generated contract tests about requests and safety (rest-plugin-testing.mjs): coverage, request shape and
 * credential placement, expected data, required params, path traversal, write retries and outcome notes, tool
 * policies, api_request, credential redaction and the declared error mapping.
 */
import assert from "node:assert/strict";
import { writePath } from "./object-path.mjs";
import { FAKE_CREDENTIAL, isMultiSegmentParam, runContractOperation, successResponses } from "./rest-contract-context.mjs";

const serverFailure = () => ({ status: 503, headers: { "retry-after": "0" }, body: { message: "temporarily unavailable" } });
const CONTRACT_ERROR_MESSAGE = "contract error message";
const RETRIED_KINDS = new Set(["rate_limited", "network_error"]);

/**
 * Lists the request and safety tests for a contract.
 *
 * @param contract - Contract context (object)
 * @returns `[{name, run}]` (object[])
 */
export function buildRequestTests(contract) {
  return [
    coverageTest(contract),
    ...contract.casedOperations.flatMap((operation) => [
      requestShapeTest(contract, operation),
      ...requiredParamTests(contract, operation),
      ...pathTraversalTests(contract, operation),
      ...writeSafetyTests(contract, operation),
      ...toolPolicyTests(contract, operation),
    ]),
    ...redactionTests(contract),
    ...errorMappingTests(contract),
    ...apiRequestTests(contract),
  ];
}

function coverageTest(contract) {
  return {
    name: "every operation has a contract case",
    run: () => {
      const missingNames = contract.restSpec.operations.map((operation) => operation.name).filter((operationName) => !contract.operationCases[operationName]);
      assert.deepEqual(missingNames, [], `add a contract case for: ${missingNames.join(", ")}`);
    },
  };
}

// --- request shape ------------------------------------------------------------------------------

function requestShapeTest(contract, operation) {
  const { args, request: expected, expect: expectedOutput } = contract.operationCases[operation.name];
  return {
    name: `${operation.name} sends ${expected.method} ${expected.url} with the credential in place`,
    run: async () => {
      const { output, error, calls } = await runContractOperation(contract, operation.name, args, { responses: successResponses(contract, operation) });
      if (error) throw error;
      await assertRequestShape(contract, calls[0], expected);
      assertAuthPlacement(contract, operation, calls[0]);
      if (expectedOutput?.data !== undefined) assert.deepEqual(output.data, expectedOutput.data, "data");
    },
  };
}

async function assertRequestShape(contract, call, expected) {
  const callUrl = new URL(call.url);
  assert.equal(call.method, expected.method, "method");
  assert.equal(`${callUrl.origin}${callUrl.pathname}`, expected.url, "url");
  assert.deepEqual(groupEntries(withoutAuthQuery(contract, call.queryEntries)), expected.query === "absent" ? {} : expected.query, "query");
  if (expected.json !== undefined) assert.deepEqual(call.json, expected.json, "json body");
  if (expected.form !== undefined) assert.deepEqual(groupEntries([...new URLSearchParams(call.body ?? "")]), expected.form, "form body");
  if (expected.text !== undefined) assert.equal(call.body, expected.text, "text body");
  if (expected.multipart !== undefined) await assertMultipart(call.formData, expected.multipart);
  if (expected.body === "absent" || ["GET", "HEAD"].includes(expected.method)) assert.equal(call.body ?? call.formData, undefined, "no body");
  for (const [headerName, headerValue] of Object.entries(expected.headers ?? {})) assert.equal(call.headers[headerName.toLowerCase()], headerValue, `header ${headerName}`);
}

// Repeated keys become arrays, so `tags=a&tags=b` compares as {tags: ["a", "b"]}.
function groupEntries(entries) {
  const grouped = {};
  for (const [name, value] of entries) grouped[name] = Object.hasOwn(grouped, name) ? [grouped[name]].flat().concat(value) : value;
  return grouped;
}

function withoutAuthQuery(contract, queryEntries) {
  const auth = contract.restSpec.auth;
  return auth.type === "query" ? queryEntries.filter(([queryName]) => queryName !== auth.param) : queryEntries;
}

async function assertMultipart(formData, expectedFields) {
  assert.ok(formData instanceof FormData, "multipart body");
  for (const [fieldName, expectedValue] of Object.entries(expectedFields)) {
    const fieldValue = formData.get(fieldName);
    assert.equal(fieldValue instanceof Blob ? fieldValue.name : fieldValue, expectedValue, `multipart field ${fieldName} (files compare by name)`);
  }
}

function assertAuthPlacement(contract, operation, call) {
  const { auth } = contract.restSpec;
  const credential = contract.credential;
  const authChecks = {
    none: () => assert.equal(call.headers.authorization, undefined, "no credential is sent"),
    bearer: () => assert.equal(call.headers.authorization, `Bearer ${credential}`),
    oauth2: () => assert.equal(call.headers.authorization, `Bearer ${FAKE_CREDENTIAL}`),
    header: () => assert.equal(call.headers[auth.header.toLowerCase()], `${auth.prefix ?? ""}${credential}`),
    query: () => assert.equal(new URL(call.url).searchParams.get(auth.param), credential),
    basic: () => assert.match(Buffer.from(String(call.headers.authorization).replace(/^Basic /, ""), "base64").toString(), new RegExp(credential)),
    custom: () => contract.checkAuth(call, credential),
  };
  if (operation.sendCredential === false) return authChecks.none();
  authChecks[auth.type]();
}

// --- input validation ------------------------------------------------------------------------------

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
        if (isMultiSegmentParam(operation, paramName)) return assert.equal(escaping.error?.kind, "invalid_input", "dot segments are refused in {+param}");
        assert.ok(escaping.calls[0]?.path.includes("..%2F..%2Fescape"), `"../../escape" must stay one encoded segment, got ${escaping.calls[0]?.path}`);
      },
    }));
}

// --- write safety and tool policy -----------------------------------------------------------------------

function usesIdempotencyKey(contract, operation) {
  return operation.write === "unsafe" && !["GET", "HEAD"].includes(operation.method) && Boolean(operation.idempotencyKeyHeader ?? contract.restSpec.idempotencyKeyHeader);
}

function writeSafetyTests(contract, operation) {
  const { args } = contract.operationCases[operation.name];
  const failThenSucceed = () => [serverFailure(), ...successResponses(contract, operation)];
  if (usesIdempotencyKey(contract, operation)) {
    const headerName = String(operation.idempotencyKeyHeader ?? contract.restSpec.idempotencyKeyHeader).toLowerCase();
    return [{
      name: `${operation.name} (unsafe, ${headerName}) is retried after a 5xx with the same key`,
      run: async () => {
        const { error, calls } = await runContractOperation(contract, operation.name, args, { responses: failThenSucceed() });
        if (error) throw error;
        assert.ok(calls[0].headers[headerName], "the key is sent");
        assert.equal(calls[1].headers[headerName], calls[0].headers[headerName], "the same key on the retry");
      },
    }];
  }
  if (operation.write === "unsafe") {
    return [{
      name: `${operation.name} (unsafe) is never retried after a 5xx and says the outcome is unknown`,
      run: async () => {
        const { error, calls } = await runContractOperation(contract, operation.name, args, { responses: failThenSucceed() });
        assert.equal(calls.length, 1, "exactly one attempt");
        assert.equal(error?.retryable, false, "not retryable");
        assert.match(error.message, /outcome unknown/);
        if (operation.checkHint) assert.ok(error.message.includes(`To check: ${operation.checkHint}`), "the checkHint is in the message");
      },
    }];
  }
  if (operation.job || operation.response?.binary || contract.restSpec.maxRetries === 0) return [];
  return [{
    name: `${operation.name} (${operation.write}) is retried after a 5xx`,
    run: async () => {
      const { error, calls } = await runContractOperation(contract, operation.name, args, { responses: failThenSucceed() });
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

// --- redaction and errors -----------------------------------------------------------------------------------

function pickPlainOperation(contract) {
  return contract.casedOperations.find((operation) => !operation.job && !operation.response?.binary && !operation.nodeOnly) ?? contract.casedOperations.find((operation) => !operation.job && !operation.response?.binary);
}

function redactionTests(contract) {
  const operation = pickPlainOperation(contract);
  if (!contract.credential || !operation) return [];
  const { args } = contract.operationCases[operation.name];
  const echoedMessage = `invalid credential ${contract.credential}`;
  const echoingErrorBody = { message: echoedMessage, error: { message: echoedMessage, code: echoedMessage }, error_description: echoedMessage, detail: echoedMessage, description: echoedMessage, reason: echoedMessage };
  const dataPath = operation.response?.dataPath;
  const echoingBody = dataPath ? writePath({ contract_echo: contract.credential }, dataPath, [{ echo: contract.credential }]) : { contract_echo: contract.credential };
  const echoingLink = `<${contract.baseUrlFor(operation).href.replace(/\/$/, "")}/contract?page=2&key=${contract.credential}>; rel="next"`;
  return [
    {
      name: "redacts the credential from API errors",
      run: async () => {
        const { error } = await runContractOperation(contract, operation.name, args, { responses: [{ status: 400, body: echoingErrorBody }] });
        assert.ok(error, "the 400 response fails the operation");
        assert.equal(error.message.includes(contract.credential), false, `credential leaked: ${error.message}`);
      },
    },
    {
      name: `${operation.name} redacts a credential echoed in a 200 body and Link header`,
      run: async () => {
        const { output, error } = await runContractOperation(contract, operation.name, args, { responses: [{ body: echoingBody, headers: { link: echoingLink } }] });
        if (error) throw error;
        assert.equal(JSON.stringify(output).includes(contract.credential), false, `credential leaked: ${JSON.stringify(output).slice(0, 300)}`);
      },
    },
  ];
}

function errorMappingTests(contract) {
  const errors = contract.restSpec.errors;
  const operation = pickPlainOperation(contract);
  if (!errors || !operation) return [];
  const { args } = contract.operationCases[operation.name];
  const tests = [];
  const messagePath = [errors.messagePath ?? []].flat()[0];
  if (messagePath) tests.push(messageMappingTest(contract, operation, args, messagePath));
  if (errors.okPath !== undefined) {
    const notOkBody = writePath({}, errors.okPath, errors.okValue === false ? true : false);
    if (messagePath) writePath(notOkBody, messagePath, CONTRACT_ERROR_MESSAGE);
    tests.push(errorIn2xxTest(contract, operation, args, "okPath", notOkBody));
  }
  if (errors.errorPath !== undefined) {
    const errorBody = writePath({}, errors.errorPath, true);
    if (messagePath && messagePath !== errors.errorPath) writePath(errorBody, messagePath, CONTRACT_ERROR_MESSAGE);
    tests.push(errorIn2xxTest(contract, operation, args, "errorPath", errorBody));
  }
  return tests;
}

function messageMappingTest(contract, operation, args, messagePath) {
  const errors = contract.restSpec.errors;
  const [mappedCode, mappedKind] = Object.entries(errors.kindByCode ?? {}).find(([, kind]) => !RETRIED_KINDS.has(kind)) ?? [];
  const errorBody = writePath({}, messagePath, CONTRACT_ERROR_MESSAGE);
  if (mappedCode !== undefined && errors.codePath) writePath(errorBody, errors.codePath, mappedCode);
  return {
    name: `maps API errors: messagePath${mappedCode !== undefined && errors.codePath ? ` and kindByCode ${mappedCode} -> ${mappedKind}` : ""}`,
    run: async () => {
      const { error } = await runContractOperation(contract, operation.name, args, { responses: [{ status: 400, body: errorBody }] });
      assert.ok(error?.message.includes(CONTRACT_ERROR_MESSAGE), `message from ${messagePath}: ${error?.message}`);
      if (mappedCode !== undefined && errors.codePath) assert.equal(error.kind, mappedKind);
    },
  };
}

function errorIn2xxTest(contract, operation, args, detector, errorBody) {
  return {
    name: `detects an error inside a 200 response (${detector})`,
    run: async () => {
      const { error } = await runContractOperation(contract, operation.name, args, { responses: [{ body: errorBody }] });
      assert.ok(error, `a 200 with ${JSON.stringify(errorBody)} must fail`);
    },
  };
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
