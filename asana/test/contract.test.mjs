import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition } from "../definition.mjs";

const ASANA = "https://app.asana.com/api/1.0";
const page = (items) => ({ body: { data: items, next_page: { offset: "eyJ0eXAiOiJKV1Qi", path: "/tasks?offset=eyJ0eXAiOiJKV1Qi", uri: `${ASANA}/tasks?offset=eyJ0eXAiOiJKV1Qi` } } });

// The contract runs on the unwrapped definition; the assignee and api_request guards are tested in asana.test.mjs.
describeRestPluginContract(restDefinition, {
  operations: {
    get_me: { args: { opt_fields: ["name", "email"] }, request: { method: "GET", url: `${ASANA}/users/me`, query: { opt_fields: "name,email" } }, response: { body: { data: { gid: "1", name: "Ada" } } }, expect: { data: { gid: "1", name: "Ada" } } },
    list_workspaces: { args: {}, request: { method: "GET", url: `${ASANA}/workspaces`, query: { limit: "50" } }, response: page([{ gid: "w1" }]), expect: { data: [{ gid: "w1" }] } },
    list_users: { args: { workspace_gid: "w1", limit: 100 }, request: { method: "GET", url: `${ASANA}/users`, query: { workspace: "w1", limit: "100" } } },
    list_projects: { args: { workspace_gid: "w1", archived: false }, request: { method: "GET", url: `${ASANA}/projects`, query: { workspace: "w1", archived: "false", limit: "50" } } },
    get_project: { args: { project_gid: "p1" }, request: { method: "GET", url: `${ASANA}/projects/p1`, query: "absent" } },
    list_sections: { args: { project_gid: "p1" }, request: { method: "GET", url: `${ASANA}/projects/p1/sections`, query: { limit: "50" } } },
    list_tasks: {
      args: { project_gid: "p1", completed_since: "now", opt_fields: ["name", "due_on"], cursor: "eyJ0eXAiOiJKV1Qi" },
      request: { method: "GET", url: `${ASANA}/tasks`, query: { project: "p1", completed_since: "now", opt_fields: "name,due_on", offset: "eyJ0eXAiOiJKV1Qi", limit: "50" } },
      response: page([{ gid: "t1", name: "Ship" }]),
      expect: { data: [{ gid: "t1", name: "Ship" }] },
    },
    get_task: { args: { task_gid: "t/1" }, request: { method: "GET", url: `${ASANA}/tasks/t%2F1`, query: "absent" } },
    search_tasks: {
      args: { workspace_gid: "w1", text: "invoice", completed: false, assignee_any: ["me"], sort_by: "created_at", max_results: 20 },
      request: { method: "GET", url: `${ASANA}/workspaces/w1/tasks/search`, query: { text: "invoice", completed: "false", "assignee.any": "me", sort_by: "created_at", limit: "20" } },
    },
    list_subtasks: { args: { task_gid: "t1" }, request: { method: "GET", url: `${ASANA}/tasks/t1/subtasks`, query: { limit: "50" } } },
    list_stories: { args: { task_gid: "t1", limit: 10 }, request: { method: "GET", url: `${ASANA}/tasks/t1/stories`, query: { limit: "10" } } },
    create_task: {
      args: { name: "Ship", notes: "Release", project_gids: ["p1"], assignee: "me", due_on: "2026-12-01" },
      request: { method: "POST", url: `${ASANA}/tasks`, query: "absent", json: { data: { name: "Ship", notes: "Release", assignee: "me", due_on: "2026-12-01", projects: ["p1"] } } },
      response: { body: { data: { gid: "t9" } } },
      expect: { data: { gid: "t9" } },
    },
    update_task: { args: { task_gid: "t1", name: "Ship v2", due_at: "2026-12-01T09:00:00Z" }, request: { method: "PUT", url: `${ASANA}/tasks/t1`, query: "absent", json: { data: { name: "Ship v2", due_at: "2026-12-01T09:00:00Z" } } } },
    complete_task: { args: { task_gid: "t1" }, request: { method: "PUT", url: `${ASANA}/tasks/t1`, query: "absent", json: { data: { completed: true } } } },
    create_subtask: { args: { task_gid: "t1", name: "Step 1" }, request: { method: "POST", url: `${ASANA}/tasks/t1/subtasks`, query: "absent", json: { data: { name: "Step 1" } } } },
    create_section: { args: { project_gid: "p1", name: "Doing" }, request: { method: "POST", url: `${ASANA}/projects/p1/sections`, query: "absent", json: { data: { name: "Doing" } } } },
    add_task_to_section: { args: { section_gid: "s1", task_gid: "t1" }, request: { method: "POST", url: `${ASANA}/sections/s1/addTask`, query: "absent", json: { data: { task: "t1" } } } },
    add_comment: { args: { task_gid: "t1", text: "Done" }, request: { method: "POST", url: `${ASANA}/tasks/t1/stories`, query: "absent", json: { data: { text: "Done" } } } },
    delete_task: { args: { task_gid: "t1" }, request: { method: "DELETE", url: `${ASANA}/tasks/t1`, query: "absent", body: "absent" } },
  },
});
