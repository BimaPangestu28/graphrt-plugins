import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.vercel.com";

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls api_request on "/anything" as a tool; the extra-paths env lets that path through.
  environment: { VERCEL_TOOL_API_EXTRA_PATHS: "/anything" },
  operations: {
    get_user: { args: {}, request: { method: "GET", url: `${API}/v2/user`, query: "absent" }, response: { body: { user: { username: "ana" } } }, expect: { data: { username: "ana" } } },
    list_teams: { args: { limit: 20 }, request: { method: "GET", url: `${API}/v2/teams`, query: { limit: "20" } } },
    list_projects: {
      args: { team_id: "team_1", search: "web" },
      request: { method: "GET", url: `${API}/v10/projects`, query: { teamId: "team_1", search: "web" } },
      response: { body: { projects: [{ id: "prj_1" }], pagination: { count: 1, next: "JBSWY3DP" } } },
      expect: { data: [{ id: "prj_1" }] },
    },
    get_project: { args: { id_or_name: "web" }, request: { method: "GET", url: `${API}/v9/projects/web`, query: "absent" } },
    list_deployments: {
      args: { project_id: "web", target: "production", state: "ERROR", limit: 10 },
      request: { method: "GET", url: `${API}/v7/deployments`, query: { projectId: "web", target: "production", state: "ERROR", limit: "10" } },
    },
    get_deployment: { args: { id_or_url: "dpl_1" }, request: { method: "GET", url: `${API}/v13/deployments/dpl_1`, query: "absent" } },
    list_deployment_events: {
      args: { id_or_url: "dpl_1", direction: "backward" },
      request: { method: "GET", url: `${API}/v3/deployments/dpl_1/events`, query: { direction: "backward", limit: "500", follow: "0" } },
    },
    cancel_deployment: { args: { deployment_id: "dpl_1" }, request: { method: "PATCH", url: `${API}/v12/deployments/dpl_1/cancel`, query: "absent", body: "absent" } },
    redeploy: {
      args: { name: "web", deployment_id: "dpl_1", target: "production" },
      request: { method: "POST", url: `${API}/v13/deployments`, query: "absent", json: { name: "web", deploymentId: "dpl_1", target: "production" } },
    },
    delete_deployment: { args: { deployment_id: "dpl_1" }, request: { method: "DELETE", url: `${API}/v13/deployments/dpl_1`, query: "absent", body: "absent" } },
    list_env_vars: { args: { id_or_name: "web", decrypt: false }, request: { method: "GET", url: `${API}/v10/projects/web/env`, query: { decrypt: "false" } } },
    get_env_var: { args: { id_or_name: "web", env_id: "env_1" }, request: { method: "GET", url: `${API}/v1/projects/web/env/env_1`, query: "absent" } },
    create_env_var: {
      args: { id_or_name: "web", key: "API_URL", value: "https://api.example.com", target: ["production", "preview"], upsert: true },
      request: { method: "POST", url: `${API}/v10/projects/web/env`, query: { upsert: "true" }, json: { key: "API_URL", value: "https://api.example.com", type: "encrypted", target: ["production", "preview"] } },
    },
    update_env_var: {
      args: { id_or_name: "web", env_id: "env_1", value: "v2", env_type: "sensitive" },
      request: { method: "PATCH", url: `${API}/v9/projects/web/env/env_1`, query: "absent", json: { value: "v2", type: "sensitive" } },
    },
    delete_env_var: { args: { id_or_name: "web", env_id: "env_1" }, request: { method: "DELETE", url: `${API}/v9/projects/web/env/env_1`, query: "absent", body: "absent" } },
    list_domains: { args: {}, request: { method: "GET", url: `${API}/v5/domains`, query: "absent" } },
    get_domain: { args: { domain: "example.com" }, request: { method: "GET", url: `${API}/v5/domains/example.com`, query: "absent" } },
    get_domain_config: {
      args: { domain: "www.example.com", project_id_or_name: "web" },
      request: { method: "GET", url: `${API}/v6/domains/www.example.com/config`, query: { projectIdOrName: "web" } },
    },
    list_project_domains: { args: { id_or_name: "web", production: true }, request: { method: "GET", url: `${API}/v9/projects/web/domains`, query: { production: "true" } } },
    add_project_domain: {
      args: { id_or_name: "web", name: "www.example.com", redirect: "example.com", redirect_status_code: 308 },
      request: { method: "POST", url: `${API}/v10/projects/web/domains`, query: "absent", json: { name: "www.example.com", redirect: "example.com", redirectStatusCode: 308 } },
    },
  },
});

test("timestamp pagination sends pagination.next back as until", async () => {
  const firstPage = createRecordingFetch([{ body: { deployments: [{ uid: "dpl_1" }], pagination: { count: 1, next: 1700000000000 } } }]);
  const run = createOperationRunner(pluginDefinition, { VERCEL_TOKEN: "vcp_test" }, { fetchImpl: firstPage });
  const result = await run("list_deployments", {}, { source: "tool" });
  assert.equal(result.next_cursor, "1700000000000");
  const nextPage = createRecordingFetch([{ body: { deployments: [], pagination: { count: 0, next: null } } }]);
  const nextResult = await createOperationRunner(pluginDefinition, { VERCEL_TOKEN: "vcp_test" }, { fetchImpl: nextPage })("list_deployments", { cursor: "1700000000000" }, { source: "tool" });
  assert.equal(nextPage.calls[0].query.until, "1700000000000");
  assert.equal(nextResult.next_cursor, null);
});

test("an invalid token (Vercel answers 403 with invalidToken) is an auth_error", async () => {
  const run = createOperationRunner(pluginDefinition, { VERCEL_TOKEN: "bad" }, { fetchImpl: createRecordingFetch([{ status: 403, body: { error: { code: "forbidden", message: "Not authorized", invalidToken: true } } }]) });
  await assert.rejects(run("get_user", {}, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("Not authorized"));
});

test("a 403 without invalidToken stays permission_denied", async () => {
  const run = createOperationRunner(pluginDefinition, { VERCEL_TOKEN: "t" }, { fetchImpl: createRecordingFetch([{ status: 403, body: { error: { code: "forbidden", message: "You don't have permission to access this team" } } }]) });
  await assert.rejects(run("list_projects", {}, { source: "tool" }), (error) => error.kind === "permission_denied" && error.message.includes("permission"));
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
