/**
 * todoist plugin definition: the unified Todoist API v1 (https://developer.todoist.com/api/v1/), which replaced the
 * REST API v2 and Sync API v9. Projects, sections, tasks (list, filter, completed, get, create, quick add, update,
 * move, close, reopen), labels and comments, with a bearer token. Lists are cursor-paginated (`results`,
 * `next_cursor`). Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Agent policy: deleting tasks is node only; get_user drops the token fields; api_request as a tool only reads the
 * paths in lib/todoist-policy.mjs.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { restrictApiRequestForTools, withoutUserSecrets } from "./lib/todoist-policy.mjs";

const PROJECT_ID = { in: "path", type: "string", required: true, description: "Project id (from list_projects)" };
const TASK_ID = { in: "path", type: "string", required: true, description: "Task id (from list_tasks)" };
const resultsPage = (dataPath = "results") => ({ dataPath, cursorPath: "next_cursor", cursorParam: "cursor", limitParam: "limit", maxLimit: 200, defaultLimit: 50 });
const VIEW_STYLE = { in: "body", type: "string", enum: ["list", "board", "calendar"], wireName: "view_style", description: "Project layout" };
const projectFields = {
  description: { in: "body", type: "string" },
  color: { in: "body", type: "string", description: "Color name, e.g. berry_red, blue, grey" },
  is_favorite: { in: "body", type: "boolean" },
  project_view_style: VIEW_STYLE,
};
// Shared by create_task and update_task. Priority 4 is the most urgent (shown as p1 in the apps).
const taskFields = {
  description: { in: "body", type: "string" },
  labels: { in: "body", type: "array", items: { type: "string" }, description: "Label names" },
  priority: { in: "body", type: "integer", min: 1, max: 4, description: "1 normal to 4 urgent (4 is p1 in the apps)" },
  due_string: { in: "body", type: "string", description: 'Natural-language due date, e.g. "tomorrow at 9", "every monday"' },
  due_date: { in: "body", type: "string", description: "Due date YYYY-MM-DD" },
  due_datetime: { in: "body", type: "string", description: "Due date and time, RFC 3339 in UTC" },
  due_lang: { in: "body", type: "string", description: "Language of due_string, e.g. en" },
  assignee_id: { in: "body", type: "integer", description: "User id of a collaborator of a shared project" },
  duration: { in: "body", type: "integer", min: 1, description: "Duration amount (with duration_unit)" },
  duration_unit: { in: "body", type: "string", enum: ["minute", "day"] },
  deadline_date: { in: "body", type: "string", description: "Deadline YYYY-MM-DD" },
};

const projectOperations = [
  { name: "get_user", title: "Current user", description: "The account's name, email, time zone, inbox project and goals (token fields removed)", path: "/user" },
  { name: "list_projects", title: "List projects", description: "Active projects", path: "/projects", params: { folder_id: { in: "query", type: "integer", description: "Only projects in this workspace folder" } }, response: resultsPage() },
  { name: "get_project", title: "Get project", description: "One project", path: "/projects/{project_id}", params: { project_id: PROJECT_ID } },
  {
    name: "create_project",
    title: "Create project",
    description: "Create a personal project (or a sub-project with parent_id)",
    method: "POST",
    path: "/projects",
    write: "unsafe",
    checkHint: "list_projects and look for the name",
    params: { name: { in: "body", type: "string", required: true, minLength: 1 }, parent_id: { in: "body", type: "string", description: "Parent project id" }, ...projectFields },
  },
  {
    name: "update_project",
    title: "Update project",
    description: "Rename a project or change its description, color, favorite flag or layout",
    method: "POST",
    path: "/projects/{project_id}",
    write: "idempotent",
    params: { project_id: PROJECT_ID, name: { in: "body", type: "string", minLength: 1 }, ...projectFields },
  },
  { name: "list_sections", title: "List sections", description: "Sections of a project (or of all projects)", path: "/sections", params: { project_id: { in: "query", type: "string" } }, response: resultsPage() },
  {
    name: "create_section",
    title: "Create section",
    description: "Add a section to a project",
    method: "POST",
    path: "/sections",
    write: "unsafe",
    checkHint: "list_sections for the project",
    params: { name: { in: "body", type: "string", required: true, minLength: 1 }, project_id: { in: "body", type: "string", required: true }, order: { in: "body", type: "integer" } },
  },
];

const taskReads = [
  {
    name: "list_tasks",
    title: "List tasks",
    description: "Active tasks, optionally of one project, section, parent task or label",
    path: "/tasks",
    params: {
      project_id: { in: "query", type: "string" },
      section_id: { in: "query", type: "string" },
      parent_id: { in: "query", type: "string" },
      label: { in: "query", type: "string", description: "Label name" },
      ids: { in: "query", type: "array", items: { type: "string" }, description: "Only these task ids" },
    },
    response: resultsPage(),
  },
  {
    name: "filter_tasks",
    title: "Filter tasks",
    description: 'Active tasks matching a Todoist filter query, e.g. "today | overdue", "#Work & p1", "assigned to: me"',
    path: "/tasks/filter",
    params: { query: { in: "query", type: "string", required: true, minLength: 1, description: "Todoist filter query" }, lang: { in: "query", type: "string", description: "Language of the query, e.g. en" } },
    response: resultsPage(),
  },
  {
    name: "list_completed_tasks",
    title: "Completed tasks",
    description: "Tasks completed in a time range (up to 3 months), optionally in one project or section",
    path: "/tasks/completed/by_completion_date",
    params: {
      since: { in: "query", type: "string", required: true, description: "From, e.g. 2026-11-01T00:00:00Z" },
      until: { in: "query", type: "string", required: true, description: "Until, e.g. 2026-11-19T23:59:59Z" },
      project_id: { in: "query", type: "string" },
      section_id: { in: "query", type: "string" },
      filter_query: { in: "query", type: "string", description: "Todoist filter query" },
    },
    response: resultsPage("items"),
  },
  { name: "get_task", title: "Get task", description: "One task", path: "/tasks/{task_id}", params: { task_id: TASK_ID } },
];

const taskWrites = [
  {
    name: "create_task",
    title: "Create task",
    description: "Create a task (in the Inbox unless a project is given)",
    method: "POST",
    path: "/tasks",
    write: "unsafe",
    checkHint: "filter_tasks with a query that matches the content, e.g. search: <words>",
    params: {
      content: { in: "body", type: "string", required: true, minLength: 1, description: "Task name (markdown allowed)" },
      project_id: { in: "body", type: "string" },
      section_id: { in: "body", type: "string" },
      parent_id: { in: "body", type: "string", description: "Parent task id, to create a sub-task" },
      order: { in: "body", type: "integer" },
      ...taskFields,
    },
  },
  {
    name: "quick_add_task",
    title: "Quick add",
    description: 'Create a task from one line in the apps\' Quick Add syntax, e.g. "Pay rent tomorrow #Home @bills p1"',
    method: "POST",
    path: "/tasks/quick",
    write: "unsafe",
    checkHint: "filter_tasks with search: <words>",
    params: {
      text: { in: "body", type: "string", required: true, minLength: 1, description: "Quick Add text with dates, #project, @label, p1–p4" },
      note: { in: "body", type: "string", description: "Comment added to the task" },
      reminder: { in: "body", type: "string", description: 'Reminder date in natural language, e.g. "tomorrow 9am"' },
      auto_reminder: { in: "body", type: "boolean", description: "Add the default reminder when the task has a due time" },
    },
  },
  {
    // Setting the same fields again gives the same task, so a retry is harmless.
    name: "update_task",
    title: "Update task",
    description: "Change a task's content, description, labels, priority, due date, deadline, duration or assignee",
    method: "POST",
    path: "/tasks/{task_id}",
    write: "idempotent",
    params: { task_id: TASK_ID, content: { in: "body", type: "string", minLength: 1 }, ...taskFields },
  },
  {
    name: "move_task",
    title: "Move task",
    description: "Move a task to another project, section or parent task (give exactly one)",
    method: "POST",
    path: "/tasks/{task_id}/move",
    write: "idempotent",
    params: { task_id: TASK_ID, project_id: { in: "body", type: "string" }, section_id: { in: "body", type: "string" }, parent_id: { in: "body", type: "string" } },
  },
  {
    // Closing a recurring task moves it to its next date, so a repeated close skips an occurrence: unsafe.
    name: "close_task",
    title: "Complete task",
    description: "Complete a task (a recurring task moves to its next date)",
    method: "POST",
    path: "/tasks/{task_id}/close",
    write: "unsafe",
    checkHint: "get_task and look at checked and due",
    params: { task_id: TASK_ID },
  },
  { name: "reopen_task", title: "Reopen task", description: "Mark a completed task as not completed", method: "POST", path: "/tasks/{task_id}/reopen", write: "idempotent", params: { task_id: TASK_ID } },
  { name: "delete_task", title: "Delete task", description: "Delete a task and its sub-tasks", method: "DELETE", path: "/tasks/{task_id}", write: "idempotent", nodeOnly: true, params: { task_id: TASK_ID } },
];

const labelAndCommentOperations = [
  { name: "list_labels", title: "List labels", description: "Personal labels", path: "/labels", response: resultsPage() },
  {
    name: "list_comments",
    title: "List comments",
    description: "Comments of a task or of a project (give exactly one of task_id, project_id)",
    path: "/comments",
    params: { task_id: { in: "query", type: "string" }, project_id: { in: "query", type: "string" } },
    response: resultsPage(),
  },
  {
    name: "add_comment",
    title: "Add comment",
    description: "Comment on a task or a project (give exactly one of task_id, project_id); uids_to_notify notifies project collaborators",
    method: "POST",
    path: "/comments",
    write: "unsafe",
    checkHint: "list_comments for the task or project",
    params: {
      content: { in: "body", type: "string", required: true, minLength: 1, description: "Comment text (markdown allowed)" },
      task_id: { in: "body", type: "string" },
      project_id: { in: "body", type: "string" },
      uids_to_notify: { in: "body", type: "array", items: { type: "string" }, description: "Collaborator user ids to notify" },
    },
  },
];

export const restDefinition = defineRestPlugin({
  name: "todoist",
  version: "0.1.0",
  description: "Todoist (API v1): projects, sections, tasks (filter, completed, create, quick add, update, move, complete, reopen), labels and comments; deletes are node only",
  apiName: "Todoist API v1",
  baseUrl: "https://api.todoist.com/api/v1",
  toolUserToken: true,
  auth: { type: "bearer", env: "TODOIST_API_TOKEN" },
  // Errors: {"error_tag": "UNAUTHORIZED", "error_code": 477, "error": "Unauthorized", "http_code": 401,
  // "error_extra": {"retry_after": 3}}.
  errors: {
    messagePath: ["error", "error_tag"],
    codePath: "error_tag",
    // auth_error last: the generated mapping test uses the first code.
    kindByCode: { FORBIDDEN: "permission_denied", NOT_FOUND: "not_found", INVALID_ARGUMENT_VALUE: "invalid_input", UNAUTHORIZED: "auth_error" },
    retryAfterPath: "error_extra.retry_after",
  },
  apiRequest: { examplePath: "/projects/{project_id}/collaborators" },
  operations: [...projectOperations, ...taskReads, ...taskWrites, ...labelAndCommentOperations],
});

const wrappers = { get_user: withoutUserSecrets, api_request: restrictApiRequestForTools };
export const pluginDefinition = { ...restDefinition, operations: restDefinition.operations.map((operation) => wrappers[operation.name]?.(operation) ?? operation) };
