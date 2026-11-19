/**
 * linear plugin definition: issues, comments, projects, teams, workflow states and users through the Linear GraphQL
 * API (https://linear.app/developers/graphql). Every operation is a POST to /graphql with a constant query document
 * and typed variables, so callers never send free-form GraphQL (except through api_request as a node).
 * Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Agent policy: reads are tools; creating/updating issues and comments needs LINEAR_TOOL_ALLOW_WRITE=1 for tools;
 * deleting (trashing) issues is node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { requireSomeArguments } from "./lib/require-some-arguments.mjs";

const WRITE_OPT_IN = "optIn:LINEAR_TOOL_ALLOW_WRITE";
const GRAPHQL_PATH = "/graphql";

const ISSUE_SUMMARY_FIELDS = `id identifier title url priority priorityLabel estimate dueDate createdAt updatedAt completedAt
  state { id name type } assignee { id name email } team { id key name } project { id name } labels { nodes { id name } }`;
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

/**
 * Pagination spec for a GraphQL connection at `data.<connectionPath>` (Relay style: first/after, pageInfo).
 *
 * @param connectionPath - Path of the connection under `data`, e.g. "issues" or "issue.comments" (string)
 * @returns Declarative `response` spec (object)
 */
function connectionPages(connectionPath) {
  return {
    dataPath: `data.${connectionPath}.nodes`,
    cursorPath: `data.${connectionPath}.pageInfo.endCursor`,
    hasMorePath: `data.${connectionPath}.pageInfo.hasNextPage`,
    cursorParam: "variables.after",
    limitParam: "variables.first",
    defaultLimit: 50,
    maxLimit: 250,
  };
}

/**
 * A GraphQL read: POST /graphql that only reads, so it is safe to retry.
 *
 * @param operation - name, title, description, query, params, response (object)
 * @returns Declarative operation (object)
 */
function graphqlQuery({ query, ...operation }) {
  return { method: "POST", path: GRAPHQL_PATH, write: "idempotent", constants: { body: { query } }, ...operation };
}

/**
 * A GraphQL mutation, available to tools only with LINEAR_TOOL_ALLOW_WRITE=1 (node only when `nodeOnly`).
 *
 * @param operation - name, title, description, query, params, write, response, checkHint... (object)
 * @returns Declarative operation (object)
 */
function graphqlMutation({ query, ...operation }) {
  const toolPolicy = operation.nodeOnly ? {} : { toolPolicy: WRITE_OPT_IN };
  return { method: "POST", path: GRAPHQL_PATH, ...toolPolicy, constants: { body: { query } }, ...operation };
}

const variable = (name, spec) => ({ in: "body", wireName: `variables.${name}`, ...spec });
const idVariable = (name, description) => variable(name, { type: "string", required: true, description });
const includeArchived = variable("includeArchived", { type: "boolean", description: "Include archived items" });
const orderBy = variable("orderBy", { type: "string", enum: ["createdAt", "updatedAt"], description: "Sort order (newest first)" });
const issueIdParam = idVariable("id", "Issue id or identifier, e.g. ENG-123");

// --- viewer, teams, users -----------------------------------------------------------------------------

const workspaceOperations = [
  graphqlQuery({
    name: "get_viewer",
    title: "Current user",
    description: "The user the API key belongs to and their workspace; a cheap way to check the key",
    query: "query Viewer { viewer { id name displayName email active admin organization { id name urlKey } } }",
    response: { dataPath: "data.viewer" },
  }),
  graphqlQuery({
    name: "list_teams",
    title: "List teams",
    description: "Teams in the workspace (id and key for issues)",
    query: `query Teams($first: Int, $after: String, $includeArchived: Boolean) {
  teams(first: $first, after: $after, includeArchived: $includeArchived) { nodes { id key name description private } ${PAGE_INFO} } }`,
    params: { include_archived: includeArchived },
    response: connectionPages("teams"),
  }),
  graphqlQuery({
    name: "get_team",
    title: "Get team",
    description: "One team with its workflow states (state ids for issues) and members",
    query: `query Team($id: String!) { team(id: $id) { id key name description private
  states(first: 100) { nodes { id name type position } } members(first: 100) { nodes { id name displayName email } } } }`,
    params: { team_id: idVariable("id", "Team id") },
    response: { dataPath: "data.team" },
  }),
  graphqlQuery({
    name: "list_workflow_states",
    title: "List workflow states",
    description: "Workflow states (Backlog, Todo, In Progress, Done...) of all teams, or filtered",
    query: `query WorkflowStates($first: Int, $after: String, $filter: WorkflowStateFilter) {
  workflowStates(first: $first, after: $after, filter: $filter) { nodes { id name type position team { id key } } ${PAGE_INFO} } }`,
    params: { filter: variable("filter", { type: "object", description: 'WorkflowStateFilter, e.g. {"team": {"key": {"eq": "ENG"}}}' }) },
    response: connectionPages("workflowStates"),
  }),
  graphqlQuery({
    name: "list_users",
    title: "List users",
    description: "Users of the workspace (ids for assignees)",
    query: `query Users($first: Int, $after: String, $filter: UserFilter) {
  users(first: $first, after: $after, filter: $filter) { nodes { id name displayName email active } ${PAGE_INFO} } }`,
    params: { filter: variable("filter", { type: "object", description: 'UserFilter, e.g. {"email": {"eq": "ana@acme.com"}}' }) },
    response: connectionPages("users"),
  }),
];

// --- issues and comments ------------------------------------------------------------------------------

const issueInputParams = {
  issue_title: variable("input.title", { type: "string", minLength: 1 }),
  description: variable("input.description", { type: "string", description: "Markdown" }),
  assignee_id: variable("input.assigneeId", { type: "string", description: "User id" }),
  state_id: variable("input.stateId", { type: "string", description: "Workflow state id (see get_team)" }),
  priority: variable("input.priority", { type: "integer", min: 0, max: 4, description: "0 none, 1 urgent, 2 high, 3 medium, 4 low" }),
  project_id: variable("input.projectId", { type: "string" }),
  label_ids: variable("input.labelIds", { type: "array", items: { type: "string" }, maxItems: 50, description: "Label ids (replaces all labels)" }),
  due_date: variable("input.dueDate", { type: "string", description: "YYYY-MM-DD" }),
  estimate: variable("input.estimate", { type: "integer", min: 0 }),
  parent_id: variable("input.parentId", { type: "string", description: "Parent issue id (sub-issue)" }),
};

const issueOperations = [
  graphqlQuery({
    name: "list_issues",
    title: "List issues",
    description: 'Issues, optionally filtered with an IssueFilter, e.g. {"team": {"key": {"eq": "ENG"}}, "state": {"type": {"nin": ["completed", "canceled"]}}}',
    query: `query Issues($first: Int, $after: String, $filter: IssueFilter, $includeArchived: Boolean, $orderBy: PaginationOrderBy) {
  issues(first: $first, after: $after, filter: $filter, includeArchived: $includeArchived, orderBy: $orderBy) { nodes { ${ISSUE_SUMMARY_FIELDS} } ${PAGE_INFO} } }`,
    params: { filter: variable("filter", { type: "object", description: "IssueFilter object" }), include_archived: includeArchived, order_by: orderBy },
    response: connectionPages("issues"),
  }),
  graphqlQuery({
    name: "search_issues",
    title: "Search issues",
    description: "Full-text search of issues by title and description (optionally comments)",
    query: `query SearchIssues($term: String!, $first: Int, $after: String, $teamId: String, $includeComments: Boolean) {
  searchIssues(term: $term, first: $first, after: $after, teamId: $teamId, includeComments: $includeComments) { nodes { ${ISSUE_SUMMARY_FIELDS} } ${PAGE_INFO} } }`,
    params: {
      term: variable("term", { type: "string", required: true, minLength: 1 }),
      team_id: variable("teamId", { type: "string", description: "Only this team" }),
      include_comments: variable("includeComments", { type: "boolean" }),
    },
    response: connectionPages("searchIssues"),
  }),
  graphqlQuery({
    name: "get_issue",
    title: "Get issue",
    description: "One issue with description, parent, sub-issues and its latest 50 comments",
    query: `query Issue($id: String!) { issue(id: $id) { ${ISSUE_SUMMARY_FIELDS} description creator { id name }
  parent { id identifier title } children(first: 50) { nodes { id identifier title state { name } } }
  comments(first: 50) { nodes { id body createdAt user { id name } } } } }`,
    params: { issue_id: issueIdParam },
    response: { dataPath: "data.issue" },
  }),
  graphqlMutation({
    name: "create_issue",
    title: "Create issue",
    description: "Create an issue in a team",
    write: "unsafe",
    checkHint: "search_issues for the title",
    query: `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }`,
    params: { team_id: variable("input.teamId", { type: "string", required: true, description: "Team id (see list_teams)" }), ...issueInputParams, issue_title: { ...issueInputParams.issue_title, required: true } },
    response: { dataPath: "data.issueCreate" },
  }),
  graphqlMutation({
    name: "update_issue",
    title: "Update issue",
    description: "Change an issue's title, description, state, assignee, priority, project, labels, due date or estimate",
    write: "idempotent",
    query: `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title url state { name } } } }`,
    params: { issue_id: issueIdParam, ...issueInputParams },
    response: { dataPath: "data.issueUpdate" },
  }),
  graphqlMutation({
    name: "delete_issue",
    title: "Delete issue",
    description: "Move an issue to the trash (restorable for a while in Linear, then deleted)",
    write: "idempotent",
    nodeOnly: true,
    query: `mutation IssueDelete($id: String!) { issueDelete(id: $id) { success } }`,
    params: { issue_id: issueIdParam },
    response: { dataPath: "data.issueDelete" },
  }),
  graphqlQuery({
    name: "list_comments",
    title: "List issue comments",
    description: "Comments on an issue, oldest first",
    query: `query IssueComments($id: String!, $first: Int, $after: String) {
  issue(id: $id) { comments(first: $first, after: $after) { nodes { id body url createdAt updatedAt user { id name } } ${PAGE_INFO} } } }`,
    params: { issue_id: issueIdParam },
    response: connectionPages("issue.comments"),
  }),
  graphqlMutation({
    name: "create_comment",
    title: "Comment on issue",
    description: "Add a Markdown comment to an issue",
    write: "unsafe",
    checkHint: "list_comments for the issue",
    query: `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`,
    params: {
      issue_id: variable("input.issueId", { type: "string", required: true, description: "Issue id (UUID; use get_issue to resolve an identifier)" }),
      body: variable("input.body", { type: "string", required: true, minLength: 1, description: "Markdown" }),
    },
    response: { dataPath: "data.commentCreate" },
  }),
];

// --- projects -----------------------------------------------------------------------------------------

const projectOperations = [
  graphqlQuery({
    name: "list_projects",
    title: "List projects",
    description: "Projects with status, progress, dates, lead and teams",
    query: `query Projects($first: Int, $after: String, $filter: ProjectFilter, $includeArchived: Boolean, $orderBy: PaginationOrderBy) {
  projects(first: $first, after: $after, filter: $filter, includeArchived: $includeArchived, orderBy: $orderBy) {
    nodes { id name description url status { name type } progress startDate targetDate lead { id name } teams { nodes { id key name } } } ${PAGE_INFO} } }`,
    params: { filter: variable("filter", { type: "object", description: "ProjectFilter object" }), include_archived: includeArchived, order_by: orderBy },
    response: connectionPages("projects"),
  }),
  graphqlQuery({
    name: "get_project",
    title: "Get project",
    description: "One project with its first 100 issues",
    query: `query Project($id: String!) { project(id: $id) { id name description url status { name type } progress startDate targetDate
  lead { id name } teams { nodes { id key name } } issues(first: 100) { nodes { id identifier title state { name type } assignee { name } } } } }`,
    params: { project_id: idVariable("id", "Project id") },
    response: { dataPath: "data.project" },
  }),
];

const restDefinition = defineRestPlugin({
  name: "linear",
  version: "0.1.0",
  description: "Linear GraphQL API: issues (list, search, create, update), comments, projects, teams, workflow states and users",
  apiName: "Linear GraphQL API",
  baseUrl: "https://api.linear.app",
  // Personal API keys go in Authorization without a prefix (OAuth tokens need "Bearer ", see README).
  auth: { type: "header", header: "Authorization", env: "LINEAR_API_KEY" },
  // GraphQL errors: {"errors": [{"message": "...", "extensions": {"code": "AUTHENTICATION_ERROR"}}]}, also with HTTP 200.
  errors: {
    messagePath: "errors.0.message",
    codePath: "errors.0.extensions.code",
    kindByCode: { AUTHENTICATION_ERROR: "auth_error", FORBIDDEN: "permission_denied", RATELIMITED: "rate_limited", INVALID_INPUT: "invalid_input" },
    errorPath: "errors",
  },
  apiRequest: { examplePath: GRAPHQL_PATH },
  operations: [...workspaceOperations, ...issueOperations, ...projectOperations],
});

// An update without input fields would send an empty IssueUpdateInput.
export const pluginDefinition = requireSomeArguments(restDefinition, { operationName: "update_issue", argumentNames: Object.keys(issueInputParams) });
