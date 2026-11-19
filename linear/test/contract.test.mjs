import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const GRAPHQL_URL = "https://api.linear.app/graphql";
const restOperations = pluginDefinition.restSpec.operations.filter((operation) => operation.path === "/graphql");
const queryOf = (operationName) => restOperations.find((operation) => operation.name === operationName).constants.body.query;
const graphqlRequest = (operationName, variables) => ({
  method: "POST",
  url: GRAPHQL_URL,
  query: "absent",
  json: variables === undefined ? { query: queryOf(operationName) } : { query: queryOf(operationName), variables },
});
const issueFilter = { team: { key: { eq: "ENG" } } };

describeRestPluginContract(pluginDefinition, {
  operations: {
    get_viewer: {
      args: {},
      request: graphqlRequest("get_viewer"),
      response: { body: { data: { viewer: { id: "u1", name: "Ana" } } } },
      expect: { data: { id: "u1", name: "Ana" } },
    },
    list_teams: { args: {}, request: graphqlRequest("list_teams", { first: 50 }) },
    get_team: { args: { team_id: "t1" }, request: graphqlRequest("get_team", { id: "t1" }) },
    list_workflow_states: { args: { filter: issueFilter, limit: 100 }, request: graphqlRequest("list_workflow_states", { filter: issueFilter, first: 100 }) },
    list_users: { args: { filter: { active: { eq: true } } }, request: graphqlRequest("list_users", { filter: { active: { eq: true } }, first: 50 }) },
    list_issues: {
      args: { filter: issueFilter, order_by: "updatedAt", limit: 20 },
      request: graphqlRequest("list_issues", { filter: issueFilter, orderBy: "updatedAt", first: 20 }),
      response: { body: { data: { issues: { nodes: [{ identifier: "ENG-1" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } } },
      expect: { data: [{ identifier: "ENG-1" }] },
    },
    search_issues: { args: { term: "login crash", include_comments: true }, request: graphqlRequest("search_issues", { term: "login crash", includeComments: true, first: 50 }) },
    get_issue: { args: { issue_id: "ENG-123" }, request: graphqlRequest("get_issue", { id: "ENG-123" }) },
    create_issue: {
      args: { team_id: "t1", issue_title: "Crash", description: "Steps", priority: 2, label_ids: ["l1"] },
      request: graphqlRequest("create_issue", { input: { teamId: "t1", title: "Crash", description: "Steps", priority: 2, labelIds: ["l1"] } }),
    },
    update_issue: { args: { issue_id: "ENG-1", state_id: "s2", assignee_id: "u1" }, request: graphqlRequest("update_issue", { id: "ENG-1", input: { stateId: "s2", assigneeId: "u1" } }) },
    delete_issue: { args: { issue_id: "ENG-1" }, request: graphqlRequest("delete_issue", { id: "ENG-1" }) },
    list_comments: { args: { issue_id: "ENG-1", limit: 10 }, request: graphqlRequest("list_comments", { id: "ENG-1", first: 10 }) },
    create_comment: { args: { issue_id: "i1", body: "Fixed" }, request: graphqlRequest("create_comment", { input: { issueId: "i1", body: "Fixed" } }) },
    list_projects: { args: { include_archived: false }, request: graphqlRequest("list_projects", { includeArchived: false, first: 50 }) },
    get_project: { args: { project_id: "p1" }, request: graphqlRequest("get_project", { id: "p1" }) },
  },
});

const environment = { LINEAR_API_KEY: "lin_api_test" };

async function runAsTool(operationName, args, responses, extraEnvironment = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { ...environment, ...extraEnvironment }, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source: "tool" }), calls: recordingFetch.calls };
}

test("every query document declares exactly the variables its params send", () => {
  for (const operation of restOperations) {
    const document = operation.constants.body.query;
    assert.match(document, /^(query|mutation) [A-Z]\w*[ ({]/, operation.name);
    const declaredVariables = new Set([...document.matchAll(/\$(\w+):/g)].map((match) => match[1]));
    const usedVariables = new Set([...document.matchAll(/\$(\w+)(?!\w*:)/g)].map((match) => match[1]));
    assert.deepEqual([...usedVariables].sort(), [...declaredVariables].sort(), `${operation.name}: used vs declared`);
    const paramVariables = Object.values(operation.params).map((param) => param.wireName.split(".")[1]);
    const paginationVariables = operation.pagination ? ["first", "after"] : [];
    for (const variableName of [...paramVariables, ...paginationVariables]) assert.ok(declaredVariables.has(variableName), `${operation.name}: $${variableName} not declared`);
  }
});

test("the API key goes in Authorization without a Bearer prefix", async () => {
  const { calls } = await runAsTool("get_viewer", {}, [{ body: { data: { viewer: { id: "u1" } } } }]);
  assert.equal(calls[0].headers.authorization, "lin_api_test");
});

test("connection pages follow pageInfo.endCursor until hasNextPage is false", async () => {
  const firstPage = await runAsTool("list_issues", {}, [{ body: { data: { issues: { nodes: [{ id: "1" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } } }]);
  assert.equal(firstPage.result.next_cursor, "c1");
  const lastPage = await runAsTool("list_issues", { cursor: "c1" }, [{ body: { data: { issues: { nodes: [{ id: "2" }], pageInfo: { hasNextPage: false, endCursor: "c2" } } } } }]);
  assert.equal(lastPage.calls[0].json.variables.after, "c1");
  assert.equal(lastPage.result.next_cursor, null);
});

test("GraphQL errors are errors even with HTTP 200, and their code sets the kind", async () => {
  const forbidden = { errors: [{ message: "You do not have access", extensions: { code: "FORBIDDEN" } }], data: null };
  await assert.rejects(runAsTool("get_issue", { issue_id: "ENG-1" }, [{ body: forbidden }]), (error) => error.kind === "permission_denied" && error.message.includes("do not have access"));
  const unauthenticated = { errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR" } }] };
  await assert.rejects(runAsTool("get_viewer", {}, [{ status: 401, body: unauthenticated }]), (error) => error.kind === "auth_error");
});

test("issue and comment writes are opt-in for tools and delete is node only", async () => {
  await assert.rejects(runAsTool("create_comment", { issue_id: "i1", body: "x" }, []), (error) => error.kind === "permission_denied" && error.message.includes("LINEAR_TOOL_ALLOW_WRITE"));
  const { calls } = await runAsTool("create_comment", { issue_id: "i1", body: "x" }, [{ body: { data: { commentCreate: { success: true } } } }], { LINEAR_TOOL_ALLOW_WRITE: "1" });
  assert.equal(calls.length, 1);
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

test("update_issue with no field to change is refused before any request", async () => {
  const recordingFetch = createRecordingFetch([]);
  const run = createOperationRunner(pluginDefinition, { ...environment, LINEAR_TOOL_ALLOW_WRITE: "1" }, { fetchImpl: recordingFetch });
  await assert.rejects(run("update_issue", { issue_id: "ENG-1" }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("at least one field"));
  await assert.rejects(run("update_issue", { issue_id: "ENG-1" }, { source: "node" }), (error) => error.kind === "invalid_input");
  assert.equal(recordingFetch.calls.length, 0);
});
