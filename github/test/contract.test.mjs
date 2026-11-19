import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.github.com";
const REPO = `${API}/repos/octo/hello`;

describeRestPluginContract(pluginDefinition, {
  environment: { GITHUB_TOOL_ALLOWED_REPOS: "*" },
  operations: {
    get_authenticated_user: {
      args: {},
      request: { method: "GET", url: `${API}/user`, query: "absent" },
      response: { body: { login: "octo" } },
      expect: { data: { login: "octo" } },
    },
    list_my_repos: {
      args: { visibility: "private", limit: 50 },
      request: { method: "GET", url: `${API}/user/repos`, query: { visibility: "private", sort: "updated", per_page: "50" } },
    },
    list_org_repos: {
      args: { org: "acme", repo_type: "sources", direction: "asc" },
      request: { method: "GET", url: `${API}/orgs/acme/repos`, query: { type: "sources", sort: "updated", direction: "asc" } },
    },
    get_repo: { args: { owner: "octo", repo: "hello" }, request: { method: "GET", url: REPO, query: "absent" } },
    get_contents: {
      args: { owner: "octo", repo: "hello", file_path: "src/lib/main file.js", ref: "dev" },
      request: { method: "GET", url: `${REPO}/contents/src/lib/main%20file.js`, query: { ref: "dev" } },
    },
    create_or_update_file: {
      args: { owner: "octo", repo: "hello", file_path: "docs/a.md", message: "Add a", content: "aGk=", sha: "abc" },
      request: { method: "PUT", url: `${REPO}/contents/docs/a.md`, query: "absent", json: { message: "Add a", content: "aGk=", sha: "abc" } },
    },
    list_issues: {
      args: { owner: "octo", repo: "hello", labels: ["bug", "p1"], assignee: "none" },
      request: { method: "GET", url: `${REPO}/issues`, query: { state: "open", labels: "bug,p1", assignee: "none" } },
    },
    get_issue: { args: { owner: "octo", repo: "hello", issue_number: 7 }, request: { method: "GET", url: `${REPO}/issues/7`, query: "absent" } },
    create_issue: {
      args: { owner: "octo", repo: "hello", issue_title: "Crash", body: "Steps", assignees: ["octo"], labels: ["bug"], issue_type: "Bug" },
      request: { method: "POST", url: `${REPO}/issues`, query: "absent", json: { title: "Crash", body: "Steps", assignees: ["octo"], labels: ["bug"], type: "Bug" } },
    },
    update_issue: {
      args: { owner: "octo", repo: "hello", issue_number: 7, state: "closed", state_reason: "completed" },
      request: { method: "PATCH", url: `${REPO}/issues/7`, query: "absent", json: { state: "closed", state_reason: "completed" } },
    },
    list_issue_comments: {
      args: { owner: "octo", repo: "hello", issue_number: 7, since: "2026-11-01T00:00:00Z" },
      request: { method: "GET", url: `${REPO}/issues/7/comments`, query: { since: "2026-11-01T00:00:00Z" } },
    },
    create_issue_comment: {
      args: { owner: "octo", repo: "hello", issue_number: 7, body: "Thanks!" },
      request: { method: "POST", url: `${REPO}/issues/7/comments`, query: "absent", json: { body: "Thanks!" } },
    },
    list_pulls: {
      args: { owner: "octo", repo: "hello", base: "main", state: "all" },
      request: { method: "GET", url: `${REPO}/pulls`, query: { state: "all", base: "main" } },
    },
    get_pull: { args: { owner: "octo", repo: "hello", pull_number: 3 }, request: { method: "GET", url: `${REPO}/pulls/3`, query: "absent" } },
    list_pull_files: { args: { owner: "octo", repo: "hello", pull_number: 3 }, request: { method: "GET", url: `${REPO}/pulls/3/files`, query: "absent" } },
    create_pull: {
      args: { owner: "octo", repo: "hello", pr_title: "Fix", head: "fix-1", base: "main", draft: true },
      request: { method: "POST", url: `${REPO}/pulls`, query: "absent", json: { title: "Fix", head: "fix-1", base: "main", draft: true } },
    },
    list_pull_review_comments: {
      args: { owner: "octo", repo: "hello", pull_number: 3, sort: "created" },
      request: { method: "GET", url: `${REPO}/pulls/3/comments`, query: { sort: "created" } },
    },
    create_pull_review_comment: {
      args: { owner: "octo", repo: "hello", pull_number: 3, body: "Nit", commit_id: "sha1", path: "a.js", line: 4, side: "RIGHT" },
      request: { method: "POST", url: `${REPO}/pulls/3/comments`, query: "absent", json: { body: "Nit", commit_id: "sha1", path: "a.js", line: 4, side: "RIGHT" } },
    },
    merge_pull: {
      args: { owner: "octo", repo: "hello", pull_number: 3, merge_method: "squash", sha: "sha1" },
      request: { method: "PUT", url: `${REPO}/pulls/3/merge`, query: "absent", json: { merge_method: "squash", sha: "sha1" } },
    },
    search_code: {
      args: { q: "parseConfig repo:octo/hello", limit: 10 },
      request: { method: "GET", url: `${API}/search/code`, query: { q: "parseConfig repo:octo/hello", per_page: "10" } },
      response: { body: { total_count: 1, items: [{ path: "a.js" }] } },
      expect: { data: [{ path: "a.js" }] },
    },
    search_issues: {
      args: { q: "repo:octo/hello is:pr is:open", sort: "updated", advanced_search: true },
      request: { method: "GET", url: `${API}/search/issues`, query: { q: "repo:octo/hello is:pr is:open", sort: "updated", advanced_search: "true" } },
    },
    list_releases: { args: { owner: "octo", repo: "hello" }, request: { method: "GET", url: `${REPO}/releases`, query: "absent" } },
    get_latest_release: { args: { owner: "octo", repo: "hello" }, request: { method: "GET", url: `${REPO}/releases/latest`, query: "absent" } },
    get_release: { args: { owner: "octo", repo: "hello", release_id: 99 }, request: { method: "GET", url: `${REPO}/releases/99`, query: "absent" } },
    create_release: {
      args: { owner: "octo", repo: "hello", tag_name: "v1.0.0", generate_release_notes: true },
      request: { method: "POST", url: `${REPO}/releases`, query: "absent", json: { tag_name: "v1.0.0", generate_release_notes: true } },
    },
    delete_release: { args: { owner: "octo", repo: "hello", release_id: 99 }, request: { method: "DELETE", url: `${REPO}/releases/99`, query: "absent", body: "absent" } },
    list_workflow_runs: {
      args: { owner: "octo", repo: "hello", branch: "main", status: "failure" },
      request: { method: "GET", url: `${REPO}/actions/runs`, query: { branch: "main", status: "failure" } },
      response: { body: { total_count: 1, workflow_runs: [{ id: 5 }] } },
      expect: { data: [{ id: 5 }] },
    },
    get_workflow_run: { args: { owner: "octo", repo: "hello", run_id: 5 }, request: { method: "GET", url: `${REPO}/actions/runs/5`, query: "absent" } },
    rerun_workflow_run: {
      args: { owner: "octo", repo: "hello", run_id: 5 },
      request: { method: "POST", url: `${REPO}/actions/runs/5/rerun`, query: "absent", json: {} },
    },
    rerun_failed_jobs: {
      args: { owner: "octo", repo: "hello", run_id: 5, enable_debug_logging: false },
      request: { method: "POST", url: `${REPO}/actions/runs/5/rerun-failed-jobs`, query: "absent", json: { enable_debug_logging: false } },
    },
    list_notifications: {
      args: { all: true, participating: false },
      request: { method: "GET", url: `${API}/notifications`, query: { all: "true", participating: "false" } },
    },
    mark_notification_read: {
      args: { thread_id: "123" },
      request: { method: "PATCH", url: `${API}/notifications/threads/123`, query: "absent", body: "absent" },
    },
  },
});

async function runAsTool(operationName, args, responses, environment = { GITHUB_TOKEN: "ghp_test" }) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source: "tool" }), calls: recordingFetch.calls };
}

test("every request sends the 2026-03-10 API version and the GitHub JSON media type", async () => {
  const { calls } = await runAsTool("get_repo", { owner: "octo", repo: "hello" }, [{ body: { id: 1 } }]);
  assert.equal(calls[0].headers["x-github-api-version"], "2026-03-10");
  assert.equal(calls[0].headers.accept, "application/vnd.github+json");
  assert.equal(calls[0].headers.authorization, "Bearer ghp_test");
});

test("the Link header's next page becomes next_cursor and is followed as is", async () => {
  const nextUrl = `${REPO}/issues?state=open&per_page=2&page=2`;
  const firstPage = await runAsTool("list_issues", { owner: "octo", repo: "hello", limit: 2 }, [
    { body: [{ number: 1 }, { number: 2 }], headers: { link: `<${nextUrl}>; rel="next", <${REPO}/issues?page=9>; rel="last"` } },
  ]);
  assert.equal(firstPage.result.next_cursor, nextUrl);
  const secondPage = await runAsTool("list_issues", { owner: "octo", repo: "hello", cursor: nextUrl }, [{ body: [{ number: 3 }] }]);
  assert.equal(secondPage.calls[0].url, nextUrl);
  assert.equal(secondPage.result.next_cursor, null);
});

test("merges, file commits, releases and deletes are node only; writes are opt-in for tools", () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = new Set(manifest.tools.map((tool) => tool.name));
  for (const nodeOnlyName of ["merge_pull", "create_or_update_file", "create_release", "delete_release"]) assert.equal(toolNames.has(nodeOnlyName), false, nodeOnlyName);
  const optInNames = pluginDefinition.restSpec.operations.filter((operation) => operation.toolPolicy).map((operation) => operation.name).sort();
  assert.deepEqual(optInNames, [
    "create_issue", "create_issue_comment", "create_pull", "create_pull_review_comment", "mark_notification_read", "rerun_failed_jobs", "rerun_workflow_run", "update_issue",
  ]);
});

test("a comment from a tool is refused without GITHUB_TOOL_ALLOW_WRITE and sent with it", async () => {
  const args = { owner: "octo", repo: "hello", issue_number: 7, body: "hi" };
  await assert.rejects(runAsTool("create_issue_comment", args, []), (error) => error.kind === "permission_denied" && error.message.includes("GITHUB_TOOL_ALLOW_WRITE"));
  const { calls } = await runAsTool("create_issue_comment", args, [{ status: 201, body: { id: 1 } }], { GITHUB_TOKEN: "ghp_test", GITHUB_TOOL_ALLOW_WRITE: "1", GITHUB_TOOL_ALLOWED_REPOS: "octo/hello" });
  assert.equal(calls.length, 1);
});

test("GitHub's {message} error body is surfaced with the status kind", async () => {
  await assert.rejects(
    runAsTool("get_repo", { owner: "octo", repo: "missing" }, [{ status: 404, body: { message: "Not Found", documentation_url: "https://docs.github.com/rest" } }]),
    (error) => error.kind === "not_found" && error.message.includes("Not Found"),
  );
});

test("a file path with .. segments is refused before any request", async () => {
  await assert.rejects(runAsTool("get_contents", { owner: "octo", repo: "hello", file_path: "src/../../secrets" }, []), (error) => error.kind === "invalid_input");
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
