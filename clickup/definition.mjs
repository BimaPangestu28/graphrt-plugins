/**
 * clickup plugin definition: the ClickUp API v2 (https://developer.clickup.com/reference) with a personal API token
 * (`Authorization: pk_...`, no Bearer prefix). Workspaces (called teams in v2), spaces, folders, lists, tasks
 * (list, filter across a workspace, get, create, update), comments and time tracking (read). Built with the
 * declarative REST layer (docs/declarative-plugins.md).
 *
 * Agent policy: deleting tasks is node only; api_request as a tool only reaches the reads in
 * lib/api-request-policy.mjs (webhook listings return signing secrets).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { restrictApiRequestForTools } from "./lib/api-request-policy.mjs";

const TEAM_ID = { in: "path", type: "string", required: true, description: "Workspace id (from list_teams; ClickUp v2 calls workspaces teams)" };
const SPACE_ID = { in: "path", type: "string", required: true, description: "Space id (from list_spaces)" };
const FOLDER_ID = { in: "path", type: "string", required: true, description: "Folder id (from list_folders)" };
const LIST_ID = { in: "path", type: "string", required: true, description: "List id (from list_lists or list_folderless_lists)" };
const TASK_ID = { in: "path", type: "string", required: true, description: "Task id, e.g. 86a1b2c3d (or a custom id with custom_task_ids and team_id)" };
const ARCHIVED = { in: "query", type: "boolean", description: "Return archived items instead of active ones" };
const customTaskIdParams = {
  custom_task_ids: { in: "query", type: "boolean", description: "task_id is a custom task id (needs team_id)" },
  team_id: { in: "query", type: "string", description: "Workspace id, required with custom_task_ids" },
};
const millisecondsParam = (description) => ({ in: "query", type: "integer", description: `${description} (Unix time in milliseconds)` });
const stringArray = (wireName, description) => ({ in: "query", type: "array", items: { type: "string" }, wireName, style: "brackets", description });
const taskFilterParams = {
  order_by: { in: "query", type: "string", enum: ["id", "created", "updated", "due_date"], description: "Sort field (default created)" },
  reverse: { in: "query", type: "boolean", description: "Reverse the order" },
  subtasks: { in: "query", type: "boolean", description: "Include subtasks" },
  include_closed: { in: "query", type: "boolean", description: "Include closed tasks" },
  statuses: stringArray("statuses", "Status names, e.g. [\"to do\", \"in progress\"]"),
  assignees: stringArray("assignees", "Assignee user ids"),
  tags: stringArray("tags", "Tag names"),
  due_date_gt: millisecondsParam("Due after"),
  due_date_lt: millisecondsParam("Due before"),
  date_updated_gt: millisecondsParam("Updated after"),
  include_markdown_description: { in: "query", type: "boolean", description: "Return markdown_description" },
};
// ClickUp pages hold up to 100 tasks and start at 0; a page after the last one is empty.
const taskPage = { dataPath: "tasks", pagePagination: { pageParam: "page", firstPage: 0 } };
const taskFields = {
  description: { in: "body", type: "string", description: "Plain-text description" },
  markdown_content: { in: "body", type: "string", description: "Markdown description (wins over description)" },
  status: { in: "body", type: "string", description: "Status name of the list, e.g. in progress" },
  priority: { in: "body", type: "integer", min: 1, max: 4, description: "1 urgent, 2 high, 3 normal, 4 low" },
  due_date: { in: "body", type: "integer", description: "Due date, Unix time in milliseconds" },
  due_date_time: { in: "body", type: "boolean", description: "The due date has a time of day" },
  start_date: { in: "body", type: "integer", description: "Start date, Unix time in milliseconds" },
  start_date_time: { in: "body", type: "boolean", description: "The start date has a time of day" },
  time_estimate: { in: "body", type: "integer", description: "Estimate in milliseconds" },
  points: { in: "body", type: "number", description: "Sprint points" },
};

const hierarchyOperations = [
  { name: "get_user", title: "Authorized user", description: "The user the token belongs to", path: "/user", response: { dataPath: "user" } },
  { name: "list_teams", title: "List workspaces", description: "Workspaces (teams) the token can access, with members", path: "/team", response: { dataPath: "teams" } },
  { name: "list_spaces", title: "List spaces", description: "Spaces of a workspace", path: "/team/{team_id}/space", params: { team_id: TEAM_ID, archived: ARCHIVED }, response: { dataPath: "spaces" } },
  { name: "get_space", title: "Get space", description: "One space with its statuses and features", path: "/space/{space_id}", params: { space_id: SPACE_ID } },
  { name: "list_folders", title: "List folders", description: "Folders of a space, with their lists", path: "/space/{space_id}/folder", params: { space_id: SPACE_ID, archived: ARCHIVED }, response: { dataPath: "folders" } },
  { name: "list_lists", title: "List lists", description: "Lists in a folder", path: "/folder/{folder_id}/list", params: { folder_id: FOLDER_ID, archived: ARCHIVED }, response: { dataPath: "lists" } },
  { name: "list_folderless_lists", title: "Folderless lists", description: "Lists directly in a space (not in a folder)", path: "/space/{space_id}/list", params: { space_id: SPACE_ID, archived: ARCHIVED }, response: { dataPath: "lists" } },
  { name: "get_list", title: "Get list", description: "One list with its statuses", path: "/list/{list_id}", params: { list_id: LIST_ID } },
];

const taskReads = [
  {
    name: "list_tasks",
    title: "List tasks",
    description: "Tasks of a list (100 per page; closed tasks and subtasks only when asked)",
    path: "/list/{list_id}/task",
    params: { list_id: LIST_ID, archived: { in: "query", type: "boolean", description: "Archived tasks only" }, ...taskFilterParams },
    response: taskPage,
  },
  {
    name: "search_tasks",
    title: "Filter workspace tasks",
    description: "Tasks across a workspace filtered by space, folder, list, status, assignee, tag or dates (100 per page)",
    path: "/team/{team_id}/task",
    params: {
      team_id: TEAM_ID,
      space_ids: stringArray("space_ids", "Space ids"),
      folder_ids: stringArray("project_ids", "Folder ids"),
      list_ids: stringArray("list_ids", "List ids"),
      parent_task_id: { in: "query", type: "string", wireName: "parent", description: "Parent task id, to list its subtasks" },
      ...taskFilterParams,
    },
    response: taskPage,
  },
  {
    name: "get_task",
    title: "Get task",
    description: "One task with assignees, status, dates, custom fields and checklists",
    path: "/task/{task_id}",
    params: { task_id: TASK_ID, ...customTaskIdParams, include_subtasks: { in: "query", type: "boolean" }, include_markdown_description: { in: "query", type: "boolean" } },
  },
  { name: "get_time_in_status", title: "Time in status", description: "How long a task has spent in each status", path: "/task/{task_id}/time_in_status", params: { task_id: TASK_ID, ...customTaskIdParams } },
];

const taskWrites = [
  {
    name: "create_task",
    title: "Create task",
    description: "Create a task (or a subtask with parent_task_id) in a list; assignees and watchers are notified by ClickUp",
    method: "POST",
    path: "/list/{list_id}/task",
    write: "unsafe",
    checkHint: "list_tasks for the list (sorted by created) and look for the name",
    params: {
      list_id: LIST_ID,
      name: { in: "body", type: "string", required: true, minLength: 1, description: "Task name" },
      ...taskFields,
      assignees: { in: "body", type: "array", items: { type: "integer" }, description: "Assignee user ids" },
      tags: { in: "body", type: "array", items: { type: "string" }, description: "Tag names" },
      parent_task_id: { in: "body", type: "string", wireName: "parent", description: "Parent task id (same list) to create a subtask" },
      links_to: { in: "body", type: "string", description: "Task id to link as a dependency" },
      notify_all: { in: "body", type: "boolean", default: false, description: "Also notify the creator (assignees and watchers are always notified)" },
      custom_fields: { in: "body", type: "array", items: { type: "object" }, description: 'Custom field values, e.g. [{"id":"<field id>","value":42}]' },
    },
  },
  {
    name: "update_task",
    title: "Update task",
    description: "Change a task's name, description, status, priority, dates, estimate, assignees or archived flag",
    method: "PUT",
    path: "/task/{task_id}",
    write: "idempotent",
    params: {
      task_id: TASK_ID,
      ...customTaskIdParams,
      name: { in: "body", type: "string", minLength: 1 },
      ...taskFields,
      archived: { in: "body", type: "boolean" },
      add_assignees: { in: "body", type: "array", items: { type: "integer" }, wireName: "assignees.add", description: "User ids to assign" },
      remove_assignees: { in: "body", type: "array", items: { type: "integer" }, wireName: "assignees.rem", description: "User ids to unassign" },
    },
  },
  { name: "delete_task", title: "Delete task", description: "Delete a task", method: "DELETE", path: "/task/{task_id}", write: "idempotent", nodeOnly: true, params: { task_id: TASK_ID, ...customTaskIdParams } },
];

const commentOperations = [
  {
    name: "list_comments",
    title: "Task comments",
    description: "The 25 newest comments of a task; for older ones pass start and start_id of the last comment",
    path: "/task/{task_id}/comment",
    params: {
      task_id: TASK_ID,
      ...customTaskIdParams,
      start: { in: "query", type: "integer", description: "date of the last comment of the previous page (with start_id)" },
      start_id: { in: "query", type: "string", description: "id of the last comment of the previous page (with start)" },
    },
    response: { dataPath: "comments" },
  },
  {
    name: "add_comment",
    title: "Comment on task",
    description: "Add a comment to a task (assignees and watchers are notified by ClickUp)",
    method: "POST",
    path: "/task/{task_id}/comment",
    write: "unsafe",
    checkHint: "list_comments for the task",
    params: {
      task_id: TASK_ID,
      ...customTaskIdParams,
      comment_text: { in: "body", type: "string", required: true, minLength: 1, description: "Comment text" },
      assignee: { in: "body", type: "integer", description: "User id to assign the comment to" },
      notify_all: { in: "body", type: "boolean", default: false, description: "Also notify the creator" },
    },
  },
];

const timeOperations = [
  {
    name: "list_time_entries",
    title: "Time entries",
    description: "Time entries of a workspace in a date range (default: your entries of the last 30 days; a negative duration is a running timer)",
    path: "/team/{team_id}/time_entries",
    params: {
      team_id: TEAM_ID,
      start_date: millisecondsParam("From"),
      end_date: millisecondsParam("Until"),
      assignee: { in: "query", type: "string", description: "Comma-separated user ids (workspace owners and admins only)" },
      space_id: { in: "query", type: "string", description: "Only this space (one of space_id, folder_id, list_id, task_id)" },
      folder_id: { in: "query", type: "string" },
      list_id: { in: "query", type: "string" },
      task_id: { in: "query", type: "string" },
      is_billable: { in: "query", type: "boolean" },
      include_task_tags: { in: "query", type: "boolean" },
      include_location_names: { in: "query", type: "boolean" },
    },
    response: { dataPath: "data" },
  },
];

export const restDefinition = defineRestPlugin({
  name: "clickup",
  version: "0.1.0",
  description: "ClickUp: workspaces, spaces, folders, lists, tasks (list, filter, get, create, update), comments and time entries (read); task deletes are node only",
  apiName: "ClickUp API v2",
  baseUrl: "https://api.clickup.com/api/v2",
  // Personal tokens (pk_...) go in Authorization without a prefix; an OAuth token needs "Bearer " in the value.
  toolUserToken: true,
  auth: { type: "header", header: "Authorization", env: "CLICKUP_API_TOKEN" },
  // Errors are {"err": "Token invalid", "ECODE": "OAUTH_025"} (https://developer.clickup.com/docs/common_errors).
  errors: {
    messagePath: ["err", "error"],
    codePath: "ECODE",
    // auth_error codes last: the generated mapping test uses the first code.
    kindByCode: {
      OAUTH_023: "permission_denied",
      OAUTH_026: "permission_denied",
      OAUTH_027: "permission_denied",
      OAUTH_029: "permission_denied",
      OAUTH_017: "auth_error",
      OAUTH_019: "auth_error",
      OAUTH_021: "auth_error",
      OAUTH_025: "auth_error",
      OAUTH_077: "auth_error",
    },
  },
  apiRequest: { examplePath: "/list/{list_id}/member" },
  operations: [...hierarchyOperations, ...taskReads, ...taskWrites, ...commentOperations, ...timeOperations],
});

export const pluginDefinition = {
  ...restDefinition,
  operations: restDefinition.operations.map((operation) => (operation.name === "api_request" ? restrictApiRequestForTools(operation) : operation)),
};
