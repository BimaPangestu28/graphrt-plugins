/**
 * jira plugin definition: JQL search, issues, transitions, comments and projects through the Jira Cloud platform
 * REST API v3 (https://developer.atlassian.com/cloud/jira/platform/rest/v3/). Basic auth with an Atlassian
 * account email and API token; the site URL comes from JIRA_SITE_URL and must be on *.atlassian.net.
 * Built with the declarative REST layer (docs/declarative-plugins.md) plus plain-text-to-ADF parameters (lib/adf.mjs).
 *
 * Agent policy: reads are tools; creates, updates, transitions, assignments and comments need
 * JIRA_TOOL_ALLOW_WRITE=1 for tools; deletes are node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { acceptPlainText } from "./lib/adf.mjs";
import { requireSomeArguments } from "./lib/require-some-arguments.mjs";

const WRITE_OPT_IN = "optIn:JIRA_TOOL_ALLOW_WRITE";
const SITE_HOST_SUFFIX = ".atlassian.net";
const DEFAULT_SEARCH_FIELDS = ["summary", "status", "assignee", "reporter", "priority", "issuetype", "created", "updated"];
const OFFSET_PAGES = (dataPath) => ({ dataPath, offsetPagination: { offsetParam: "startAt", limitParam: "maxResults", totalPath: "total" }, maxLimit: 100 });

/**
 * Resolves the REST base URL from JIRA_SITE_URL, e.g. https://acme.atlassian.net.
 *
 * @param environment - Plugin environment (object)
 * @returns `https://<site>.atlassian.net/rest/api/3` (string)
 * @throws Error - Missing, not a URL, credentials, a port, a path, query or fragment, or not on atlassian.net (invalid_input)
 *
 * @example
 * resolveJiraApiUrl({ JIRA_SITE_URL: "https://acme.atlassian.net/" }); // "https://acme.atlassian.net/rest/api/3"
 */
export function resolveJiraApiUrl(environment) {
  const siteText = environment.JIRA_SITE_URL?.trim();
  if (!siteText) throw new Error("Set JIRA_SITE_URL to your Jira Cloud site, e.g. https://acme.atlassian.net");
  let siteUrl;
  try {
    siteUrl = new URL(siteText);
  } catch {
    throw new Error("JIRA_SITE_URL must be a URL like https://acme.atlassian.net");
  }
  if (siteUrl.username || siteUrl.password || siteUrl.search || siteUrl.hash || siteUrl.pathname.replace(/\/+$/, "") !== "") {
    throw new Error("JIRA_SITE_URL must be just the site, e.g. https://acme.atlassian.net (no path, query or credentials)");
  }
  if (siteUrl.port !== "") throw new Error("JIRA_SITE_URL must not have a port; Jira Cloud sites use https on 443");
  if (!siteUrl.hostname.toLowerCase().endsWith(SITE_HOST_SUFFIX)) throw new Error("JIRA_SITE_URL must be a Jira Cloud site on atlassian.net");
  return `${siteUrl.origin}/rest/api/3`;
}

const issueKeyParam = { in: "path", type: "string", required: true, description: "Issue key or id, e.g. OPS-12" };
const projectKeyParam = { in: "path", type: "string", required: true, description: "Project key or id, e.g. OPS" };
const fieldListParam = (description, defaultFields) => ({
  in: "query",
  type: "array",
  items: { type: "string" },
  maxItems: 100,
  description,
  ...(defaultFields ? { default: defaultFields } : {}),
});
const adfParam = (wireName, description) => ({ in: "body", type: "object", wireName, description: `${description} as an ADF document` });
const issueFieldParams = {
  summary: { in: "body", type: "string", minLength: 1, wireName: "fields.summary" },
  description: adfParam("fields.description", "Description"),
  labels: { in: "body", type: "array", items: { type: "string" }, maxItems: 50, wireName: "fields.labels", description: "Labels (replaces all labels)" },
  priority: { in: "body", type: "string", wireName: "fields.priority.name", description: "Priority name, e.g. High" },
  assignee_account_id: { in: "body", type: "string", wireName: "fields.assignee.accountId", description: "Assignee accountId (see find_assignable_users)" },
  due_date: { in: "body", type: "string", wireName: "fields.duedate", description: "YYYY-MM-DD" },
};

// --- search and issues --------------------------------------------------------------------------------

const issueOperations = [
  { name: "get_myself", title: "Current user", description: "The Atlassian account the credentials belong to; a cheap way to check them", path: "/myself" },
  {
    name: "search_issues",
    title: "Search issues (JQL)",
    description: 'Search issues with JQL, e.g. "project = OPS AND statusCategory != Done ORDER BY updated DESC" (bounded queries only; no total count)',
    path: "/search/jql",
    params: {
      jql: { in: "query", type: "string", required: true, minLength: 1, description: "JQL query; must restrict the search, e.g. by project" },
      fields: fieldListParam("Fields to return (*all, *navigable or names)", DEFAULT_SEARCH_FIELDS),
      expand: { in: "query", type: "string", description: "e.g. renderedFields,names,changelog" },
    },
    response: { dataPath: "issues", cursorPath: "nextPageToken", cursorParam: "nextPageToken", limitParam: "maxResults", maxLimit: 100 },
  },
  {
    name: "get_issue",
    title: "Get issue",
    description: "One issue with all fields (description and comments are ADF)",
    path: "/issue/{issue_key}",
    params: { issue_key: issueKeyParam, fields: fieldListParam("Fields to return (default all)"), expand: { in: "query", type: "string", description: "e.g. renderedFields,transitions,changelog" } },
  },
  {
    name: "create_issue",
    title: "Create issue",
    description: "Create an issue in a project",
    method: "POST",
    path: "/issue",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: 'search_issues with jql "project = <KEY> AND created >= -10m" and look for the summary',
    params: {
      project_key: { in: "body", type: "string", required: true, wireName: "fields.project.key", description: "Project key, e.g. OPS" },
      issue_type: { in: "body", type: "string", required: true, wireName: "fields.issuetype.name", description: "Issue type name, e.g. Task, Bug, Story" },
      ...issueFieldParams,
      summary: { ...issueFieldParams.summary, required: true },
      parent_key: { in: "body", type: "string", wireName: "fields.parent.key", description: "Parent issue key (for subtasks and child issues)" },
    },
  },
  {
    name: "update_issue",
    title: "Update issue",
    description: "Change an issue's summary, description, labels, priority, assignee or due date (given fields only)",
    method: "PUT",
    path: "/issue/{issue_key}",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    params: { issue_key: issueKeyParam, ...issueFieldParams, notify_users: { in: "query", type: "boolean", wireName: "notifyUsers", description: "Email watchers (default true)" } },
  },
  {
    name: "delete_issue",
    title: "Delete issue",
    description: "Delete an issue permanently",
    method: "DELETE",
    path: "/issue/{issue_key}",
    write: "idempotent",
    nodeOnly: true,
    params: { issue_key: issueKeyParam, delete_subtasks: { in: "query", type: "boolean", wireName: "deleteSubtasks" } },
  },
  {
    name: "assign_issue",
    title: "Assign issue",
    description: "Assign an issue to a user by accountId",
    method: "PUT",
    path: "/issue/{issue_key}/assignee",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    params: { issue_key: issueKeyParam, account_id: { in: "body", type: "string", required: true, wireName: "accountId", description: "Assignee accountId" } },
  },
];

// --- transitions and comments -------------------------------------------------------------------------

const workflowOperations = [
  {
    name: "list_transitions",
    title: "List transitions",
    description: "Workflow transitions available for an issue now (id and target status), for transition_issue",
    path: "/issue/{issue_key}/transitions",
    params: { issue_key: issueKeyParam },
    response: { dataPath: "transitions" },
  },
  {
    name: "transition_issue",
    title: "Transition issue",
    description: "Move an issue through its workflow with a transition id from list_transitions",
    method: "POST",
    path: "/issue/{issue_key}/transitions",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "get_issue and look at fields.status",
    params: {
      issue_key: issueKeyParam,
      transition_id: { in: "body", type: "string", required: true, wireName: "transition.id" },
      resolution: { in: "body", type: "string", wireName: "fields.resolution.name", description: "Resolution name when the screen asks for one, e.g. Done" },
    },
  },
  {
    name: "list_comments",
    title: "List comments",
    description: "Comments on an issue (bodies are ADF)",
    path: "/issue/{issue_key}/comment",
    params: { issue_key: issueKeyParam, order_by: { in: "query", type: "string", enum: ["created", "-created"], wireName: "orderBy" } },
    response: OFFSET_PAGES("comments"),
  },
  {
    name: "add_comment",
    title: "Comment on issue",
    description: "Add a comment to an issue (plain `text` or an ADF `body`)",
    method: "POST",
    path: "/issue/{issue_key}/comment",
    write: "unsafe",
    toolPolicy: WRITE_OPT_IN,
    checkHint: "list_comments with order_by=-created",
    params: { issue_key: issueKeyParam, body: adfParam("body", "Comment") },
  },
];

// --- projects and users -------------------------------------------------------------------------------

const projectOperations = [
  {
    name: "list_projects",
    title: "List projects",
    description: "Projects visible to the user",
    path: "/project/search",
    params: {
      query: { in: "query", type: "string", description: "Match in key or name" },
      order_by: { in: "query", type: "string", wireName: "orderBy", description: "e.g. key, name, -lastIssueUpdatedTime" },
    },
    response: OFFSET_PAGES("values"),
  },
  {
    name: "get_project",
    title: "Get project",
    description: "One project with its issue types, lead and components",
    path: "/project/{project_key}",
    params: { project_key: projectKeyParam },
  },
  {
    name: "list_issue_types",
    title: "List issue types",
    description: "Issue types you can create in a project (names for create_issue)",
    path: "/issue/createmeta/{project_key}/issuetypes",
    params: { project_key: projectKeyParam },
    response: OFFSET_PAGES("issueTypes"),
  },
  {
    name: "find_assignable_users",
    title: "Find assignable users",
    description: "Users who can be assigned in a project or issue (accountId for assignments)",
    path: "/user/assignable/search",
    params: {
      query: { in: "query", type: "string", description: "Match in display name or email" },
      project: { in: "query", type: "string", description: "Project key (this or issue_key is required)" },
      issue_key: { in: "query", type: "string", wireName: "issueKey" },
    },
    response: { offsetPagination: { offsetParam: "startAt", limitParam: "maxResults" }, maxLimit: 100 },
  },
];

const restDefinition = defineRestPlugin({
  name: "jira",
  version: "0.1.0",
  description: "Jira Cloud REST API v3: JQL search, issues (create, update, assign, transition), comments, projects and issue types",
  apiName: "Jira Cloud REST API v3",
  baseUrl: resolveJiraApiUrl,
  allowedHostSuffix: SITE_HOST_SUFFIX,
  extraEnv: ["JIRA_SITE_URL"],
  auth: { type: "basic", userEnv: "JIRA_EMAIL", passwordEnv: "JIRA_API_TOKEN" },
  // Errors are {"errorMessages": ["..."], "errors": {"field": "..."}}.
  errors: { messagePath: ["errorMessages.0", "errors.summary", "errors.description", "errors.project", "errors.issuetype", "errors.jql", "message"] },
  apiRequest: { examplePath: "/issue/OPS-1/changelog" },
  operations: [...issueOperations, ...workflowOperations, ...projectOperations],
});

const plainTextDefinition = acceptPlainText(restDefinition, [
  { operationName: "add_comment", textParam: "text", adfParam: "body", required: true },
  { operationName: "create_issue", textParam: "description_text", adfParam: "description" },
  { operationName: "update_issue", textParam: "description_text", adfParam: "description" },
]);

// update_issue must change something; description_text counts (it becomes description).
export const pluginDefinition = requireSomeArguments(plainTextDefinition, {
  operationName: "update_issue",
  argumentNames: [...Object.keys(issueFieldParams), "description_text"],
});
