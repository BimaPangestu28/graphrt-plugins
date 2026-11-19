import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { decodePathRepeatedly, normalizeApiPath } from "../lib/tool-path-policy.mjs";
import { pluginDefinition } from "../definition.mjs";

const environment = { GITLAB_TOKEN: "glpat-test" };

async function callApiRequest(args, source) {
  const recordingFetch = createRecordingFetch([{ body: [] }]);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const result = await run("api_request", args, { source });
  return { result, calls: recordingFetch.calls };
}

test("decodePathRepeatedly undoes single and double percent-encoding and keeps malformed input", () => {
  assert.equal(decodePathRepeatedly("a%2Fb"), "a/b");
  assert.equal(decodePathRepeatedly("a%252Fb"), "a/b");
  assert.equal(decodePathRepeatedly("bad%E0%A4%A"), "bad%E0%A4%A");
});

test("normalizeApiPath resolves dot segments, backslashes, case and format suffixes", () => {
  const gitlabOptions = { encodedSlashes: "opaque", stripFormatSuffix: true };
  assert.equal(normalizeApiPath("/projects/42/./VARIABLES.json?x=1", gitlabOptions), "/projects/42/variables");
  assert.equal(normalizeApiPath("/projects/42/issues/../%5Cvariables", gitlabOptions), "/projects/42/{encoded}");
  assert.equal(normalizeApiPath("/projects/42/issues/../%5Cvariables"), "/projects/42/variables");
  assert.equal(normalizeApiPath("/projects/group%2Fapp/issues", gitlabOptions), "/projects/{encoded}/issues");
  assert.equal(normalizeApiPath("/v10/projects/web%2Fenv"), "/v10/projects/web/env");
  assert.equal(normalizeApiPath("/a/%2e%2e/b"), "/b");
});

const BLOCKED_PATHS = [
  "/projects/42/variables",
  "/projects/42/variables.json",
  "/projects/42/./variables",
  "/projects/42/variables%2F",
  "/projects/42/%5Cvariables",
  "/projects/42/%2576ariables",
  "/projects/group%2Fapp/variables/API_KEY",
  "/groups/7/variables",
  "/admin/ci/variables",
  "/projects/42/triggers",
  "/projects/42/pipeline_schedules/1",
  "/projects/42/pipeline_schedules/1.json",
  "/projects/42/pipelines/9/variables",
  "/projects/42/secure_files/1/download",
  "/projects/42/terraform/state/prod",
  "/projects/42/deploy_tokens",
  "/groups/7/deploy_tokens",
  "/projects/42/hooks",
  "/groups/7/hooks",
  "/runners/5",
  "/projects/42/runners",
  "/projects/42/jobs/5/trace",
  "/projects/42/jobs/5/artifacts",
  "/projects/42/jobs/artifacts/main/download",
  "/projects/42/packages",
  "/projects/42/access_tokens",
  "/personal_access_tokens",
];
for (const blockedPath of BLOCKED_PATHS) {
  test(`tools cannot reach ${blockedPath} through api_request`, async () => {
    await assert.rejects(callApiRequest({ path: blockedPath }, "tool"), (error) => error.kind === "permission_denied");
  });
}

const ALLOWED_PATHS = [
  "/user",
  "/projects",
  "/projects/group%2Fapp",
  "/projects/42/issues/12/notes",
  "/projects/42/merge_requests/3/diffs",
  "/projects/42/pipelines/9/jobs",
  "/projects/42/jobs/77",
  "/projects/42/repository/files/src%2Fapp.rb/raw?ref=main",
  "/projects/42/repository/commits/abc123/diff",
  "/projects/42/repository/branches",
  "/projects/42/repository/tags/v1.2.0",
  "/projects/42/releases",
  "/groups/7/projects",
  "/projects/42/issues.json",
];
for (const allowedPath of ALLOWED_PATHS) {
  test(`tools may read ${allowedPath} through api_request`, async () => {
    const { calls } = await callApiRequest({ path: allowedPath }, "tool");
    assert.equal(calls.length, 1);
  });
}

test("workflow nodes may still reach any path, e.g. CI/CD variables", async () => {
  const { calls } = await callApiRequest({ path: "/projects/42/variables" }, "node");
  assert.equal(calls[0].url, "https://gitlab.com/api/v4/projects/42/variables");
});

test("GITLAB_TOOL_API_EXTRA_PATHS adds read paths for tools, with * for one segment", async () => {
  const recordingFetch = createRecordingFetch([{ body: [] }]);
  const run = createOperationRunner(pluginDefinition, { ...environment, GITLAB_TOOL_API_EXTRA_PATHS: "/projects/*/environments, /version" }, { fetchImpl: recordingFetch });
  await run("api_request", { path: "/projects/42/environments" }, { source: "tool" });
  assert.equal(recordingFetch.calls.length, 1);
  await assert.rejects(run("api_request", { path: "/projects/42/environments/1/variables" }, { source: "tool" }), (error) => error.kind === "permission_denied");
  await assert.rejects(run("api_request", { path: "/projects/42/variables" }, { source: "tool" }), (error) => error.kind === "permission_denied");
});
