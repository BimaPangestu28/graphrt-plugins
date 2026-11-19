import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition, resolveSentryApiUrl } from "../definition.mjs";

const API = "https://us.sentry.io/api/0";
const ORG = `${API}/organizations/acme`;
const ISSUE = `${ORG}/issues/4021/`;
const issue = { organization: "acme", issue_id: "4021" };

describeRestPluginContract(pluginDefinition, {
  operations: {
    list_organizations: { args: { owner: true }, request: { method: "GET", url: `${API}/organizations/`, query: { owner: "true" } } },
    list_projects: { args: { organization: "acme", limit: 50 }, request: { method: "GET", url: `${ORG}/projects/`, query: { per_page: "50" } } },
    list_releases: {
      args: { organization: "acme", project: "11", environment: ["production"] },
      request: { method: "GET", url: `${ORG}/releases/`, query: { project: "11", environment: "production" } },
    },
    list_issues: {
      args: { organization: "acme", project: ["web", "api"], stats_period: "24h", sort: "freq" },
      request: { method: "GET", url: `${ORG}/issues/`, query: { query: "is:unresolved", project: ["web", "api"], statsPeriod: "24h", sort: "freq", limit: "25" } },
      response: { body: [{ id: "4021", title: "TypeError" }] },
      expect: { data: [{ id: "4021", title: "TypeError" }] },
    },
    get_issue: { args: issue, request: { method: "GET", url: ISSUE, query: "absent" } },
    list_issue_events: { args: { ...issue, full: true }, request: { method: "GET", url: `${ISSUE}events/`, query: { full: "true" } } },
    get_issue_event: { args: { ...issue, event_id: "latest" }, request: { method: "GET", url: `${ISSUE}events/latest/`, query: "absent" } },
    list_project_events: { args: { organization: "acme", project: "web", stats_period: "1h" }, request: { method: "GET", url: `${API}/projects/acme/web/events/`, query: { statsPeriod: "1h" } } },
    get_project_event: {
      args: { organization: "acme", project: "web", event_id: "9fac2ceed9344f2bbfdd1fdacb0ed9b1" },
      request: { method: "GET", url: `${API}/projects/acme/web/events/9fac2ceed9344f2bbfdd1fdacb0ed9b1/`, query: "absent" },
    },
    update_issue: { args: { ...issue, assigned_to: "user:7", priority: "high" }, request: { method: "PUT", url: ISSUE, query: "absent", json: { assignedTo: "user:7", priority: "high" } } },
    resolve_issue: { args: { ...issue, in_next_release: true }, request: { method: "PUT", url: ISSUE, query: "absent", json: { status: "resolved", statusDetails: { inNextRelease: true } } } },
    ignore_issue: {
      args: { ...issue, substatus: "archived_until_condition_met", ignore_duration: 60 },
      request: { method: "PUT", url: ISSUE, query: "absent", json: { status: "ignored", substatus: "archived_until_condition_met", statusDetails: { ignoreDuration: 60 } } },
    },
    delete_issue: { args: issue, request: { method: "DELETE", url: ISSUE, query: "absent", body: "absent" } },
  },
});

test("SENTRY_REGION selects the us (default) or de data region", () => {
  assert.equal(resolveSentryApiUrl({}), API);
  assert.equal(resolveSentryApiUrl({ SENTRY_REGION: "DE" }), "https://de.sentry.io/api/0");
  assert.throws(() => resolveSentryApiUrl({ SENTRY_REGION: "evil.example#" }), /SENTRY_REGION/);
});

test("Sentry's {detail} error body is shown with the status kind", async () => {
  const run = createOperationRunner(pluginDefinition, { SENTRY_AUTH_TOKEN: "bad" }, { fetchImpl: createRecordingFetch([{ status: 401, body: { detail: "Invalid token" } }]) });
  await assert.rejects(run("list_organizations", {}, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("Invalid token"));
});

test("resolve and ignore are opt-in for tools; delete is node only", async () => {
  const run = createOperationRunner(pluginDefinition, { SENTRY_AUTH_TOKEN: "t" }, { fetchImpl: createRecordingFetch([]) });
  await assert.rejects(run("resolve_issue", issue, { source: "tool" }), (error) => error.kind === "permission_denied" && error.message.includes("SENTRY_TOOL_ALLOW_WRITE"));
  assert.equal(new Set(buildManifest(pluginDefinition).tools.map((tool) => tool.name)).has("delete_issue"), false);
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

for (const blockedPath of ["/projects/acme/web/hooks/", "/projects/acme/web/hooks/abc/", "/projects/acme/web/HOOKS", "/projects/acme/web/%2568ooks/", "/projects/acme/web/x/../hooks/"]) {
  test(`tools cannot reach service hooks (they carry signing secrets) through api_request: ${blockedPath}`, async () => {
    const run = createOperationRunner(pluginDefinition, { SENTRY_AUTH_TOKEN: "t" }, { fetchImpl: createRecordingFetch([{ body: [] }]) });
    await assert.rejects(run("api_request", { path: blockedPath }, { source: "tool" }), (error) => error.kind === "permission_denied");
  });
}

test("other paths stay open to tools through api_request, and nodes may read hooks", async () => {
  const recordingFetch = createRecordingFetch([{ body: [] }, { body: [] }]);
  const run = createOperationRunner(pluginDefinition, { SENTRY_AUTH_TOKEN: "t" }, { fetchImpl: recordingFetch });
  await run("api_request", { path: "/organizations/acme/stats_v2/" }, { source: "tool" });
  await run("api_request", { path: "/projects/acme/web/hooks/" }, { source: "node" });
  assert.equal(recordingFetch.calls.length, 2);
});
