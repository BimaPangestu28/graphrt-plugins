import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition } from "../definition.mjs";

const API = "https://api.clickup.com/api/v2";

describeRestPluginContract(restDefinition, {
  operations: {
    get_user: {
      args: {},
      request: { method: "GET", url: `${API}/user`, query: "absent" },
      response: { body: { user: { id: 123, username: "ada" } } },
      expect: { data: { id: 123, username: "ada" } },
    },
    list_teams: {
      args: {},
      request: { method: "GET", url: `${API}/team`, query: "absent" },
      response: { body: { teams: [{ id: "9001", name: "Acme" }] } },
      expect: { data: [{ id: "9001", name: "Acme" }] },
    },
    list_spaces: { args: { team_id: "9001", archived: false }, request: { method: "GET", url: `${API}/team/9001/space`, query: { archived: "false" } }, response: { body: { spaces: [{ id: "s1" }] } }, expect: { data: [{ id: "s1" }] } },
    get_space: { args: { space_id: "s1" }, request: { method: "GET", url: `${API}/space/s1`, query: "absent" } },
    list_folders: { args: { space_id: "s1" }, request: { method: "GET", url: `${API}/space/s1/folder`, query: "absent" }, response: { body: { folders: [{ id: "f1" }] } }, expect: { data: [{ id: "f1" }] } },
    list_lists: { args: { folder_id: "f1", archived: true }, request: { method: "GET", url: `${API}/folder/f1/list`, query: { archived: "true" } }, response: { body: { lists: [{ id: "l1" }] } }, expect: { data: [{ id: "l1" }] } },
    list_folderless_lists: { args: { space_id: "s1" }, request: { method: "GET", url: `${API}/space/s1/list`, query: "absent" }, response: { body: { lists: [{ id: "l2" }] } }, expect: { data: [{ id: "l2" }] } },
    get_list: { args: { list_id: "l1" }, request: { method: "GET", url: `${API}/list/l1`, query: "absent" } },
    list_tasks: {
      args: { list_id: "l1", statuses: ["to do", "in progress"], assignees: ["42"], include_closed: true, order_by: "updated", due_date_lt: 1767225600000 },
      request: {
        method: "GET",
        url: `${API}/list/l1/task`,
        query: { order_by: "updated", include_closed: "true", "statuses[]": ["to do", "in progress"], "assignees[]": "42", due_date_lt: "1767225600000" },
      },
      response: { body: { tasks: [{ id: "t1", name: "Ship" }], last_page: true } },
      expect: { data: [{ id: "t1", name: "Ship" }] },
    },
    search_tasks: {
      args: { team_id: "9001", list_ids: ["l1", "l2"], folder_ids: ["f1"], tags: ["urgent"], subtasks: true, parent_task_id: "t0" },
      request: { method: "GET", url: `${API}/team/9001/task`, query: { "list_ids[]": ["l1", "l2"], "project_ids[]": "f1", subtasks: "true", "tags[]": "urgent", parent: "t0" } },
      response: { body: { tasks: [] } },
    },
    get_task: {
      args: { task_id: "DEV-12", custom_task_ids: true, team_id: "9001", include_subtasks: true },
      request: { method: "GET", url: `${API}/task/DEV-12`, query: { custom_task_ids: "true", team_id: "9001", include_subtasks: "true" } },
    },
    get_time_in_status: { args: { task_id: "t1" }, request: { method: "GET", url: `${API}/task/t1/time_in_status`, query: "absent" } },
    create_task: {
      args: { list_id: "l1", name: "Ship v2", markdown_content: "**now**", priority: 2, due_date: 1767225600000, assignees: [42], tags: ["release"], parent_task_id: "t0" },
      request: {
        method: "POST",
        url: `${API}/list/l1/task`,
        query: "absent",
        json: { name: "Ship v2", markdown_content: "**now**", priority: 2, due_date: 1767225600000, assignees: [42], tags: ["release"], parent: "t0", notify_all: false },
      },
      response: { body: { id: "t9", name: "Ship v2" } },
    },
    update_task: {
      args: { task_id: "t1", status: "complete", add_assignees: [42], remove_assignees: [7], archived: false },
      request: { method: "PUT", url: `${API}/task/t1`, query: "absent", json: { status: "complete", archived: false, assignees: { add: [42], rem: [7] } } },
    },
    delete_task: { args: { task_id: "t1" }, request: { method: "DELETE", url: `${API}/task/t1`, query: "absent", body: "absent" } },
    list_comments: {
      args: { task_id: "t1", start: 1767225600000, start_id: "c25" },
      request: { method: "GET", url: `${API}/task/t1/comment`, query: { start: "1767225600000", start_id: "c25" } },
      response: { body: { comments: [{ id: "c1", comment_text: "LGTM" }] } },
      expect: { data: [{ id: "c1", comment_text: "LGTM" }] },
    },
    add_comment: {
      args: { task_id: "t1", comment_text: "Deployed" },
      request: { method: "POST", url: `${API}/task/t1/comment`, query: "absent", json: { comment_text: "Deployed", notify_all: false } },
    },
    list_time_entries: {
      args: { team_id: "9001", start_date: 1764547200000, end_date: 1767225600000, list_id: "l1" },
      request: { method: "GET", url: `${API}/team/9001/time_entries`, query: { start_date: "1764547200000", end_date: "1767225600000", list_id: "l1" } },
      response: { body: { data: [{ id: "te1", duration: "3600000" }] } },
      expect: { data: [{ id: "te1", duration: "3600000" }] },
    },
  },
});
