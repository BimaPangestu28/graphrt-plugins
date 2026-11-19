import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ status: 201, body: { id: 1 } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { GITHUB_TOKEN: "ghp_test", ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const commentArgs = { owner: "acme", repo: "api", issue_number: 7, body: "hi" };
const writeAllowed = { GITHUB_TOOL_ALLOW_WRITE: "1" };

test("tool writes need the repository in GITHUB_TOOL_ALLOWED_REPOS", async () => {
  await assert.rejects(run("create_issue_comment", commentArgs, { environment: writeAllowed }), (error) => error.kind === "permission_denied" && error.message.includes("GITHUB_TOOL_ALLOWED_REPOS"));
  await assert.rejects(
    run("create_issue_comment", { ...commentArgs, repo: "public-site" }, { environment: { ...writeAllowed, GITHUB_TOOL_ALLOWED_REPOS: "acme/api" } }),
    (error) => error.kind === "permission_denied" && error.message.includes("acme/public-site"),
  );
  const listed = await run("create_issue_comment", { ...commentArgs, owner: "ACME" }, { environment: { ...writeAllowed, GITHUB_TOOL_ALLOWED_REPOS: "acme/web, acme/api" } });
  assert.equal(listed.calls.length, 1);
  const anyRepo = await run("create_pull", { owner: "o", repo: "r", pr_title: "x", head: "h", base: "main" }, { environment: { ...writeAllowed, GITHUB_TOOL_ALLOWED_REPOS: "*" } });
  assert.equal(anyRepo.calls.length, 1);
});

test("workflow nodes write to any repository without the allowlist", async () => {
  const { calls } = await run("create_issue_comment", commentArgs, { source: "node" });
  assert.equal(calls.length, 1);
});

test("workflow re-runs need GITHUB_TOOL_ALLOW_CI (not the write opt-in) and a listed repository", async () => {
  const rerunArgs = { owner: "acme", repo: "api", run_id: 5 };
  await assert.rejects(run("rerun_workflow_run", rerunArgs, { environment: { ...writeAllowed, GITHUB_TOOL_ALLOWED_REPOS: "*" } }), (error) => error.message.includes("GITHUB_TOOL_ALLOW_CI"));
  await assert.rejects(run("rerun_failed_jobs", rerunArgs, { environment: { GITHUB_TOOL_ALLOW_CI: "1" } }), (error) => error.message.includes("GITHUB_TOOL_ALLOWED_REPOS"));
  const { calls } = await run("rerun_failed_jobs", rerunArgs, { environment: { GITHUB_TOOL_ALLOW_CI: "1", GITHUB_TOOL_ALLOWED_REPOS: "acme/api" } });
  assert.equal(calls.length, 1);
});

test("tools may not enable debug logging on re-runs (debug logs can print secrets)", async () => {
  const environment = { GITHUB_TOOL_ALLOW_CI: "1", GITHUB_TOOL_ALLOWED_REPOS: "*" };
  for (const operationName of ["rerun_workflow_run", "rerun_failed_jobs"]) {
    await assert.rejects(run(operationName, { owner: "acme", repo: "api", run_id: 5, enable_debug_logging: true }, { environment }), (error) => error.kind === "permission_denied" && error.message.includes("enable_debug_logging"));
  }
  const { calls } = await run("rerun_workflow_run", { owner: "acme", repo: "api", run_id: 5, enable_debug_logging: true }, { source: "node" });
  assert.deepEqual(calls[0].json, { enable_debug_logging: true });
});

for (const blockedPath of [
  "/repos/o/r/actions/variables",
  "/repos/o/r/actions/variables/API_URL",
  "/repos/o/r/environments/prod/variables",
  "/orgs/acme/actions/variables",
  "/repos/o/r/hooks",
  "/repos/o/r/hooks/1/config",
  "/orgs/acme/hooks",
  "/repos/o/r/actions/%2576ariables",
  "/repos/o/r/x/../hooks",
  "/repos/o/r/HOOKS",
]) {
  test(`tools cannot reach ${blockedPath} through api_request`, async () => {
    await assert.rejects(run("api_request", { path: blockedPath }), (error) => error.kind === "permission_denied");
  });
}

test("other GET paths stay open to tools through api_request", async () => {
  const { calls } = await run("api_request", { path: "/repos/o/r/branches" }, { responses: [{ body: [] }] });
  assert.equal(calls.length, 1);
});
