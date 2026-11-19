import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition } from "../definition.mjs";

const API = "https://api.todoist.com/api/v1";
const page = (results, nextCursor = null) => ({ body: { results, next_cursor: nextCursor } });

describeRestPluginContract(restDefinition, {
  operations: {
    get_user: { args: {}, request: { method: "GET", url: `${API}/user`, query: "absent" }, response: { body: { id: "u1", full_name: "Ada" } } },
    list_projects: {
      args: { limit: 100 },
      request: { method: "GET", url: `${API}/projects`, query: { limit: "100" } },
      response: page([{ id: "p1", name: "Work" }], "cur2"),
      expect: { data: [{ id: "p1", name: "Work" }] },
    },
    get_project: { args: { project_id: "6XR4H993xv8H5qCR" }, request: { method: "GET", url: `${API}/projects/6XR4H993xv8H5qCR`, query: "absent" } },
    create_project: {
      args: { name: "Launch", color: "blue", project_view_style: "board" },
      request: { method: "POST", url: `${API}/projects`, query: "absent", json: { name: "Launch", color: "blue", view_style: "board" } },
    },
    update_project: {
      args: { project_id: "p1", name: "Launch v2", is_favorite: true },
      request: { method: "POST", url: `${API}/projects/p1`, query: "absent", json: { name: "Launch v2", is_favorite: true } },
    },
    list_sections: { args: { project_id: "p1" }, request: { method: "GET", url: `${API}/sections`, query: { project_id: "p1", limit: "50" } }, response: page([{ id: "s1" }]), expect: { data: [{ id: "s1" }] } },
    create_section: {
      args: { name: "Backlog", project_id: "p1" },
      request: { method: "POST", url: `${API}/sections`, query: "absent", json: { name: "Backlog", project_id: "p1" } },
    },
    list_tasks: {
      args: { project_id: "p1", label: "bills", ids: ["t1", "t2"] },
      request: { method: "GET", url: `${API}/tasks`, query: { project_id: "p1", label: "bills", ids: "t1,t2", limit: "50" } },
      response: page([{ id: "t1", content: "Pay rent" }]),
      expect: { data: [{ id: "t1", content: "Pay rent" }] },
    },
    filter_tasks: {
      args: { query: "today | overdue", lang: "en", cursor: "abc", limit: 20 },
      request: { method: "GET", url: `${API}/tasks/filter`, query: { query: "today | overdue", lang: "en", cursor: "abc", limit: "20" } },
      response: page([{ id: "t3" }]),
    },
    list_completed_tasks: {
      args: { since: "2026-11-01T00:00:00Z", until: "2026-11-19T23:59:59Z", project_id: "p1" },
      request: { method: "GET", url: `${API}/tasks/completed/by_completion_date`, query: { since: "2026-11-01T00:00:00Z", until: "2026-11-19T23:59:59Z", project_id: "p1", limit: "50" } },
      response: { body: { items: [{ id: "t9" }], next_cursor: null } },
      expect: { data: [{ id: "t9" }] },
    },
    get_task: { args: { task_id: "t1" }, request: { method: "GET", url: `${API}/tasks/t1`, query: "absent" } },
    create_task: {
      args: { content: "Pay rent", project_id: "p1", due_string: "every 1st", priority: 4, labels: ["bills"], duration: 15, duration_unit: "minute" },
      request: {
        method: "POST",
        url: `${API}/tasks`,
        query: "absent",
        json: { content: "Pay rent", project_id: "p1", labels: ["bills"], priority: 4, due_string: "every 1st", duration: 15, duration_unit: "minute" },
      },
      response: { body: { id: "t5", content: "Pay rent" } },
    },
    quick_add_task: {
      args: { text: "Pay rent tomorrow #Home @bills p1", note: "via graphrt" },
      request: { method: "POST", url: `${API}/tasks/quick`, query: "absent", json: { text: "Pay rent tomorrow #Home @bills p1", note: "via graphrt" } },
    },
    update_task: {
      args: { task_id: "t1", content: "Pay rent (paid)", deadline_date: "2026-12-01" },
      request: { method: "POST", url: `${API}/tasks/t1`, query: "absent", json: { content: "Pay rent (paid)", deadline_date: "2026-12-01" } },
    },
    move_task: { args: { task_id: "t1", section_id: "s1" }, request: { method: "POST", url: `${API}/tasks/t1/move`, query: "absent", json: { section_id: "s1" } } },
    close_task: { args: { task_id: "t1" }, request: { method: "POST", url: `${API}/tasks/t1/close`, query: "absent", body: "absent" } },
    reopen_task: { args: { task_id: "t1" }, request: { method: "POST", url: `${API}/tasks/t1/reopen`, query: "absent", body: "absent" } },
    delete_task: { args: { task_id: "t1" }, request: { method: "DELETE", url: `${API}/tasks/t1`, query: "absent", body: "absent" } },
    list_labels: { args: {}, request: { method: "GET", url: `${API}/labels`, query: { limit: "50" } }, response: page([{ id: "l1", name: "bills" }]), expect: { data: [{ id: "l1", name: "bills" }] } },
    list_comments: { args: { task_id: "t1" }, request: { method: "GET", url: `${API}/comments`, query: { task_id: "t1", limit: "50" } }, response: page([{ id: "c1" }]) },
    add_comment: {
      args: { task_id: "t1", content: "Paid via bank transfer", uids_to_notify: ["u2"] },
      request: { method: "POST", url: `${API}/comments`, query: "absent", json: { content: "Paid via bank transfer", task_id: "t1", uids_to_notify: ["u2"] } },
    },
  },
});
