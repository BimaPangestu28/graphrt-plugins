import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition, resolveGitLabApiUrl } from "../definition.mjs";

const API = "https://gitlab.com/api/v4";
const PROJECT = `${API}/projects/group%2Fapp`;
const project = { project_id: "group/app" };

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls api_request on "/anything" as a tool; the extra-paths env lets that path through.
  environment: { GITLAB_TOOL_ALLOWED_PROJECTS: "*", GITLAB_TOOL_API_EXTRA_PATHS: "/anything" },
  operations: {
    get_current_user: { args: {}, request: { method: "GET", url: `${API}/user`, query: "absent" }, response: { body: { username: "ana" } }, expect: { data: { username: "ana" } } },
    list_projects: {
      args: { search: "api", limit: 20 },
      request: { method: "GET", url: `${API}/projects`, query: { membership: "true", search: "api", simple: "true", per_page: "20" } },
    },
    get_project: { args: project, request: { method: "GET", url: PROJECT, query: "absent" } },
    list_issues: {
      args: { ...project, labels: ["bug", "p1"], assignee_username: "ana" },
      request: { method: "GET", url: `${PROJECT}/issues`, query: { state: "opened", labels: "bug,p1", assignee_username: "ana" } },
    },
    get_issue: { args: { ...project, issue_iid: 12 }, request: { method: "GET", url: `${PROJECT}/issues/12`, query: "absent" } },
    create_issue: {
      args: { ...project, issue_title: "Crash", description: "Steps", labels: "bug,p1", assignee_ids: [5] },
      request: { method: "POST", url: `${PROJECT}/issues`, query: "absent", json: { title: "Crash", description: "Steps", labels: "bug,p1", assignee_ids: [5] } },
    },
    update_issue: {
      args: { ...project, issue_iid: 12, state_event: "close", add_labels: "done" },
      request: { method: "PUT", url: `${PROJECT}/issues/12`, query: "absent", json: { state_event: "close", add_labels: "done" } },
    },
    delete_issue: { args: { ...project, issue_iid: 12 }, request: { method: "DELETE", url: `${PROJECT}/issues/12`, query: "absent", body: "absent" } },
    list_issue_notes: { args: { ...project, issue_iid: 12, sort: "asc" }, request: { method: "GET", url: `${PROJECT}/issues/12/notes`, query: { sort: "asc" } } },
    create_issue_note: {
      args: { ...project, issue_iid: 12, body: "Fixed in !3" },
      request: { method: "POST", url: `${PROJECT}/issues/12/notes`, query: "absent", json: { body: "Fixed in !3" } },
    },
    list_merge_requests: {
      args: { ...project, target_branch: "main", state: "merged" },
      request: { method: "GET", url: `${PROJECT}/merge_requests`, query: { state: "merged", target_branch: "main" } },
    },
    get_merge_request: { args: { ...project, merge_request_iid: 3 }, request: { method: "GET", url: `${PROJECT}/merge_requests/3`, query: "absent" } },
    list_merge_request_diffs: { args: { ...project, merge_request_iid: 3 }, request: { method: "GET", url: `${PROJECT}/merge_requests/3/diffs`, query: "absent" } },
    create_merge_request: {
      args: { ...project, source_branch: "fix", target_branch: "main", mr_title: "Fix crash", remove_source_branch: true },
      request: { method: "POST", url: `${PROJECT}/merge_requests`, query: "absent", json: { source_branch: "fix", target_branch: "main", title: "Fix crash", remove_source_branch: true } },
    },
    list_merge_request_notes: { args: { ...project, merge_request_iid: 3 }, request: { method: "GET", url: `${PROJECT}/merge_requests/3/notes`, query: "absent" } },
    create_merge_request_note: {
      args: { ...project, merge_request_iid: 3, body: "LGTM" },
      request: { method: "POST", url: `${PROJECT}/merge_requests/3/notes`, query: "absent", json: { body: "LGTM" } },
    },
    merge_merge_request: {
      args: { ...project, merge_request_iid: 3, sha: "abc", squash: true },
      request: { method: "PUT", url: `${PROJECT}/merge_requests/3/merge`, query: "absent", json: { sha: "abc", squash: true } },
    },
    list_pipelines: { args: { ...project, ref: "main", status: "failed" }, request: { method: "GET", url: `${PROJECT}/pipelines`, query: { ref: "main", status: "failed" } } },
    get_pipeline: { args: { ...project, pipeline_id: 99 }, request: { method: "GET", url: `${PROJECT}/pipelines/99`, query: "absent" } },
    list_pipeline_jobs: {
      args: { ...project, pipeline_id: 99, scope: ["failed", "canceled"] },
      request: { method: "GET", url: `${PROJECT}/pipelines/99/jobs`, query: { "scope[]": ["failed", "canceled"] } },
    },
    retry_pipeline: { args: { ...project, pipeline_id: 99 }, request: { method: "POST", url: `${PROJECT}/pipelines/99/retry`, query: "absent", body: "absent" } },
    cancel_pipeline: { args: { ...project, pipeline_id: 99 }, request: { method: "POST", url: `${PROJECT}/pipelines/99/cancel`, query: "absent", body: "absent" } },
    create_pipeline: {
      args: { ...project, ref: "main", variables: [{ key: "DEPLOY", value: "1" }] },
      request: { method: "POST", url: `${PROJECT}/pipeline`, query: "absent", json: { ref: "main", variables: [{ key: "DEPLOY", value: "1" }] } },
    },
    get_file: {
      args: { ...project, file_path: "src/app.rb", ref: "main" },
      request: { method: "GET", url: `${PROJECT}/repository/files/src%2Fapp.rb`, query: { ref: "main" } },
    },
    list_repository_tree: {
      args: { ...project, path: "src", recursive: true },
      request: { method: "GET", url: `${PROJECT}/repository/tree`, query: { path: "src", recursive: "true" } },
    },
    create_file: {
      args: { ...project, file_path: "docs/a.md", branch: "main", content: "hi", commit_message: "Add a" },
      request: { method: "POST", url: `${PROJECT}/repository/files/docs%2Fa.md`, query: "absent", json: { branch: "main", content: "hi", commit_message: "Add a" } },
    },
    update_file: {
      args: { ...project, file_path: "docs/a.md", branch: "main", content: "hi2", commit_message: "Edit a", last_commit_id: "c1" },
      request: { method: "PUT", url: `${PROJECT}/repository/files/docs%2Fa.md`, query: "absent", json: { branch: "main", content: "hi2", commit_message: "Edit a", last_commit_id: "c1" } },
    },
  },
});

test("GITLAB_BASE_URL selects a self-hosted instance and strips a trailing slash or /api/v4", () => {
  assert.equal(resolveGitLabApiUrl({}), "https://gitlab.com/api/v4");
  assert.equal(resolveGitLabApiUrl({ GITLAB_BASE_URL: "https://git.example.com/" }), "https://git.example.com/api/v4");
  assert.equal(resolveGitLabApiUrl({ GITLAB_BASE_URL: "https://example.com/gitlab/api/v4" }), "https://example.com/gitlab/api/v4");
});

test("GITLAB_BASE_URL with credentials, a query or no URL at all is refused", () => {
  assert.throws(() => resolveGitLabApiUrl({ GITLAB_BASE_URL: "https://user:pass@git.example.com" }), /credentials/);
  assert.throws(() => resolveGitLabApiUrl({ GITLAB_BASE_URL: "https://git.example.com/?x=1" }), /query/);
  assert.throws(() => resolveGitLabApiUrl({ GITLAB_BASE_URL: "git.example.com" }), /instance URL/);
});

test("a plain-http self-hosted URL is refused at call time with invalid_input", async () => {
  const run = createOperationRunner(pluginDefinition, { GITLAB_TOKEN: "t", GITLAB_BASE_URL: "http://git.example.com" }, { fetchImpl: createRecordingFetch([]) });
  await assert.rejects(run("get_current_user", {}, { source: "node" }), (error) => error.kind === "invalid_input" && /https/.test(error.message));
});

test("calls go to the self-hosted instance with the token as a Bearer header", async () => {
  const recordingFetch = createRecordingFetch([{ body: { id: 1 } }]);
  const run = createOperationRunner(pluginDefinition, { GITLAB_TOKEN: "glpat-x", GITLAB_BASE_URL: "https://git.example.com" }, { fetchImpl: recordingFetch });
  await run("get_project", { project_id: "42" }, { source: "tool" });
  assert.equal(recordingFetch.calls[0].url, "https://git.example.com/api/v4/projects/42");
  assert.equal(recordingFetch.calls[0].headers.authorization, "Bearer glpat-x");
});

test("merges, file commits, new pipelines and deletes are node only", () => {
  const toolNames = new Set(buildManifest(pluginDefinition).tools.map((tool) => tool.name));
  for (const nodeOnlyName of ["merge_merge_request", "create_file", "update_file", "create_pipeline", "delete_issue"]) assert.equal(toolNames.has(nodeOnlyName), false, nodeOnlyName);
  assert.equal(toolNames.has("api_request"), true);
});

test("GitLab's {message} body is shown in errors", async () => {
  const run = createOperationRunner(pluginDefinition, { GITLAB_TOKEN: "bad" }, { fetchImpl: createRecordingFetch([{ status: 401, body: { message: "401 Unauthorized" } }]) });
  await assert.rejects(run("get_current_user", {}, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("401 Unauthorized"));
});

// graphrt reads these keys from a workflow node itself (dsl.rs), so a parameter with one of these names could never
// be set from a node.
test("no parameter uses a key graphrt reserves on workflow nodes", () => {
  const reservedKeys = ["id", "type", "title", "parent", "data", "desc", "position", "width", "height", "timeout", "timeout_ms", "retry", "retry_config", "on_error", "error_strategy", "default_value"];
  for (const operation of pluginDefinition.operations) {
    const clashes = Object.keys(operation.parameters.properties).filter((key) => reservedKeys.includes(key));
    assert.deepEqual(clashes, [], operation.name);
  }
});

async function runAsTool(operationName, args, extraEnvironment) {
  const recordingFetch = createRecordingFetch([{ status: 201, body: { id: 1 } }]);
  const run = createOperationRunner(pluginDefinition, { GITLAB_TOKEN: "t", ...extraEnvironment }, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source: "tool" }), calls: recordingFetch.calls };
}

test("tool writes only reach projects listed in GITLAB_TOOL_ALLOWED_PROJECTS", async () => {
  const noteArgs = { project_id: "group/app", issue_iid: 12, body: "hi" };
  await assert.rejects(runAsTool("create_issue_note", noteArgs, { GITLAB_TOOL_ALLOW_WRITE: "1" }), (error) => error.kind === "permission_denied" && error.message.includes("GITLAB_TOOL_ALLOWED_PROJECTS"));
  await assert.rejects(
    runAsTool("create_issue_note", { ...noteArgs, project_id: "group/other" }, { GITLAB_TOOL_ALLOW_WRITE: "1", GITLAB_TOOL_ALLOWED_PROJECTS: "group/app, 42" }),
    (error) => error.kind === "permission_denied" && error.message.includes("group/other"),
  );
  const listed = await runAsTool("create_issue_note", { ...noteArgs, project_id: "Group/App" }, { GITLAB_TOOL_ALLOW_WRITE: "1", GITLAB_TOOL_ALLOWED_PROJECTS: "group/app, 42" });
  assert.equal(listed.calls.length, 1);
  const anyProject = await runAsTool("create_issue", { project_id: "99", issue_title: "x" }, { GITLAB_TOOL_ALLOW_WRITE: "1", GITLAB_TOOL_ALLOWED_PROJECTS: "*" });
  assert.equal(anyProject.calls.length, 1);
});

test("without the write opt-in the refusal names GITLAB_TOOL_ALLOW_WRITE", async () => {
  await assert.rejects(runAsTool("create_issue", { project_id: "42", issue_title: "x" }, {}), (error) => error.message.includes("GITLAB_TOOL_ALLOW_WRITE"));
});

test("pipeline retry and cancel need GITLAB_TOOL_ALLOW_CI, not the write opt-in", async () => {
  const args = { project_id: "42", pipeline_id: 9 };
  await assert.rejects(runAsTool("retry_pipeline", args, { GITLAB_TOOL_ALLOW_WRITE: "1", GITLAB_TOOL_ALLOWED_PROJECTS: "*" }), (error) => error.message.includes("GITLAB_TOOL_ALLOW_CI"));
  const { calls } = await runAsTool("cancel_pipeline", args, { GITLAB_TOOL_ALLOW_CI: "1", GITLAB_TOOL_ALLOWED_PROJECTS: "42" });
  assert.equal(calls.length, 1);
});

test("workflow nodes write to any project without allowlists", async () => {
  const recordingFetch = createRecordingFetch([{ status: 201, body: { id: 1 } }]);
  const run = createOperationRunner(pluginDefinition, { GITLAB_TOKEN: "t" }, { fetchImpl: recordingFetch });
  await run("create_issue_note", { project_id: "any/project", issue_iid: 1, body: "x" }, { source: "node" });
  assert.equal(recordingFetch.calls.length, 1);
});
