/**
 * gitlab plugin definition: projects, issues, merge requests, pipelines and repository files through the GitLab
 * REST API v4 (https://docs.gitlab.com/api/rest/), on gitlab.com or a self-hosted instance (GITLAB_BASE_URL).
 * Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Agent policy: reads are tools; issue/MR/note writes need GITLAB_TOOL_ALLOW_WRITE=1 and pipeline retry/cancel need
 * GITLAB_TOOL_ALLOW_CI=1, both only on projects in GITLAB_TOOL_ALLOWED_PROJECTS; merges, file commits, new pipelines
 * and deletes are node only; `api_request` as a tool only reaches an allowlist of read-only, non-secret paths.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { requireAllowedTarget } from "./lib/tool-call-policy.mjs";

const WRITE_OPT_IN = "optIn:GITLAB_TOOL_ALLOW_WRITE";
const CI_OPT_IN = "optIn:GITLAB_TOOL_ALLOW_CI";
const ALLOWED_PROJECTS_ENV = "GITLAB_TOOL_ALLOWED_PROJECTS";
const LINK_PAGES = { nextLinkHeader: true, limitParam: "per_page", maxLimit: 100 };
const DEFAULT_BASE_URL = "https://gitlab.com";
// Read-only, non-secret GET paths agent tools may reach through api_request (normalized: lowercase, no format suffix,
// `{encoded}` for a group%2Fproject id). Everything else is refused for tools, notably CI/CD variables, triggers,
// pipeline schedules (they return variable values), secure files, Terraform state, deploy tokens, hooks, runners,
// access tokens, packages, and job traces and artifacts (jobs can print unmasked variables).
const ID = "[^/]+";
const TOOL_API_PATHS = [
  "/(user|version|metadata|issues|merge_requests|search)",
  `/users(/${ID}(/(projects|events))?)?`,
  `/projects(/${ID})?`,
  `/projects/${ID}/(issues|merge_requests|milestones|labels|releases|members|events|languages|search|pipelines|jobs)`,
  `/projects/${ID}/issues/${ID}(/(notes|discussions|links|related_merge_requests|closed_by)(/${ID})?)?`,
  `/projects/${ID}/merge_requests/${ID}(/(notes|discussions|diffs|changes|commits|pipelines|approvals|participants)(/${ID})?)?`,
  `/projects/${ID}/(milestones|labels|releases|jobs)/${ID}`,
  `/projects/${ID}/pipelines/${ID}(/(jobs|bridges|test_report|test_report_summary))?`,
  `/projects/${ID}/repository/(tree|branches|tags|commits|compare|contributors)`,
  `/projects/${ID}/repository/(branches|tags)/${ID}`,
  `/projects/${ID}/repository/commits/${ID}(/(diff|comments|statuses|refs))?`,
  `/projects/${ID}/repository/files/${ID}(/(raw|blame))?`,
  `/groups(/${ID})?`,
  `/groups/${ID}/(projects|subgroups|issues|merge_requests|members|labels|milestones)`,
].map((pattern) => new RegExp(`^${pattern}$`));
// Defence in depth: refused for tools even when an operator adds them to GITLAB_TOOL_API_EXTRA_PATHS.
const TOOL_API_BLOCKED_PATHS = [/(^|\/)(variables|triggers|pipeline_schedules|secure_files|terraform|deploy_tokens|hooks|runners|access_tokens|personal_access_tokens|trace|artifacts|packages)(\/|$)/];

/**
 * Resolves the API base URL from GITLAB_BASE_URL (the instance URL, default https://gitlab.com).
 *
 * @param environment - Plugin environment (object)
 * @returns `<instance>/api/v4` (string)
 * @throws Error - Not a URL, credentials, query or fragment in the URL (becomes invalid_input)
 *
 * @example
 * resolveGitLabApiUrl({ GITLAB_BASE_URL: "https://git.example.com/" }); // "https://git.example.com/api/v4"
 */
export function resolveGitLabApiUrl(environment) {
  const configuredUrl = environment.GITLAB_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let instanceUrl;
  try {
    instanceUrl = new URL(configuredUrl);
  } catch {
    throw new Error("GITLAB_BASE_URL must be the instance URL, e.g. https://gitlab.example.com");
  }
  if (instanceUrl.username || instanceUrl.password) throw new Error("GITLAB_BASE_URL must not contain credentials; use GITLAB_TOKEN");
  if (instanceUrl.search || instanceUrl.hash) throw new Error("GITLAB_BASE_URL must not contain a query or fragment");
  const instancePath = instanceUrl.pathname.replace(/\/+$/, "").replace(/\/api\/v4$/, "");
  return `${instanceUrl.origin}${instancePath}/api/v4`;
}

const projectParam = { in: "path", type: "string", required: true, description: 'Project id or full path, e.g. 42 or "group/sub/project"' };
const issueIidParam = { in: "path", type: "integer", required: true, min: 1, description: "Issue IID (the number shown in the project, #12)" };
const mergeRequestIidParam = { in: "path", type: "integer", required: true, min: 1, description: "Merge request IID (!12)" };
const pipelineIdParam = { in: "path", type: "integer", required: true, min: 1, description: "Pipeline id" };
const filePathParam = { in: "path", type: "string", required: true, description: "File path in the repository, e.g. src/app.rb" };
const sortParam = { in: "query", type: "string", enum: ["asc", "desc"] };
const labelsBody = { in: "body", type: "string", description: "Comma-separated label names" };
const idList = (description) => ({ in: "body", type: "array", items: { type: "integer" }, maxItems: 100, description });

// --- user and projects ------------------------------------------------------------------------------

const projectOperations = [
  { name: "get_current_user", title: "Current user", description: "The user the token belongs to; a cheap way to check the token", path: "/user" },
  {
    name: "list_projects",
    title: "List projects",
    description: "Projects visible to the token (member projects by default)",
    path: "/projects",
    params: {
      membership: { in: "query", type: "boolean", default: true, description: "Only projects you are a member of" },
      search: { in: "query", type: "string", description: "Search in name and path" },
      owned: { in: "query", type: "boolean" },
      starred: { in: "query", type: "boolean" },
      archived: { in: "query", type: "boolean" },
      visibility: { in: "query", type: "string", enum: ["public", "internal", "private"] },
      order_by: { in: "query", type: "string", enum: ["id", "name", "path", "created_at", "updated_at", "last_activity_at"] },
      sort: sortParam,
      simple: { in: "query", type: "boolean", default: true, description: "Return only basic fields (smaller responses)" },
    },
    response: LINK_PAGES,
  },
  {
    name: "get_project",
    title: "Get project",
    description: "One project: default branch, visibility, URLs, statistics",
    path: "/projects/{project_id}",
    params: { project_id: projectParam },
  },
];

// --- issues -----------------------------------------------------------------------------------------

const issueOperations = [
  {
    name: "list_issues",
    title: "List issues",
    description: "Issues of a project",
    path: "/projects/{project_id}/issues",
    params: {
      project_id: projectParam,
      state: { in: "query", type: "string", enum: ["opened", "closed", "all"], default: "opened" },
      labels: { in: "query", type: "array", items: { type: "string" }, maxItems: 50, description: "Only issues with all these labels" },
      search: { in: "query", type: "string", description: "Search title and description" },
      assignee_username: { in: "query", type: "string" },
      author_username: { in: "query", type: "string" },
      milestone: { in: "query", type: "string", description: "Milestone title, None or Any" },
      updated_after: { in: "query", type: "string", description: "ISO 8601 time" },
      order_by: { in: "query", type: "string", enum: ["created_at", "updated_at", "priority", "due_date", "relative_position", "label_priority", "milestone_due", "popularity", "weight"] },
      sort: sortParam,
    },
    response: LINK_PAGES,
  },
  {
    name: "get_issue",
    title: "Get issue",
    description: "One issue with description, labels, assignees and state",
    path: "/projects/{project_id}/issues/{issue_iid}",
    params: { project_id: projectParam, issue_iid: issueIidParam },
  },
  {
    name: "create_issue",
    title: "Create issue",
    description: "Open an issue in a project",
    method: "POST",
    path: "/projects/{project_id}/issues",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "list_issues with order_by=created_at and look for the title",
    params: {
      project_id: projectParam,
      issue_title: { in: "body", wireName: "title", type: "string", required: true, minLength: 1 },
      description: { in: "body", type: "string", description: "Markdown" },
      labels: labelsBody,
      assignee_ids: idList("User ids to assign"),
      milestone_id: { in: "body", type: "integer" },
      due_date: { in: "body", type: "string", description: "YYYY-MM-DD" },
      confidential: { in: "body", type: "boolean" },
    },
  },
  {
    name: "update_issue",
    title: "Update issue",
    description: "Change an issue: title, description, labels, assignees, due date, or close/reopen with state_event",
    method: "PUT",
    path: "/projects/{project_id}/issues/{issue_iid}",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    params: {
      project_id: projectParam,
      issue_iid: issueIidParam,
      issue_title: { in: "body", wireName: "title", type: "string", minLength: 1 },
      description: { in: "body", type: "string" },
      state_event: { in: "body", type: "string", enum: ["close", "reopen"] },
      labels: { in: "body", type: "string", description: "Comma-separated labels (replaces all labels)" },
      add_labels: { in: "body", type: "string", description: "Comma-separated labels to add" },
      remove_labels: { in: "body", type: "string", description: "Comma-separated labels to remove" },
      assignee_ids: idList("User ids (replaces the assignees; [] to unassign)"),
      milestone_id: { in: "body", type: "integer" },
      due_date: { in: "body", type: "string", description: "YYYY-MM-DD" },
    },
  },
  {
    name: "delete_issue",
    title: "Delete issue",
    description: "Delete an issue permanently (project owners and admins only)",
    method: "DELETE",
    path: "/projects/{project_id}/issues/{issue_iid}",
    write: "idempotent",
    nodeOnly: true,
    params: { project_id: projectParam, issue_iid: issueIidParam },
  },
  {
    name: "list_issue_notes",
    title: "List issue comments",
    description: "Comments (notes) on an issue, including system notes",
    path: "/projects/{project_id}/issues/{issue_iid}/notes",
    params: { project_id: projectParam, issue_iid: issueIidParam, sort: sortParam, order_by: { in: "query", type: "string", enum: ["created_at", "updated_at"] } },
    response: LINK_PAGES,
  },
  {
    name: "create_issue_note",
    title: "Comment on issue",
    description: "Add a comment (note) to an issue",
    method: "POST",
    path: "/projects/{project_id}/issues/{issue_iid}/notes",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "list_issue_notes and look for the comment",
    params: { project_id: projectParam, issue_iid: issueIidParam, body: { in: "body", type: "string", required: true, minLength: 1, description: "Markdown" }, internal: { in: "body", type: "boolean", description: "Internal note (visible to members only)" } },
  },
];

// --- merge requests ---------------------------------------------------------------------------------

const mergeRequestOperations = [
  {
    name: "list_merge_requests",
    title: "List merge requests",
    description: "Merge requests of a project",
    path: "/projects/{project_id}/merge_requests",
    params: {
      project_id: projectParam,
      state: { in: "query", type: "string", enum: ["opened", "closed", "locked", "merged", "all"], default: "opened" },
      source_branch: { in: "query", type: "string" },
      target_branch: { in: "query", type: "string" },
      labels: { in: "query", type: "array", items: { type: "string" }, maxItems: 50 },
      search: { in: "query", type: "string" },
      author_username: { in: "query", type: "string" },
      reviewer_username: { in: "query", type: "string" },
      order_by: { in: "query", type: "string", enum: ["created_at", "updated_at", "merged_at", "title"] },
      sort: sortParam,
    },
    response: LINK_PAGES,
  },
  {
    name: "get_merge_request",
    title: "Get merge request",
    description: "One merge request: branches, state, merge status, pipeline, approvals summary",
    path: "/projects/{project_id}/merge_requests/{merge_request_iid}",
    params: { project_id: projectParam, merge_request_iid: mergeRequestIidParam },
  },
  {
    name: "list_merge_request_diffs",
    title: "List merge request diffs",
    description: "Changed files of a merge request with their diffs",
    path: "/projects/{project_id}/merge_requests/{merge_request_iid}/diffs",
    params: { project_id: projectParam, merge_request_iid: mergeRequestIidParam },
    response: LINK_PAGES,
  },
  {
    name: "create_merge_request",
    title: "Create merge request",
    description: 'Open a merge request from an existing branch (does not push code; prefix the title with "Draft:" for a draft)',
    method: "POST",
    path: "/projects/{project_id}/merge_requests",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "list_merge_requests with source_branch",
    params: {
      project_id: projectParam,
      source_branch: { in: "body", type: "string", required: true },
      target_branch: { in: "body", type: "string", required: true },
      mr_title: { in: "body", wireName: "title", type: "string", required: true, minLength: 1 },
      description: { in: "body", type: "string" },
      labels: labelsBody,
      assignee_ids: idList("User ids to assign"),
      reviewer_ids: idList("User ids to request review from"),
      remove_source_branch: { in: "body", type: "boolean" },
      squash: { in: "body", type: "boolean" },
    },
  },
  {
    name: "list_merge_request_notes",
    title: "List MR comments",
    description: "Comments (notes) on a merge request",
    path: "/projects/{project_id}/merge_requests/{merge_request_iid}/notes",
    params: { project_id: projectParam, merge_request_iid: mergeRequestIidParam, sort: sortParam },
    response: LINK_PAGES,
  },
  {
    name: "create_merge_request_note",
    title: "Comment on merge request",
    description: "Add a comment (note) to a merge request",
    method: "POST",
    path: "/projects/{project_id}/merge_requests/{merge_request_iid}/notes",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "list_merge_request_notes and look for the comment",
    params: { project_id: projectParam, merge_request_iid: mergeRequestIidParam, body: { in: "body", type: "string", required: true, minLength: 1 } },
  },
  {
    name: "merge_merge_request",
    title: "Merge merge request",
    description: "Merge a merge request (pass `sha` to merge only if the head has not moved)",
    method: "PUT",
    path: "/projects/{project_id}/merge_requests/{merge_request_iid}/merge",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_merge_request and look at state",
    params: {
      project_id: projectParam,
      merge_request_iid: mergeRequestIidParam,
      sha: { in: "body", type: "string", description: "Expected head SHA" },
      squash: { in: "body", type: "boolean" },
      should_remove_source_branch: { in: "body", type: "boolean" },
      merge_commit_message: { in: "body", type: "string" },
      auto_merge: { in: "body", type: "boolean", description: "Merge when the pipeline succeeds" },
    },
  },
];

// --- pipelines --------------------------------------------------------------------------------------

const pipelineOperations = [
  {
    name: "list_pipelines",
    title: "List pipelines",
    description: "CI/CD pipelines of a project, newest first",
    path: "/projects/{project_id}/pipelines",
    params: {
      project_id: projectParam,
      status: { in: "query", type: "string", enum: ["created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped", "manual", "scheduled"] },
      ref: { in: "query", type: "string", description: "Branch or tag" },
      sha: { in: "query", type: "string" },
      source: { in: "query", type: "string", description: "e.g. push, merge_request_event, schedule, web" },
      updated_after: { in: "query", type: "string", description: "ISO 8601 time" },
      order_by: { in: "query", type: "string", enum: ["id", "status", "ref", "updated_at", "user_id"] },
      sort: sortParam,
    },
    response: LINK_PAGES,
  },
  {
    name: "get_pipeline",
    title: "Get pipeline",
    description: "One pipeline: status, ref, sha, duration, coverage",
    path: "/projects/{project_id}/pipelines/{pipeline_id}",
    params: { project_id: projectParam, pipeline_id: pipelineIdParam },
  },
  {
    name: "list_pipeline_jobs",
    title: "List pipeline jobs",
    description: "Jobs of a pipeline with stage, status and failure reason",
    path: "/projects/{project_id}/pipelines/{pipeline_id}/jobs",
    params: {
      project_id: projectParam,
      pipeline_id: pipelineIdParam,
      scope: { in: "query", type: "array", items: { type: "string" }, style: "brackets", maxItems: 10, description: "Job statuses, e.g. failed, success, running" },
    },
    response: LINK_PAGES,
  },
  {
    name: "retry_pipeline",
    title: "Retry pipeline",
    description: "Retry the failed or canceled jobs of a pipeline (uses CI minutes)",
    method: "POST",
    path: "/projects/{project_id}/pipelines/{pipeline_id}/retry",
    write: "unsafe",
    toolPolicy: CI_OPT_IN,
    checkHint: "get_pipeline and look at status",
    params: { project_id: projectParam, pipeline_id: pipelineIdParam },
  },
  {
    name: "cancel_pipeline",
    title: "Cancel pipeline",
    description: "Cancel the running jobs of a pipeline",
    method: "POST",
    path: "/projects/{project_id}/pipelines/{pipeline_id}/cancel",
    write: "idempotent",
    toolPolicy: CI_OPT_IN,
    params: { project_id: projectParam, pipeline_id: pipelineIdParam },
  },
  {
    name: "create_pipeline",
    title: "Run pipeline",
    description: "Start a new pipeline for a branch or tag (may deploy)",
    method: "POST",
    path: "/projects/{project_id}/pipeline",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_pipelines with ref",
    params: {
      project_id: projectParam,
      ref: { in: "body", type: "string", required: true, description: "Branch or tag" },
      variables: { in: "body", type: "array", items: { type: "object" }, maxItems: 50, description: 'Pipeline variables, e.g. [{"key": "DEPLOY", "value": "1"}]' },
    },
  },
];

// --- repository -------------------------------------------------------------------------------------

const fileWriteParams = {
  project_id: projectParam,
  file_path: filePathParam,
  branch: { in: "body", type: "string", required: true },
  content: { in: "body", type: "string", required: true, description: "File content (text, or base64 with encoding=base64)" },
  commit_message: { in: "body", type: "string", required: true, minLength: 1 },
  encoding: { in: "body", type: "string", enum: ["text", "base64"] },
  start_branch: { in: "body", type: "string", description: "Create `branch` from this branch" },
};
const repositoryOperations = [
  {
    name: "get_file",
    title: "Get file",
    description: "A file at a ref: metadata plus content (base64 in `content`)",
    path: "/projects/{project_id}/repository/files/{file_path}",
    params: { project_id: projectParam, file_path: filePathParam, ref: { in: "query", type: "string", required: true, description: "Branch, tag or commit SHA" } },
  },
  {
    name: "list_repository_tree",
    title: "List repository tree",
    description: "Files and directories at a path and ref",
    path: "/projects/{project_id}/repository/tree",
    params: {
      project_id: projectParam,
      path: { in: "query", type: "string", description: "Directory path (default: root)" },
      ref: { in: "query", type: "string", description: "Branch, tag or SHA (default: default branch)" },
      recursive: { in: "query", type: "boolean" },
    },
    response: LINK_PAGES,
  },
  {
    name: "create_file",
    title: "Commit a new file",
    description: "Create a file with a commit",
    method: "POST",
    path: "/projects/{project_id}/repository/files/{file_path}",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_file on the branch",
    params: fileWriteParams,
  },
  {
    name: "update_file",
    title: "Commit a file change",
    description: "Replace a file's content with a commit (pass last_commit_id to refuse if it changed meanwhile)",
    method: "PUT",
    path: "/projects/{project_id}/repository/files/{file_path}",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_file on the branch and compare last_commit_id",
    params: { ...fileWriteParams, last_commit_id: { in: "body", type: "string" } },
  },
];

const restDefinition = defineRestPlugin({
  name: "gitlab",
  version: "0.1.0",
  description: "GitLab REST API v4 (gitlab.com or self-hosted): projects, issues, merge requests, pipelines and repository files",
  apiName: "GitLab REST API",
  baseUrl: resolveGitLabApiUrl,
  extraEnv: ["GITLAB_BASE_URL", ALLOWED_PROJECTS_ENV, "GITLAB_TOOL_API_EXTRA_PATHS"],
  auth: { type: "bearer", env: "GITLAB_TOKEN" },
  // Errors are {"message": "401 Unauthorized"} or {"message": {"field": ["..."]}} or {"error": "...", "error_description": "..."}.
  errors: { messagePath: ["message", "error_description", "error"] },
  apiRequest: { examplePath: "/projects/group%2Fproject/repository/branches" },
  operations: [...projectOperations, ...issueOperations, ...mergeRequestOperations, ...pipelineOperations, ...repositoryOperations],
});

const guardedDefinition = guardToolApiRequest(restDefinition, {
  allowedPaths: TOOL_API_PATHS,
  blockedPaths: TOOL_API_BLOCKED_PATHS,
  extraAllowedPathsEnv: "GITLAB_TOOL_API_EXTRA_PATHS",
  normalizeOptions: { encodedSlashes: "opaque", stripFormatSuffix: true },
  reason: "agent tools may only read projects, issues, merge requests, pipelines, job metadata, repository files and groups; use a workflow node",
});

export const pluginDefinition = requireAllowedTarget(guardedDefinition, {
  operationNames: restDefinition.restSpec.operations.filter((operation) => operation.toolPolicy).map((operation) => operation.name),
  envName: ALLOWED_PROJECTS_ENV,
  describeTarget: (args) => args.project_id,
  label: "project",
});
