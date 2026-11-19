import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ body: {} }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { VERCEL_TOKEN: "vcp_test", ...environment }, { fetchImpl: recordingFetch });
  const result = await runner(operationName, args, { source });
  return { result, calls: recordingFetch.calls };
}

test("VERCEL_TEAM_ID is sent as teamId when the call does not name a team", async () => {
  const { calls } = await run("get_project", { id_or_name: "web" }, { environment: { VERCEL_TEAM_ID: "team_abc" } });
  assert.equal(calls[0].query.teamId, "team_abc");
});

test("an explicit team_id wins over VERCEL_TEAM_ID", async () => {
  const { calls } = await run("get_project", { id_or_name: "web", team_id: "team_other" }, { environment: { VERCEL_TEAM_ID: "team_abc" } });
  assert.equal(calls[0].query.teamId, "team_other");
});

test("without VERCEL_TEAM_ID no teamId is sent, and user-level operations never get one", async () => {
  const projectCall = await run("get_project", { id_or_name: "web" });
  assert.equal("teamId" in projectCall.calls[0].query, false);
  const userCall = await run("get_user", {}, { environment: { VERCEL_TEAM_ID: "team_abc" } });
  assert.equal("teamId" in userCall.calls[0].query, false);
});

test("api_request also scopes to VERCEL_TEAM_ID unless the query names a team", async () => {
  const scoped = await run("api_request", { path: "/v4/aliases" }, { environment: { VERCEL_TEAM_ID: "team_abc" } });
  assert.equal(scoped.calls[0].query.teamId, "team_abc");
  const explicit = await run("api_request", { path: "/v4/aliases", query: { slug: "acme" } }, { environment: { VERCEL_TEAM_ID: "team_abc" } });
  assert.deepEqual(explicit.calls[0].query, { slug: "acme" });
});

const BLOCKED_PATHS = [
  "/v10/projects/web/env",
  "/v9/projects/web/env",
  "/v1/projects/prj_1/env/abc",
  "/v1/env",
  "/v1/edge-config/ecfg_1/tokens",
  "/v10/projects/web/%2565nv",
  "/v10/projects/web/%5Cenv",
  "/v10/projects/web%2Fenv",
  "/v3/secrets/x",
  "/v9/projects/web",
  "/v10/projects",
  "/v1/log-drains",
  "/v1/drains",
  "/v1/integrations/configurations",
  "/v6/deployments/dpl_1/files",
  "/v7/deployments/dpl_1/files/f1",
  "/v1/edge-config",
  "/v5/user/tokens",
];
for (const blockedPath of BLOCKED_PATHS) {
  test(`tools cannot reach ${blockedPath} through api_request`, async () => {
    await assert.rejects(run("api_request", { path: blockedPath, query: { decrypt: "true" } }), (error) => error.kind === "permission_denied");
  });
}

test("workflow nodes can still use api_request on env paths", async () => {
  const { calls } = await run("api_request", { path: "/v10/projects/web/env" }, { source: "node", responses: [{ body: { envs: [] } }] });
  assert.equal(calls.length, 1);
});

test("environment variable operations are node only", () => {
  const toolNames = new Set(buildManifest(pluginDefinition).tools.map((tool) => tool.name));
  for (const operationName of ["list_env_vars", "get_env_var", "create_env_var", "update_env_var", "delete_env_var"]) assert.equal(toolNames.has(operationName), false, operationName);
});

for (const allowedPath of ["/v2/user", "/v2/teams", "/v13/deployments/dpl_1", "/v3/deployments/dpl_1/events", "/v6/domains/example.com/config", "/v9/projects/web/domains", "/v4/aliases"]) {
  test(`tools may read ${allowedPath} through api_request`, async () => {
    const { calls } = await run("api_request", { path: allowedPath });
    assert.equal(calls.length, 1);
  });
}

const projectWithSecrets = {
  id: "prj_1",
  name: "web",
  framework: "nextjs",
  env: [{ key: "DATABASE_URL", value: "postgres://secret", type: "plain" }],
  protectionBypass: { "bypass-secret-123": { scope: "automation-bypass" } },
  link: { type: "github", repo: "web", deployHooks: [{ name: "prod", url: "https://api.vercel.com/v1/integrations/deploy/prj_1/hook-secret" }] },
  latestDeployments: [{ uid: "dpl_1", env: ["API_URL"] }],
  passwordProtection: { deploymentType: "all" },
  security: { requestLogsKey: "logs-secret" },
  customEnvironments: [{ slug: "staging", env: [{ key: "K", legacyValue: "old-secret", vsmValue: "vsm-secret" }] }],
};

test("get_project strips env vars, bypass secrets, deploy hooks and other secret fields for tools", async () => {
  const { result } = await run("get_project", { id_or_name: "web" }, { responses: [{ body: projectWithSecrets }] });
  const text = JSON.stringify(result.data);
  for (const secret of ["postgres://secret", "bypass-secret-123", "hook-secret", "logs-secret", "old-secret", "vsm-secret"]) assert.equal(text.includes(secret), false, secret);
  assert.equal(result.data.name, "web");
  assert.equal(result.data.link.repo, "web");
});

test("list_projects strips the same fields for tools, and keeps everything for nodes", async () => {
  const toolCall = await run("list_projects", {}, { responses: [{ body: { projects: [projectWithSecrets], pagination: { next: null } } }] });
  assert.equal(JSON.stringify(toolCall.result.data).includes("postgres://secret"), false);
  assert.equal(toolCall.result.data[0].framework, "nextjs");
  const nodeCall = await run("list_projects", {}, { source: "node", responses: [{ body: { projects: [projectWithSecrets], pagination: { next: null } } }] });
  assert.equal(nodeCall.result.data[0].env[0].value, "postgres://secret");
});

test("project responses are still truncated for tools after the secrets are removed", async () => {
  const manyProjects = Array.from({ length: 400 }, (unused, index) => ({ ...projectWithSecrets, id: `prj_${index}`, description: "x".repeat(400) }));
  const { result } = await run("list_projects", {}, { responses: [{ body: { projects: manyProjects, pagination: { next: null } } }] });
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.preview.includes("postgres://secret"), false);
});

test("VERCEL_TOOL_API_EXTRA_PATHS opens more read paths for tools, but never env or token paths", async () => {
  const environment = { VERCEL_TOOL_API_EXTRA_PATHS: "/v1/edge-config, /v10/projects/*/env" };
  const { calls } = await run("api_request", { path: "/v1/edge-config" }, { environment });
  assert.equal(calls.length, 1);
  await assert.rejects(run("api_request", { path: "/v10/projects/web/env" }, { environment }), (error) => error.kind === "permission_denied");
});

test("an invalid token reads as a clear auth_error message, without the raw flag", async () => {
  const responses = [{ status: 403, body: { error: { code: "forbidden", message: "Not authorized", invalidToken: true } } }];
  await assert.rejects(run("get_user", {}, { responses }), (error) => error.kind === "auth_error" && error.message === "API error 403: Not authorized (invalid or expired token)");
});
