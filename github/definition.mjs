/**
 * github plugin definition: repositories, issues, pull requests, contents, search, releases, Actions runs and
 * notifications through the GitHub REST API (https://docs.github.com/en/rest), API version 2026-03-10.
 * Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Agent policy: reads are tools; issue/PR/comment writes need GITHUB_TOOL_ALLOW_WRITE=1 and workflow re-runs
 * GITHUB_TOOL_ALLOW_CI=1, both only on repositories in GITHUB_TOOL_ALLOWED_REPOS; merges, file commits, releases and
 * deletes are node only; api_request cannot reach variables or hooks as a tool. Rate-limit 403s are rate_limited.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { refuseToolArguments, requireAllowedTarget } from "./lib/tool-call-policy.mjs";
import { withRateLimitDetection } from "./lib/rate-limit-fetch.mjs";

const WRITE_OPT_IN = "optIn:GITHUB_TOOL_ALLOW_WRITE";
const CI_OPT_IN = "optIn:GITHUB_TOOL_ALLOW_CI";
const ALLOWED_REPOS_ENV = "GITHUB_TOOL_ALLOWED_REPOS";
// Actions/environment/organization variables (plain-text config values) and webhook configs (secrets) are not for tools.
const TOOL_API_BLOCKED_PATHS = [/(^|\/)(variables|hooks)(\/|$)/];
const LINK_PAGES = { nextLinkHeader: true, limitParam: "per_page", maxLimit: 100 };

const ownerParam = { in: "path", type: "string", required: true, description: "Repository owner (user or organization login)" };
const repoParam = { in: "path", type: "string", required: true, description: "Repository name without .git" };
const repoParams = { owner: ownerParam, repo: repoParam };
const issueNumberParam = { in: "path", type: "integer", required: true, min: 1, description: "Issue or pull request number" };
const pullNumberParam = { in: "path", type: "integer", required: true, min: 1, description: "Pull request number" };
const directionParam = { in: "query", type: "string", enum: ["asc", "desc"], description: "Sort direction" };
const sinceParam = { in: "query", type: "string", description: "Only items updated at or after this ISO 8601 time" };
const stringList = (description) => ({ in: "body", type: "array", items: { type: "string" }, maxItems: 100, description });

// --- users and repositories -------------------------------------------------------------------------

const userAndRepoOperations = [
  {
    name: "get_authenticated_user",
    title: "Authenticated user",
    description: "The user the token belongs to (login, name, plan); a cheap way to check the token",
    path: "/user",
  },
  {
    name: "list_my_repos",
    title: "List my repositories",
    description: "Repositories the authenticated user can access (owned, collaborator, organization member)",
    path: "/user/repos",
    params: {
      visibility: { in: "query", type: "string", enum: ["all", "public", "private"] },
      affiliation: { in: "query", type: "string", description: "Comma list of owner, collaborator, organization_member" },
      sort: { in: "query", type: "string", enum: ["created", "updated", "pushed", "full_name"], default: "updated" },
      direction: directionParam,
    },
    response: LINK_PAGES,
  },
  {
    name: "list_org_repos",
    title: "List organization repositories",
    description: "Repositories of an organization",
    path: "/orgs/{org}/repos",
    params: {
      org: { in: "path", type: "string", required: true, description: "Organization login" },
      repo_type: { in: "query", wireName: "type", type: "string", enum: ["all", "public", "private", "forks", "sources", "member"] },
      sort: { in: "query", type: "string", enum: ["created", "updated", "pushed", "full_name"], default: "updated" },
      direction: directionParam,
    },
    response: LINK_PAGES,
  },
  {
    name: "get_repo",
    title: "Get repository",
    description: "One repository: description, default branch, visibility, topics, counts",
    path: "/repos/{owner}/{repo}",
    params: repoParams,
  },
  {
    name: "get_contents",
    title: "Get file or directory",
    description:
      "A file (content base64-encoded in `content`) or a directory listing at a path in the repository; files over 1 MB come without content",
    path: "/repos/{owner}/{repo}/contents/{+file_path}",
    params: {
      ...repoParams,
      file_path: { in: "path", type: "string", required: true, description: "Path in the repository, e.g. src/index.js or docs" },
      ref: { in: "query", type: "string", description: "Branch, tag or commit SHA (default: the default branch)" },
    },
  },
  {
    name: "create_or_update_file",
    title: "Commit a file",
    description: "Create or replace one file with a commit (content base64-encoded; pass `sha` of the current file to replace it)",
    method: "PUT",
    path: "/repos/{owner}/{repo}/contents/{+file_path}",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_contents for the path and compare the sha",
    params: {
      ...repoParams,
      file_path: { in: "path", type: "string", required: true, description: "Path in the repository" },
      message: { in: "body", type: "string", required: true, minLength: 1, description: "Commit message" },
      content: { in: "body", type: "string", required: true, description: "New file content, base64-encoded" },
      sha: { in: "body", type: "string", description: "Blob SHA of the file being replaced (required to update)" },
      branch: { in: "body", type: "string", description: "Branch (default: the default branch)" },
    },
  },
];

// --- issues -----------------------------------------------------------------------------------------

const issueOperations = [
  {
    name: "list_issues",
    title: "List issues",
    description: "Issues of a repository (pull requests are included too and have a `pull_request` key)",
    path: "/repos/{owner}/{repo}/issues",
    params: {
      ...repoParams,
      state: { in: "query", type: "string", enum: ["open", "closed", "all"], default: "open" },
      labels: { in: "query", type: "array", items: { type: "string" }, maxItems: 50, description: "Only issues with all these labels" },
      assignee: { in: "query", type: "string", description: 'Assignee login, "none" or "*"' },
      creator: { in: "query", type: "string", description: "Creator login" },
      mentioned: { in: "query", type: "string", description: "Login mentioned in the issue" },
      milestone: { in: "query", type: "string", description: 'Milestone number, "none" or "*"' },
      sort: { in: "query", type: "string", enum: ["created", "updated", "comments"] },
      direction: directionParam,
      since: sinceParam,
    },
    response: LINK_PAGES,
  },
  {
    name: "get_issue",
    title: "Get issue",
    description: "One issue (or pull request as an issue) with body, labels, assignees and state",
    path: "/repos/{owner}/{repo}/issues/{issue_number}",
    params: { ...repoParams, issue_number: issueNumberParam },
  },
  {
    name: "create_issue",
    title: "Create issue",
    description: "Open an issue in a repository",
    method: "POST",
    path: "/repos/{owner}/{repo}/issues",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "list_issues with sort=created and look for the title",
    params: {
      ...repoParams,
      issue_title: { in: "body", wireName: "title", type: "string", required: true, minLength: 1 },
      body: { in: "body", type: "string", description: "Markdown body" },
      assignees: stringList("Logins to assign"),
      labels: stringList("Label names"),
      milestone: { in: "body", type: "integer", description: "Milestone number" },
      issue_type: { in: "body", wireName: "type", type: "string", description: "Issue type name (organizations with issue types)" },
    },
  },
  {
    name: "update_issue",
    title: "Update issue",
    description: "Change an issue's title, body, state, labels, assignees or milestone (given fields only; labels and assignees are replaced)",
    method: "PATCH",
    path: "/repos/{owner}/{repo}/issues/{issue_number}",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    params: {
      ...repoParams,
      issue_number: issueNumberParam,
      issue_title: { in: "body", wireName: "title", type: "string", minLength: 1 },
      body: { in: "body", type: "string" },
      state: { in: "body", type: "string", enum: ["open", "closed"] },
      state_reason: { in: "body", type: "string", enum: ["completed", "not_planned", "duplicate", "reopened"] },
      assignees: stringList("Logins (replaces the assignees)"),
      labels: stringList("Label names (replaces the labels)"),
      milestone: { in: "body", type: "integer", description: "Milestone number" },
    },
  },
  {
    name: "list_issue_comments",
    title: "List issue comments",
    description: "Comments on an issue or pull request conversation, oldest first",
    path: "/repos/{owner}/{repo}/issues/{issue_number}/comments",
    params: { ...repoParams, issue_number: issueNumberParam, since: sinceParam },
    response: LINK_PAGES,
  },
  {
    name: "create_issue_comment",
    title: "Comment on issue or PR",
    description: "Add a comment to an issue or a pull request conversation",
    method: "POST",
    path: "/repos/{owner}/{repo}/issues/{issue_number}/comments",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "list_issue_comments and look for the comment",
    params: { ...repoParams, issue_number: issueNumberParam, body: { in: "body", type: "string", required: true, minLength: 1, description: "Markdown" } },
  },
];

// --- pull requests ----------------------------------------------------------------------------------

const pullOperations = [
  {
    name: "list_pulls",
    title: "List pull requests",
    description: "Pull requests of a repository",
    path: "/repos/{owner}/{repo}/pulls",
    params: {
      ...repoParams,
      state: { in: "query", type: "string", enum: ["open", "closed", "all"], default: "open" },
      head: { in: "query", type: "string", description: "Filter by head as user:branch" },
      base: { in: "query", type: "string", description: "Filter by base branch" },
      sort: { in: "query", type: "string", enum: ["created", "updated", "popularity", "long-running"] },
      direction: directionParam,
    },
    response: LINK_PAGES,
  },
  {
    name: "get_pull",
    title: "Get pull request",
    description: "One pull request: head and base, mergeable state, draft, review requests, counts",
    path: "/repos/{owner}/{repo}/pulls/{pull_number}",
    params: { ...repoParams, pull_number: pullNumberParam },
  },
  {
    name: "list_pull_files",
    title: "List pull request files",
    description: "Files changed in a pull request, with status, additions, deletions and patch (up to 3000 files)",
    path: "/repos/{owner}/{repo}/pulls/{pull_number}/files",
    params: { ...repoParams, pull_number: pullNumberParam },
    response: LINK_PAGES,
  },
  {
    name: "create_pull",
    title: "Create pull request",
    description: "Open a pull request from an existing branch (does not push code)",
    method: "POST",
    path: "/repos/{owner}/{repo}/pulls",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "list_pulls with head=<owner>:<branch>",
    params: {
      ...repoParams,
      pr_title: { in: "body", wireName: "title", type: "string", required: true, minLength: 1 },
      head: { in: "body", type: "string", required: true, description: "Branch with the changes (user:branch for forks)" },
      base: { in: "body", type: "string", required: true, description: "Branch to merge into" },
      body: { in: "body", type: "string", description: "Markdown description" },
      draft: { in: "body", type: "boolean" },
      maintainer_can_modify: { in: "body", type: "boolean" },
    },
  },
  {
    name: "list_pull_review_comments",
    title: "List PR review comments",
    description: "Review comments on the diff of a pull request (line comments)",
    path: "/repos/{owner}/{repo}/pulls/{pull_number}/comments",
    params: {
      ...repoParams,
      pull_number: pullNumberParam,
      sort: { in: "query", type: "string", enum: ["created", "updated"] },
      direction: directionParam,
      since: sinceParam,
    },
    response: LINK_PAGES,
  },
  {
    name: "create_pull_review_comment",
    title: "Comment on PR diff",
    description: "Add a review comment on a line of a pull request's diff, or reply to one with in_reply_to",
    method: "POST",
    path: "/repos/{owner}/{repo}/pulls/{pull_number}/comments",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "list_pull_review_comments and look for the comment",
    params: {
      ...repoParams,
      pull_number: pullNumberParam,
      body: { in: "body", type: "string", required: true, minLength: 1 },
      commit_id: { in: "body", type: "string", required: true, description: "SHA of the commit to comment on (usually the PR head)" },
      path: { in: "body", type: "string", required: true, description: "File path relative to the repository root" },
      line: { in: "body", type: "integer", min: 1, description: "Line in the diff to comment on" },
      side: { in: "body", type: "string", enum: ["LEFT", "RIGHT"], description: "RIGHT for added/unchanged lines (default), LEFT for deletions" },
      start_line: { in: "body", type: "integer", min: 1, description: "First line of a multi-line comment" },
      start_side: { in: "body", type: "string", enum: ["LEFT", "RIGHT"] },
      in_reply_to: { in: "body", type: "integer", description: "Id of a review comment to reply to (other fields but body are ignored)" },
      subject_type: { in: "body", type: "string", enum: ["line", "file"] },
    },
  },
  {
    name: "merge_pull",
    title: "Merge pull request",
    description: "Merge a pull request (pass `sha` to merge only if the head has not moved)",
    method: "PUT",
    path: "/repos/{owner}/{repo}/pulls/{pull_number}/merge",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "get_pull and look at `merged`",
    params: {
      ...repoParams,
      pull_number: pullNumberParam,
      merge_method: { in: "body", type: "string", enum: ["merge", "squash", "rebase"] },
      commit_title: { in: "body", type: "string" },
      commit_message: { in: "body", type: "string" },
      sha: { in: "body", type: "string", description: "Expected head SHA" },
    },
  },
];

// --- search, releases, actions, notifications -------------------------------------------------------

const searchOperations = [
  {
    name: "search_code",
    title: "Search code",
    description: 'Search code across GitHub, e.g. q "parseConfig repo:owner/name language:go" (10 requests a minute)',
    path: "/search/code",
    params: { q: { in: "query", type: "string", required: true, minLength: 1, description: "GitHub code search query with qualifiers" } },
    response: { ...LINK_PAGES, dataPath: "items" },
  },
  {
    name: "search_issues",
    title: "Search issues and PRs",
    description: 'Search issues and pull requests, e.g. q "repo:owner/name is:pr is:open review-requested:@me"',
    path: "/search/issues",
    params: {
      q: { in: "query", type: "string", required: true, minLength: 1, description: "Query with qualifiers; include is:issue or is:pr" },
      sort: { in: "query", type: "string", enum: ["comments", "reactions", "created", "updated", "interactions"] },
      order: { in: "query", type: "string", enum: ["asc", "desc"] },
      advanced_search: { in: "query", type: "boolean", description: "Use advanced search syntax (AND/OR and parentheses)" },
    },
    response: { ...LINK_PAGES, dataPath: "items" },
  },
];

const releaseParams = { ...repoParams, release_id: { in: "path", type: "integer", required: true, min: 1, description: "Release id" } };
const releaseOperations = [
  {
    name: "list_releases",
    title: "List releases",
    description: "Releases of a repository, newest first (drafts only with push access)",
    path: "/repos/{owner}/{repo}/releases",
    params: repoParams,
    response: LINK_PAGES,
  },
  {
    name: "get_latest_release",
    title: "Latest release",
    description: "The latest published, non-prerelease release",
    path: "/repos/{owner}/{repo}/releases/latest",
    params: repoParams,
  },
  {
    name: "get_release",
    title: "Get release",
    description: "One release with notes and assets",
    path: "/repos/{owner}/{repo}/releases/{release_id}",
    params: releaseParams,
  },
  {
    name: "create_release",
    title: "Create release",
    description: "Publish a release (creates the tag from target_commitish when it does not exist; may trigger deploy workflows)",
    method: "POST",
    path: "/repos/{owner}/{repo}/releases",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_releases and look for the tag",
    params: {
      ...repoParams,
      tag_name: { in: "body", type: "string", required: true, minLength: 1 },
      target_commitish: { in: "body", type: "string", description: "Branch or SHA for a new tag (default: the default branch)" },
      name: { in: "body", type: "string" },
      body: { in: "body", type: "string", description: "Release notes (Markdown)" },
      draft: { in: "body", type: "boolean" },
      prerelease: { in: "body", type: "boolean" },
      generate_release_notes: { in: "body", type: "boolean" },
      make_latest: { in: "body", type: "string", enum: ["true", "false", "legacy"] },
    },
  },
  {
    name: "delete_release",
    title: "Delete release",
    description: "Delete a release (the tag stays)",
    method: "DELETE",
    path: "/repos/{owner}/{repo}/releases/{release_id}",
    write: "idempotent",
    nodeOnly: true,
    params: releaseParams,
  },
];

const runIdParam = { in: "path", type: "integer", required: true, min: 1, description: "Workflow run id" };
const actionsOperations = [
  {
    name: "list_workflow_runs",
    title: "List workflow runs",
    description: "GitHub Actions runs of a repository, newest first",
    path: "/repos/{owner}/{repo}/actions/runs",
    params: {
      ...repoParams,
      branch: { in: "query", type: "string" },
      event: { in: "query", type: "string", description: "Trigger event, e.g. push, pull_request" },
      status: {
        in: "query",
        type: "string",
        enum: ["completed", "action_required", "cancelled", "failure", "neutral", "skipped", "stale", "success", "timed_out", "in_progress", "queued", "requested", "waiting", "pending"],
      },
      actor: { in: "query", type: "string", description: "Login of the user who triggered the run" },
      head_sha: { in: "query", type: "string" },
      created: { in: "query", type: "string", description: "Date range, e.g. >=2026-11-01" },
    },
    response: { ...LINK_PAGES, dataPath: "workflow_runs" },
  },
  {
    name: "get_workflow_run",
    title: "Get workflow run",
    description: "One workflow run: status, conclusion, head commit, timing and links",
    path: "/repos/{owner}/{repo}/actions/runs/{run_id}",
    params: { ...repoParams, run_id: runIdParam },
  },
  {
    name: "rerun_workflow_run",
    title: "Re-run workflow",
    description: "Re-run every job of a workflow run (uses Actions minutes; rerun_failed_jobs re-runs only failed ones)",
    method: "POST",
    path: "/repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
    write: "unsafe",
    toolPolicy: CI_OPT_IN,
    checkHint: "get_workflow_run and look at run_attempt",
    params: { ...repoParams, run_id: runIdParam, enable_debug_logging: { in: "body", type: "boolean", description: "Debug logs (workflow nodes only)" } },
  },
  {
    name: "rerun_failed_jobs",
    title: "Re-run failed jobs",
    description: "Re-run only the failed jobs of a workflow run (uses Actions minutes)",
    method: "POST",
    path: "/repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs",
    write: "unsafe",
    toolPolicy: CI_OPT_IN,
    checkHint: "get_workflow_run and look at run_attempt",
    params: { ...repoParams, run_id: runIdParam, enable_debug_logging: { in: "body", type: "boolean", description: "Debug logs (workflow nodes only)" } },
  },
];

const notificationOperations = [
  {
    name: "list_notifications",
    title: "List notifications",
    description: "Notification threads of the authenticated user (unread only unless all=true); needs a classic token with notifications scope",
    path: "/notifications",
    params: {
      all: { in: "query", type: "boolean", description: "Include read notifications" },
      participating: { in: "query", type: "boolean", description: "Only threads you participate in or are mentioned in" },
      since: sinceParam,
      before: { in: "query", type: "string", description: "Only notifications updated before this ISO 8601 time" },
    },
    response: LINK_PAGES,
  },
  {
    name: "mark_notification_read",
    title: "Mark notification read",
    description: "Mark one notification thread as read",
    method: "PATCH",
    path: "/notifications/threads/{thread_id}",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    params: { thread_id: { in: "path", type: "string", required: true, description: "Thread id from list_notifications" } },
  },
];

const restDefinition = defineRestPlugin({
  name: "github",
  version: "0.1.0",
  description: "GitHub REST API: repositories, issues, pull requests, file contents, code and issue search, releases, Actions runs and notifications",
  apiName: "GitHub REST API",
  baseUrl: "https://api.github.com",
  auth: { type: "bearer", env: "GITHUB_TOKEN" },
  extraEnv: [ALLOWED_REPOS_ENV],
  defaultHeaders: { accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10" },
  // Errors are {"message": "...", "documentation_url": "...", "errors": [{...}]}.
  errors: { messagePath: ["message", "errors.0.message"] },
  apiRequest: { examplePath: "/repos/octocat/hello-world/branches" },
  operations: [...userAndRepoOperations, ...issueOperations, ...pullOperations, ...searchOperations, ...releaseOperations, ...actionsOperations, ...notificationOperations],
});

const repositoryWriteNames = restDefinition.restSpec.operations
  .filter((operation) => operation.toolPolicy && "owner" in operation.params && "repo" in operation.params)
  .map((operation) => operation.name);

const policedDefinition = refuseToolArguments(
  requireAllowedTarget(
    guardToolApiRequest(restDefinition, { blockedPaths: TOOL_API_BLOCKED_PATHS, reason: "variables and webhook configurations are not available to agent tools; use a workflow node" }),
    { operationNames: repositoryWriteNames, envName: ALLOWED_REPOS_ENV, describeTarget: (args) => `${args.owner}/${args.repo}`, label: "repository" },
  ),
  { operationNames: ["rerun_workflow_run", "rerun_failed_jobs"], argumentNames: ["enable_debug_logging"], reason: "debug logs can print secrets; use a workflow node" },
);

export const pluginDefinition = withRateLimitDetection(policedDefinition);
