/**
 * Generated contract tests for declarative REST plugins (rest-plugin.mjs).
 *
 * `describeRestPluginContract(pluginDefinition, cases)` registers node:test tests that check, for every operation:
 * the request (full URL literal, exact query, exact body, headers) and the credential's placement, optional
 * expected data; refusal of missing required params and of path traversal; redaction of the credential from
 * errors, 200 bodies, Link headers and `api_request` responses; the declared error mapping (messagePath,
 * kindByCode, okPath, errorPath); no retry of unsafe writes after a 5xx with the unknown-outcome note and
 * checkHint (or a retry with the same Idempotency-Key); retries for reads and idempotent writes; nodeOnly and
 * `toolPolicy` refusals; `api_request` POST refused for tools; limit/cursor pagination for every style; jobs that
 * finish, fail and time out; and downloads into the output directory.
 *
 * Only tests import this module (it imports node:test). The case format is in docs/declarative-plugins.md.
 */
import { after, describe, test } from "node:test";
import { rmSync } from "node:fs";
import { createContractContext } from "./rest-contract-context.mjs";
import { buildFlowTests } from "./rest-contract-flow-tests.mjs";
import { buildRequestTests } from "./rest-contract-request-tests.mjs";

export { CONTRACT_FILE_HOST } from "./rest-contract-context.mjs";

/**
 * Registers the generated contract tests in a `describe` block named after the plugin.
 *
 * @param pluginDefinition - Definition returned by defineRestPlugin (object)
 * @param cases - Contract cases (object)
 * @param cases.operations - `{operationName: {args, request, response?, expect?: {data}}}` where request is
 *   `{method, url, query, json | form | text | multipart | body: "absent", headers?}`: `url` is the literal
 *   origin + path (no query), `query` the exact query (auth param excluded; repeated keys as arrays) or "absent";
 *   non-GET requests name their body exactly (object)
 * @param cases.environment - Extra env for every run; fake credentials are filled in by default (object, optional)
 * @param cases.checkAuth - `(call, credential) => void`, required for `custom` auth (function)
 * @returns Nothing; tests are registered with node:test
 * @throws Error - Custom auth without checkAuth, or an incomplete case
 *
 * @example
 * describeRestPluginContract(pluginDefinition, {
 *   operations: { get_forecast: { args: { latitude: 1, longitude: 2 },
 *     request: { method: "GET", url: "https://api.open-meteo.com/v1/forecast", query: { latitude: "1", longitude: "2" } } } },
 * });
 */
export function describeRestPluginContract(pluginDefinition, cases) {
  const contract = createContractContext(pluginDefinition, cases);
  describe(`${pluginDefinition.name} REST contract`, () => {
    after(() => rmSync(contract.scratchDirectory, { recursive: true, force: true }));
    for (const contractTest of buildContractTests(contract)) test(contractTest.name, contractTest.run);
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
  const contract = createContractContext(pluginDefinition, cases);
  try {
    return buildContractTests(contract).map((contractTest) => contractTest.name);
  } finally {
    rmSync(contract.scratchDirectory, { recursive: true, force: true });
  }
}

function buildContractTests(contract) {
  return [...buildRequestTests(contract), ...buildFlowTests(contract)];
}
