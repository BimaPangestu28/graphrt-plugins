/**
 * vercel plugin definition: deployments (list, inspect, build events, cancel, redeploy), projects, environment
 * variables and domains through the Vercel REST API (https://vercel.com/docs/rest-api).
 * Built with the declarative REST layer (docs/declarative-plugins.md) plus two wrappers (lib/vercel-wrappers.mjs):
 * the VERCEL_TEAM_ID default and an api_request guard for secret-bearing paths.
 *
 * Agent policy: reads are tools; cancelling deployments and adding domains need VERCEL_TOOL_ALLOW_WRITE=1 for tools;
 * environment variables (values are secrets), redeploys and deletes are node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { applyDefaultTeam, clarifyInvalidTokenErrors, stripSecretFieldsForTools } from "./lib/vercel-wrappers.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";

const WRITE_OPT_IN = "optIn:VERCEL_TOOL_ALLOW_WRITE";
// GET paths agent tools may reach through api_request (normalized: lowercase, decoded, dot segments resolved). Project
// objects are excluded (they embed env vars; use get_project), as are env vars, secrets, tokens, deployment source
// files, log drains and integrations.
const ID = "[^/]+";
const TOOL_API_PATHS = [
  "/v\\d+/user",
  `/v\\d+/teams(/${ID})?`,
  `/v\\d+/projects/${ID}/domains(/${ID})?`,
  `/v\\d+/deployments(/${ID}(/(events|aliases|checks))?)?`,
  `/v\\d+/domains(/${ID}(/config)?)?`,
  `/v\\d+/aliases(/${ID})?`,
].map((pattern) => new RegExp(`^${pattern}$`));
const TOOL_API_BLOCKED_PATHS = [/(^|\/)(env|tokens|secrets|files)(\/|$)/];
// Secret-bearing fields of project objects, removed from get_project and list_projects for tools.
const PROJECT_SECRET_FIELDS = ["env", "legacyValue", "vsmValue", "encryptedValue", "protectionBypass", "deployHooks", "passwordProtection", "requestLogsKey"];
const timestampPages = (dataPath) => ({ dataPath, cursorPath: "pagination.next", cursorParam: "until", limitParam: "limit", maxLimit: 100 });

const teamParam = { team_id: { in: "query", type: "string", wireName: "teamId", description: "Team id (default VERCEL_TEAM_ID; omit for the personal account)" } };
const projectParam = { in: "path", type: "string", required: true, description: "Project id or name" };
const deploymentParam = { in: "path", type: "string", required: true, description: "Deployment id (dpl_...) or its URL host" };
const envIdParam = { in: "path", type: "string", required: true, description: "Environment variable id (from list_env_vars)" };
const envTargetParam = { in: "body", type: "array", items: { type: "string", enum: ["production", "preview", "development"] }, maxItems: 3 };

// --- account, projects ------------------------------------------------------------------------------

const accountOperations = [
  { name: "get_user", title: "Current user", description: "The user the token belongs to; a cheap way to check the token", path: "/v2/user", response: { dataPath: "user" } },
  { name: "list_teams", title: "List teams", description: "Teams the user belongs to (ids for team_id)", path: "/v2/teams", response: timestampPages("teams") },
  {
    name: "list_projects",
    title: "List projects",
    description: "Projects, most recently updated first",
    path: "/v10/projects",
    params: { ...teamParam, search: { in: "query", type: "string", description: "Search by project name" }, repo: { in: "query", type: "string", description: "Linked repository name" } },
    response: { dataPath: "projects", cursorPath: "pagination.next", cursorParam: "from", limitParam: "limit", maxLimit: 100 },
    toolOutput: false,
  },
  {
    name: "get_project",
    title: "Get project",
    description: "One project: framework, settings, linked repository, latest deployments",
    path: "/v9/projects/{id_or_name}",
    params: { ...teamParam, id_or_name: projectParam },
    toolOutput: false,
  },
];

// --- deployments ------------------------------------------------------------------------------------

const deploymentOperations = [
  {
    name: "list_deployments",
    title: "List deployments",
    description: "Deployments, newest first, optionally for one project, environment, state or branch",
    path: "/v7/deployments",
    params: {
      ...teamParam,
      project_id: { in: "query", type: "string", wireName: "projectId", description: "Project id or name" },
      target: { in: "query", type: "string", description: "production, preview or a custom environment" },
      state: { in: "query", type: "string", description: "Comma list of BUILDING, ERROR, INITIALIZING, QUEUED, READY, CANCELED" },
      branch: { in: "query", type: "string" },
      sha: { in: "query", type: "string" },
    },
    response: timestampPages("deployments"),
  },
  {
    name: "get_deployment",
    title: "Get deployment",
    description: "One deployment: state, URL, aliases, git metadata, errors",
    path: "/v13/deployments/{id_or_url}",
    params: { ...teamParam, id_or_url: deploymentParam },
  },
  {
    name: "list_deployment_events",
    title: "Deployment build logs",
    description: "Build events (log lines) of a deployment, for debugging failed builds",
    path: "/v3/deployments/{id_or_url}/events",
    params: {
      ...teamParam,
      id_or_url: deploymentParam,
      direction: { in: "query", type: "string", enum: ["forward", "backward"], description: "backward for the latest lines first" },
      max_events: { in: "query", type: "integer", min: 1, max: 5000, default: 500, wireName: "limit", description: "Maximum events" },
    },
    constants: { query: { follow: 0 } },
  },
  {
    name: "cancel_deployment",
    title: "Cancel deployment",
    description: "Cancel a deployment that is still building",
    method: "PATCH",
    path: "/v12/deployments/{deployment_id}/cancel",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    params: { ...teamParam, deployment_id: { ...deploymentParam, description: "Deployment id (dpl_...)" } },
  },
  {
    name: "redeploy",
    title: "Redeploy",
    description: "Create a new deployment from an existing one (same source and settings), optionally to production",
    method: "POST",
    path: "/v13/deployments",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_deployments for the project",
    params: {
      ...teamParam,
      name: { in: "body", type: "string", required: true, description: "Project name" },
      deployment_id: { in: "body", type: "string", required: true, wireName: "deploymentId", description: "Deployment to redeploy" },
      target: { in: "body", type: "string", description: "production, staging or a custom environment (default preview)" },
    },
  },
  {
    name: "delete_deployment",
    title: "Delete deployment",
    description: "Delete a deployment",
    method: "DELETE",
    path: "/v13/deployments/{deployment_id}",
    write: "idempotent",
    nodeOnly: true,
    params: { ...teamParam, deployment_id: { ...deploymentParam, description: "Deployment id (dpl_...)" } },
  },
];

// --- environment variables (node only: values are secrets) ---------------------------------------------

const envOperations = [
  {
    name: "list_env_vars",
    title: "List environment variables",
    description: "Environment variables of a project (plain values in clear; decrypt=true decrypts encrypted ones)",
    path: "/v10/projects/{id_or_name}/env",
    nodeOnly: true,
    params: {
      ...teamParam,
      id_or_name: projectParam,
      decrypt: { in: "query", type: "boolean", description: "Return decrypted values" },
      git_branch: { in: "query", type: "string", wireName: "gitBranch" },
    },
    response: { dataPath: "envs" },
  },
  {
    name: "get_env_var",
    title: "Get environment variable",
    description: "One environment variable with its decrypted value",
    path: "/v1/projects/{id_or_name}/env/{env_id}",
    nodeOnly: true,
    params: { ...teamParam, id_or_name: projectParam, env_id: envIdParam },
  },
  {
    name: "create_env_var",
    title: "Create environment variable",
    description: "Add an environment variable to a project (upsert=true replaces an existing key)",
    method: "POST",
    path: "/v10/projects/{id_or_name}/env",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_env_vars and look for the key",
    params: {
      ...teamParam,
      id_or_name: projectParam,
      upsert: { in: "query", type: "boolean" },
      key: { in: "body", type: "string", required: true, minLength: 1 },
      value: { in: "body", type: "string", required: true },
      env_type: { in: "body", wireName: "type", type: "string", enum: ["plain", "encrypted", "sensitive"], default: "encrypted" },
      target: { ...envTargetParam, required: true },
      git_branch: { in: "body", type: "string", wireName: "gitBranch", description: "Only for target preview" },
      comment: { in: "body", type: "string" },
    },
  },
  {
    name: "update_env_var",
    title: "Update environment variable",
    description: "Change an environment variable's value, targets or branch",
    method: "PATCH",
    path: "/v9/projects/{id_or_name}/env/{env_id}",
    write: "idempotent",
    nodeOnly: true,
    params: {
      ...teamParam,
      id_or_name: projectParam,
      env_id: envIdParam,
      value: { in: "body", type: "string" },
      env_type: { in: "body", wireName: "type", type: "string", enum: ["plain", "encrypted", "sensitive"] },
      target: envTargetParam,
      git_branch: { in: "body", type: "string", wireName: "gitBranch" },
      comment: { in: "body", type: "string" },
    },
  },
  {
    name: "delete_env_var",
    title: "Delete environment variable",
    description: "Remove an environment variable from a project",
    method: "DELETE",
    path: "/v9/projects/{id_or_name}/env/{env_id}",
    write: "idempotent",
    nodeOnly: true,
    params: { ...teamParam, id_or_name: projectParam, env_id: envIdParam },
  },
];

// --- domains ----------------------------------------------------------------------------------------

const domainOperations = [
  { name: "list_domains", title: "List domains", description: "Domains registered or added to the account", path: "/v5/domains", params: teamParam, response: timestampPages("domains") },
  {
    name: "get_domain",
    title: "Get domain",
    description: "One domain: verification, nameservers, registrar, expiry",
    path: "/v5/domains/{domain}",
    params: { ...teamParam, domain: { in: "path", type: "string", required: true, description: "e.g. example.com" } },
  },
  {
    name: "get_domain_config",
    title: "Domain DNS configuration",
    description: "Whether a domain is configured correctly (misconfigured flag, recommended A/CNAME records)",
    path: "/v6/domains/{domain}/config",
    params: { ...teamParam, domain: { in: "path", type: "string", required: true }, project_id_or_name: { in: "query", type: "string", wireName: "projectIdOrName" } },
  },
  {
    name: "list_project_domains",
    title: "List project domains",
    description: "Domains of a project, with redirects and verification state",
    path: "/v9/projects/{id_or_name}/domains",
    params: { ...teamParam, id_or_name: projectParam, production: { in: "query", type: "boolean" }, verified: { in: "query", type: "boolean" } },
    response: timestampPages("domains"),
  },
  {
    name: "add_project_domain",
    title: "Add project domain",
    description: "Add a domain to a project (DNS must point to Vercel; verification may be needed)",
    method: "POST",
    path: "/v10/projects/{id_or_name}/domains",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "list_project_domains",
    params: {
      ...teamParam,
      id_or_name: projectParam,
      name: { in: "body", type: "string", required: true, description: "Domain, e.g. www.example.com" },
      git_branch: { in: "body", type: "string", wireName: "gitBranch", description: "Serve this branch's preview" },
      redirect: { in: "body", type: "string", description: "Redirect to this domain" },
      redirect_status_code: { in: "body", type: "integer", enum: [301, 302, 307, 308], wireName: "redirectStatusCode" },
    },
  },
];

const restDefinition = defineRestPlugin({
  name: "vercel",
  version: "0.1.0",
  description: "Vercel REST API: deployments (list, inspect, build logs, cancel, redeploy), projects, environment variables and domains",
  apiName: "Vercel REST API",
  baseUrl: "https://api.vercel.com",
  extraEnv: ["VERCEL_TEAM_ID", "VERCEL_TOOL_API_EXTRA_PATHS"],
  toolUserToken: true,
  auth: { type: "bearer", env: "VERCEL_TOKEN" },
  // Errors are {"error": {"code": "forbidden", "message": "Not authorized", "invalidToken": true}}: the invalidToken flag
  // marks a bad token (Vercel answers 403, not 401), so it is the code that maps to auth_error.
  errors: { messagePath: "error.message", codePath: "error.invalidToken", kindByCode: { true: "auth_error" } },
  apiRequest: { examplePath: "/v4/aliases" },
  operations: [...accountOperations, ...deploymentOperations, ...envOperations, ...domainOperations],
});

const teamScopedDefinition = applyDefaultTeam(restDefinition, "VERCEL_TEAM_ID");
const guardedDefinition = guardToolApiRequest(teamScopedDefinition, {
  allowedPaths: TOOL_API_PATHS,
  blockedPaths: TOOL_API_BLOCKED_PATHS,
  extraAllowedPathsEnv: "VERCEL_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read the user, teams, deployments, domains and aliases; use a workflow node",
});
const strippedDefinition = stripSecretFieldsForTools(guardedDefinition, { operationNames: ["get_project", "list_projects"], fieldNames: PROJECT_SECRET_FIELDS });

export const pluginDefinition = clarifyInvalidTokenErrors(strippedDefinition);
