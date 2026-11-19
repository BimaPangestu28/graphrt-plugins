import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineRestPlugin } from "../lib/rest-plugin.mjs";
import { describeRestPluginContract, listContractTestNames } from "../lib/rest-plugin-testing.mjs";
import { DEMO_CONTRACT_CASES } from "./fixtures/demo-contract-cases.mjs";
import { demoSpec } from "./fixtures/demo-rest-spec.mjs";

const demoDefinition = defineRestPlugin(demoSpec());

// The full generated contract for a plugin that uses every feature must pass.
describeRestPluginContract(demoDefinition, DEMO_CONTRACT_CASES);

test("the generated contract covers every promised behaviour", () => {
  const testNames = listContractTestNames(demoDefinition, DEMO_CONTRACT_CASES).join("\n");
  const expectedFragments = [
    "every operation has a contract case",
    "get_item sends GET https://api.example.com/v1/items/i-1 with the credential in place",
    "send_message refuses a missing required `text`",
    "get_item refuses path traversal in `item_id`",
    "redacts the credential from API errors",
    "get_item redacts a credential echoed in a 200 body and Link header",
    "maps API errors: messagePath and kindByCode token_expired -> auth_error",
    "api_request redacts the credential from responses",
    "api_request refuses POST as an agent tool",
    "send_message (unsafe) is never retried after a 5xx",
    "list_offsets (idempotent) is retried after a 5xx",
    "delete_item is not offered as an agent tool",
    "search_items needs DEMO_TOOL_ALLOW_SEARCH=1 as an agent tool",
    "list_cursor maps limit/cursor (cursor pagination)",
    "list_links maps limit/cursor (link pagination)",
    "list_pages maps limit/cursor (page pagination)",
    "list_offsets maps limit/cursor (offset pagination)",
    "generate_image job: done",
    "generate_image job: failed",
    "generate_image job: timeout",
    "generate_image saves result URLs into $DEMO_OUTPUT_DIR",
    "render_audio saves base64 fields into $DEMO_OUTPUT_DIR",
    "upload_blob sends POST https://api.example.com/v1/blobs with the credential in place",
    "upload_blob (unsafe) is never retried after a 5xx",
    "upload_blob refuses a local `file` when $DEMO_UPLOAD_DIR is unset",
    "upload_blob uploads a local `file` inside $DEMO_UPLOAD_DIR and refuses one outside it or through a symlink",
    "upload_blob refuses a FIFO and a `file` over 4096 bytes",
    "upload_blob refuses a non-https `file` URL",
    "upload_blob redacts a credential echoed in the upload response",
  ];
  for (const expectedFragment of expectedFragments) assert.ok(testNames.includes(expectedFragment), `missing generated test: ${expectedFragment}`);
});

test("custom auth requires checkAuth, so the credential placement is always tested", () => {
  const customDefinition = defineRestPlugin(demoSpec({ auth: { type: "custom", env: "DEMO_TOKEN", authorize: () => [] } }));
  assert.throws(() => listContractTestNames(customDefinition, DEMO_CONTRACT_CASES), /checkAuth/);
});

test("error-in-2xx detectors and checkHint get generated tests", () => {
  const okDefinition = defineRestPlugin(demoSpec({ errors: { okPath: "ok", errorPath: "failure", messagePath: "description" } }));
  const testNames = listContractTestNames(okDefinition, DEMO_CONTRACT_CASES);
  assert.ok(testNames.includes("detects an error inside a 200 response (okPath)"));
  assert.ok(testNames.includes("detects an error inside a 200 response (errorPath)"));
});

function runFixtureVariant(variant) {
  const fixturePath = fileURLToPath(new URL("./fixtures/contract-fixture-runner.mjs", import.meta.url));
  // NODE_TEST_CONTEXT would make the child report to this runner instead of printing TAP.
  const { NODE_TEST_CONTEXT, ...parentEnvironment } = process.env;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", fixturePath], {
    encoding: "utf8",
    env: { ...parentEnvironment, CONTRACT_FIXTURE_VARIANT: variant },
  });
}

for (const [variant, failingTest] of [
  ["wrong-path", "get_item sends GET https://api.example.com/v1/items/WRONG"],
  ["missing-case", "every operation has a contract case"],
  ["wrong-json", "send_message sends POST"],
  ["wrong-query", "list_cursor sends GET"],
  ["wrong-data", "get_item sends GET"],
  ["wrong-file", "upload_blob sends POST"],
]) {
  test(`the generated contract fails for a ${variant} case`, () => {
    const fixtureRun = runFixtureVariant(variant);
    assert.notEqual(fixtureRun.status, 0, fixtureRun.stdout);
    const failedLines = fixtureRun.stdout.split("\n").filter((line) => /^\s*not ok/.test(line));
    assert.ok(failedLines.some((line) => line.includes(failingTest)), `expected "${failingTest}" to fail:\n${failedLines.join("\n")}`);
  });
}

test("an incomplete case (no request.query) stops the contract with a clear error", () => {
  const fixtureRun = runFixtureVariant("missing-query");
  assert.notEqual(fixtureRun.status, 0);
  assert.match(fixtureRun.stdout + fixtureRun.stderr, /request\.query is required/);
});
