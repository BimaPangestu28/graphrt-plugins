import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition, resolveJiraApiUrl } from "../definition.mjs";

const API = "https://acme.atlassian.net/rest/api/3";
const DEFAULT_FIELDS = "summary,status,assignee,reporter,priority,issuetype,created,updated";
const adfDoc = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] };

describeRestPluginContract(pluginDefinition, {
  environment: { JIRA_SITE_URL: "https://acme.atlassian.net" },
  operations: {
    get_myself: { args: {}, request: { method: "GET", url: `${API}/myself`, query: "absent" }, response: { body: { accountId: "a1" } }, expect: { data: { accountId: "a1" } } },
    search_issues: {
      args: { jql: "project = OPS ORDER BY updated DESC", limit: 25 },
      request: { method: "GET", url: `${API}/search/jql`, query: { jql: "project = OPS ORDER BY updated DESC", fields: DEFAULT_FIELDS, maxResults: "25" } },
      response: { body: { issues: [{ key: "OPS-1" }], nextPageToken: "tok2", isLast: false } },
      expect: { data: [{ key: "OPS-1" }] },
    },
    get_issue: { args: { issue_key: "OPS-1", fields: ["summary", "status"] }, request: { method: "GET", url: `${API}/issue/OPS-1`, query: { fields: "summary,status" } } },
    create_issue: {
      args: { project_key: "OPS", issue_type: "Bug", summary: "Crash", description: adfDoc, labels: ["prod"], priority: "High" },
      request: {
        method: "POST",
        url: `${API}/issue`,
        query: "absent",
        json: { fields: { project: { key: "OPS" }, issuetype: { name: "Bug" }, summary: "Crash", description: adfDoc, labels: ["prod"], priority: { name: "High" } } },
      },
    },
    update_issue: {
      args: { issue_key: "OPS-1", summary: "Crash on login", assignee_account_id: "a1", notify_users: false },
      request: { method: "PUT", url: `${API}/issue/OPS-1`, query: { notifyUsers: "false" }, json: { fields: { summary: "Crash on login", assignee: { accountId: "a1" } } } },
    },
    delete_issue: { args: { issue_key: "OPS-1", delete_subtasks: true }, request: { method: "DELETE", url: `${API}/issue/OPS-1`, query: { deleteSubtasks: "true" }, body: "absent" } },
    assign_issue: { args: { issue_key: "OPS-1", account_id: "a1" }, request: { method: "PUT", url: `${API}/issue/OPS-1/assignee`, query: "absent", json: { accountId: "a1" } } },
    list_transitions: {
      args: { issue_key: "OPS-1" },
      request: { method: "GET", url: `${API}/issue/OPS-1/transitions`, query: "absent" },
      response: { body: { transitions: [{ id: "31", name: "Done" }] } },
      expect: { data: [{ id: "31", name: "Done" }] },
    },
    transition_issue: {
      args: { issue_key: "OPS-1", transition_id: "31", resolution: "Done" },
      request: { method: "POST", url: `${API}/issue/OPS-1/transitions`, query: "absent", json: { transition: { id: "31" }, fields: { resolution: { name: "Done" } } } },
    },
    list_comments: {
      args: { issue_key: "OPS-1", order_by: "-created", limit: 10 },
      request: { method: "GET", url: `${API}/issue/OPS-1/comment`, query: { orderBy: "-created", maxResults: "10" } },
    },
    add_comment: { args: { issue_key: "OPS-1", body: adfDoc }, request: { method: "POST", url: `${API}/issue/OPS-1/comment`, query: "absent", json: { body: adfDoc } } },
    list_projects: { args: { query: "ops" }, request: { method: "GET", url: `${API}/project/search`, query: { query: "ops" } } },
    get_project: { args: { project_key: "OPS" }, request: { method: "GET", url: `${API}/project/OPS`, query: "absent" } },
    list_issue_types: { args: { project_key: "OPS" }, request: { method: "GET", url: `${API}/issue/createmeta/OPS/issuetypes`, query: "absent" } },
    find_assignable_users: {
      args: { project: "OPS", query: "ana" },
      request: { method: "GET", url: `${API}/user/assignable/search`, query: { query: "ana", project: "OPS" } },
    },
  },
});

const environment = { JIRA_SITE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "ana@acme.test", JIRA_API_TOKEN: "atl-token" };

test("JIRA_SITE_URL must be a bare https site on atlassian.net", () => {
  assert.equal(resolveJiraApiUrl({ JIRA_SITE_URL: "https://acme.atlassian.net/" }), API);
  assert.throws(() => resolveJiraApiUrl({}), /Set JIRA_SITE_URL/);
  assert.throws(() => resolveJiraApiUrl({ JIRA_SITE_URL: "https://jira.evil.example" }), /atlassian\.net/);
  assert.throws(() => resolveJiraApiUrl({ JIRA_SITE_URL: "https://acme.atlassian.net.evil.example" }), /atlassian\.net/);
  assert.throws(() => resolveJiraApiUrl({ JIRA_SITE_URL: "https://acme.atlassian.net/jira" }), /no path/);
  assert.throws(() => resolveJiraApiUrl({ JIRA_SITE_URL: "https://u:p@acme.atlassian.net" }), /credentials/);
  assert.throws(() => resolveJiraApiUrl({ JIRA_SITE_URL: "https://acme.atlassian.net:8443" }), /port/);
  assert.equal(resolveJiraApiUrl({ JIRA_SITE_URL: "https://acme.atlassian.net:443" }), API);
});

test("a site outside atlassian.net fails the call with invalid_input before any request", async () => {
  const recordingFetch = createRecordingFetch([]);
  const run = createOperationRunner(pluginDefinition, { ...environment, JIRA_SITE_URL: "https://jira.example.com" }, { fetchImpl: recordingFetch });
  await assert.rejects(run("get_myself", {}, { source: "node" }), (error) => error.kind === "invalid_input");
  assert.equal(recordingFetch.calls.length, 0);
});

test("credentials are sent as Basic email:token", async () => {
  const recordingFetch = createRecordingFetch([{ body: { accountId: "a1" } }]);
  await createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch })("get_myself", {}, { source: "tool" });
  assert.equal(recordingFetch.calls[0].headers.authorization, `Basic ${Buffer.from("ana@acme.test:atl-token").toString("base64")}`);
});

test("search pagination follows nextPageToken and stops when it is missing", async () => {
  const recordingFetch = createRecordingFetch([{ body: { issues: [{ key: "OPS-2" }], isLast: true } }]);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const result = await run("search_issues", { jql: "project = OPS", cursor: "tok2" }, { source: "tool" });
  assert.equal(recordingFetch.calls[0].query.nextPageToken, "tok2");
  assert.equal(result.next_cursor, null);
});

test("Jira's errorMessages and field errors are shown", async () => {
  const run = (body) => createOperationRunner(pluginDefinition, { ...environment, JIRA_TOOL_ALLOW_WRITE: "1" }, { fetchImpl: createRecordingFetch([{ status: 400, body }]) });
  await assert.rejects(
    run({ errorMessages: ["The value 'XYZ' does not exist for the field 'project'."], errors: {} })("search_issues", { jql: "project = XYZ" }, { source: "tool" }),
    (error) => error.kind === "invalid_input" && error.message.includes("does not exist"),
  );
  await assert.rejects(
    run({ errorMessages: [], errors: { summary: "You must specify a summary of the issue." } })("create_issue", { project_key: "OPS", issue_type: "Task", summary: " " }, { source: "tool" }),
    (error) => error.message.includes("specify a summary"),
  );
});

test("deletes are node only and writes are opt-in for tools", () => {
  const toolNames = new Set(buildManifest(pluginDefinition).tools.map((tool) => tool.name));
  assert.equal(toolNames.has("delete_issue"), false);
  const optInNames = pluginDefinition.restSpec.operations.filter((operation) => operation.toolPolicy).map((operation) => operation.name).sort();
  assert.deepEqual(optInNames, ["add_comment", "assign_issue", "create_issue", "transition_issue", "update_issue"]);
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
