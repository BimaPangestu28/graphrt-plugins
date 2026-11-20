/**
 * asana plugin definition: the Asana REST API 1.0 (https://developers.asana.com/reference/rest-api-reference) with
 * a personal access token. Workspaces, users, projects, sections, tasks (list, get, search, create, update,
 * complete, subtasks), stories and comments. Built with the declarative REST layer (docs/declarative-plugins.md).
 * Responses are wrapped in `data` and request bodies in `{"data": {...}}`; lists use Asana's offset tokens
 * (`next_page.offset`).
 *
 * Agent policy: tools may only assign tasks to "me" or a user gid, never an email address (lib/assignee-policy.mjs);
 * deleting a task is node only; api_request for tools only reaches an allowlist of read paths
 * (lib/api-request-policy.mjs), never webhooks, attachments, exports or audit logs.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardToolAssignee } from "./lib/assignee-policy.mjs";
import { restrictApiRequestForTools } from "./lib/api-request-policy.mjs";

const gidParam = (description) => ({ in: "path", type: "string", required: true, description });
const TASK_GID = gidParam("Task gid");
const PROJECT_GID = gidParam("Project gid");
const optFields = (example) => ({ in: "query", type: "array", items: { type: "string" }, wireName: "opt_fields", description: `Extra fields to return, e.g. ${example}` });
const TASK_FIELDS_EXAMPLE = "name,completed,assignee.name,due_on,notes,permalink_url";
const asanaPage = { dataPath: "data", cursorPath: "next_page.offset", cursorParam: "offset", limitParam: "limit", maxLimit: 100, defaultLimit: 50 };
const single = { dataPath: "data" };
const taskFields = {
  name: { in: "body", type: "string", wireName: "data.name", description: "Task name" },
  notes: { in: "body", type: "string", wireName: "data.notes", description: "Description in plain text" },
  html_notes: { in: "body", type: "string", wireName: "data.html_notes", description: "Description as Asana rich text, e.g. <body>Hi <strong>team</strong></body>" },
  assignee: { in: "body", type: "string", wireName: "data.assignee", description: 'User gid or "me" (agent tools cannot assign by email)' },
  due_on: { in: "body", type: "string", wireName: "data.due_on", description: "Due date, YYYY-MM-DD" },
  due_at: { in: "body", type: "string", wireName: "data.due_at", description: "Due date and time, ISO 8601 (instead of due_on)" },
  start_on: { in: "body", type: "string", wireName: "data.start_on", description: "Start date, YYYY-MM-DD (needs a due date)" },
};

const readOperations = [
  { name: "get_me", title: "Current user", description: "The user who owns the token, with their workspaces", path: "/users/me", params: { opt_fields: optFields("name,email,workspaces.name") }, response: single },
  { name: "list_workspaces", title: "List workspaces", description: "Workspaces and organizations the user belongs to", path: "/workspaces", response: asanaPage },
  {
    name: "list_users",
    title: "List users",
    description: "Users of a workspace (gids for assignees)",
    path: "/users",
    params: { workspace_gid: { in: "query", type: "string", required: true, wireName: "workspace", description: "Workspace gid" }, opt_fields: optFields("name,email") },
    response: asanaPage,
  },
  {
    name: "list_projects",
    title: "List projects",
    description: "Projects of a workspace or team",
    path: "/projects",
    params: {
      workspace_gid: { in: "query", type: "string", wireName: "workspace", description: "Workspace gid (this or team_gid)" },
      team_gid: { in: "query", type: "string", wireName: "team", description: "Team gid" },
      archived: { in: "query", type: "boolean", description: "Only archived (true) or unarchived (false) projects" },
      opt_fields: optFields("name,owner.name,due_on,permalink_url"),
    },
    response: asanaPage,
  },
  { name: "get_project", title: "Get project", description: "One project", path: "/projects/{project_gid}", params: { project_gid: PROJECT_GID, opt_fields: optFields("name,notes,members.name,custom_fields") }, response: single },
  { name: "list_sections", title: "List sections", description: "Sections (columns) of a project", path: "/projects/{project_gid}/sections", params: { project_gid: PROJECT_GID }, response: asanaPage },
  {
    name: "list_tasks",
    title: "List tasks",
    description: "Tasks of a project, a section, or an assignee in a workspace (give exactly one of project_gid, section_gid, or assignee with workspace_gid)",
    path: "/tasks",
    params: {
      project_gid: { in: "query", type: "string", wireName: "project", description: "Project gid" },
      section_gid: { in: "query", type: "string", wireName: "section", description: "Section gid" },
      assignee: { in: "query", type: "string", description: 'User gid, email or "me" (with workspace_gid)' },
      workspace_gid: { in: "query", type: "string", wireName: "workspace", description: "Workspace gid (with assignee)" },
      completed_since: { in: "query", type: "string", description: 'Only tasks incomplete or completed since this time (ISO 8601), or "now" for incomplete only' },
      modified_since: { in: "query", type: "string", description: "Only tasks modified since this time (ISO 8601)" },
      opt_fields: optFields(TASK_FIELDS_EXAMPLE),
    },
    response: asanaPage,
  },
  { name: "get_task", title: "Get task", description: "One task with its details", path: "/tasks/{task_gid}", params: { task_gid: TASK_GID, opt_fields: optFields(TASK_FIELDS_EXAMPLE) }, response: single },
  {
    name: "search_tasks",
    title: "Search tasks",
    description: "Full-text task search in a workspace (premium workspaces only; 402 otherwise). No paging: sort by created_at and filter to page manually",
    path: "/workspaces/{workspace_gid}/tasks/search",
    params: {
      workspace_gid: gidParam("Workspace gid"),
      text: { in: "query", type: "string", description: "Words in the task name or description" },
      completed: { in: "query", type: "boolean" },
      assignee_any: { in: "query", type: "array", items: { type: "string" }, wireName: "assignee.any", description: 'User gids, emails or "me"' },
      projects_any: { in: "query", type: "array", items: { type: "string" }, wireName: "projects.any", description: "Project gids" },
      is_subtask: { in: "query", type: "boolean" },
      modified_after: { in: "query", type: "string", wireName: "modified_at.after", description: "ISO 8601 time" },
      due_on_before: { in: "query", type: "string", wireName: "due_on.before", description: "YYYY-MM-DD" },
      sort_by: { in: "query", type: "string", enum: ["due_date", "created_at", "completed_at", "likes", "relevance", "modified_at"] },
      sort_ascending: { in: "query", type: "boolean" },
      max_results: { in: "query", type: "integer", min: 1, max: 100, wireName: "limit", description: "Maximum tasks (1-100)" },
      opt_fields: optFields(TASK_FIELDS_EXAMPLE),
    },
    response: single,
  },
  { name: "list_subtasks", title: "List subtasks", description: "Subtasks of a task", path: "/tasks/{task_gid}/subtasks", params: { task_gid: TASK_GID, opt_fields: optFields("name,completed,assignee.name") }, response: asanaPage },
  {
    name: "list_stories",
    title: "Comments and history",
    description: "Stories of a task: comments (resource_subtype comment_added) and system events",
    path: "/tasks/{task_gid}/stories",
    params: { task_gid: TASK_GID, opt_fields: optFields("text,created_by.name,created_at,resource_subtype") },
    response: asanaPage,
  },
];

const writeOperations = [
  {
    name: "create_task",
    title: "Create task",
    description: "Create a task in a workspace and/or projects",
    method: "POST",
    path: "/tasks",
    write: "unsafe",
    checkHint: "list_tasks for the project (or search_tasks) and look for the name",
    params: {
      ...taskFields,
      name: { ...taskFields.name, required: true, minLength: 1 },
      workspace_gid: { in: "body", type: "string", wireName: "data.workspace", description: "Workspace gid (not needed when project_gids is given)" },
      project_gids: { in: "body", type: "array", items: { type: "string" }, wireName: "data.projects", description: "Projects to add the task to" },
      opt_fields: optFields("name,permalink_url"),
    },
    response: single,
  },
  {
    name: "update_task",
    title: "Update task",
    description: "Change a task's name, description, assignee, dates or completion",
    method: "PUT",
    path: "/tasks/{task_gid}",
    write: "idempotent",
    params: { task_gid: TASK_GID, ...taskFields, completed: { in: "body", type: "boolean", wireName: "data.completed" } },
    response: single,
  },
  {
    name: "complete_task",
    title: "Complete task",
    description: "Mark a task complete (or incomplete again with completed: false)",
    method: "PUT",
    path: "/tasks/{task_gid}",
    write: "idempotent",
    params: { task_gid: TASK_GID, completed: { in: "body", type: "boolean", default: true, wireName: "data.completed" } },
    response: single,
  },
  {
    name: "create_subtask",
    title: "Create subtask",
    description: "Create a subtask under a task",
    method: "POST",
    path: "/tasks/{task_gid}/subtasks",
    write: "unsafe",
    checkHint: "list_subtasks for the parent task",
    params: { task_gid: { ...TASK_GID, description: "Parent task gid" }, ...taskFields, name: { ...taskFields.name, required: true, minLength: 1 } },
    response: single,
  },
  {
    name: "create_section",
    title: "Create section",
    description: "Add a section to a project",
    method: "POST",
    path: "/projects/{project_gid}/sections",
    write: "unsafe",
    checkHint: "list_sections for the project",
    params: { project_gid: PROJECT_GID, name: { in: "body", type: "string", required: true, minLength: 1, wireName: "data.name" } },
    response: single,
  },
  {
    name: "add_task_to_section",
    title: "Move task to section",
    description: "Move a task into a section of a project it belongs to (moving again to the same place is harmless)",
    method: "POST",
    path: "/sections/{section_gid}/addTask",
    write: "idempotent",
    params: {
      section_gid: gidParam("Section gid"),
      task_gid: { in: "body", type: "string", required: true, wireName: "data.task", description: "Task gid" },
      insert_before: { in: "body", type: "string", wireName: "data.insert_before", description: "Task gid to place it before" },
      insert_after: { in: "body", type: "string", wireName: "data.insert_after", description: "Task gid to place it after" },
    },
    response: single,
  },
  {
    name: "add_comment",
    title: "Add comment",
    description: "Comment on a task (followers are notified)",
    method: "POST",
    path: "/tasks/{task_gid}/stories",
    write: "unsafe",
    checkHint: "list_stories for the task and look for the comment",
    params: {
      task_gid: TASK_GID,
      text: { in: "body", type: "string", wireName: "data.text", description: "Comment in plain text (this or html_text)" },
      html_text: { in: "body", type: "string", wireName: "data.html_text", description: "Comment as Asana rich text, e.g. <body>Done</body>" },
      is_pinned: { in: "body", type: "boolean", wireName: "data.is_pinned" },
    },
    response: single,
  },
  { name: "delete_task", title: "Delete task", description: "Delete a task (it goes to the trash for 30 days)", method: "DELETE", path: "/tasks/{task_gid}", write: "idempotent", nodeOnly: true, params: { task_gid: TASK_GID }, response: single },
];

export const restDefinition = defineRestPlugin({
  name: "asana",
  version: "0.1.0",
  description: "Asana: workspaces, projects, sections, tasks (list, search, create, update, complete, subtasks) and comments with a personal access token; deletes node only",
  apiName: "Asana API",
  baseUrl: "https://app.asana.com/api/1.0",
  toolUserToken: true,
  auth: { type: "bearer", env: "ASANA_ACCESS_TOKEN" },
  // Errors are {"errors": [{"message", "help", "phrase"?}]}; 402 means a premium-only feature (e.g. search).
  errors: { messagePath: "errors.0.message", kindByStatus: { 402: "permission_denied" } },
  apiRequest: { examplePath: "/tags?workspace=<workspace gid>" },
  operations: [...readOperations, ...writeOperations],
});

const ASSIGNEE_OPERATIONS = new Set(["create_task", "update_task", "create_subtask"]);
const wrapOperation = (operation) => {
  if (operation.name === "api_request") return restrictApiRequestForTools(operation);
  return ASSIGNEE_OPERATIONS.has(operation.name) ? guardToolAssignee(operation) : operation;
};

export const pluginDefinition = { ...restDefinition, operations: restDefinition.operations.map(wrapOperation) };
