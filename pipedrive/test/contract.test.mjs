import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.pipedrive.com/api";
const page = (items, nextCursor = null) => ({ body: { success: true, data: items, additional_data: { next_cursor: nextCursor } } });
const searchPage = (items) => ({ body: { success: true, data: { items }, additional_data: { next_cursor: null } } });

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls api_request on "/anything" as a tool; the extra-paths env lets that path through.
  environment: { PIPEDRIVE_TOOL_API_EXTRA_PATHS: "/anything" },
  checkAuth: (call, credential) => assert.equal(call.headers["x-api-token"], credential),
  operations: {
    list_persons: {
      args: { org_id: 7, ids: [1, 2], sort_by: "update_time", sort_direction: "desc", custom_fields: ["abc"], include_fields: ["open_deals_count"], limit: 50 },
      request: { method: "GET", url: `${API}/v2/persons`, query: { org_id: "7", ids: "1,2", sort_by: "update_time", sort_direction: "desc", custom_fields: "abc", include_fields: "open_deals_count", limit: "50" } },
      response: page([{ id: 1, name: "Ada" }], "c2"),
      expect: { data: [{ id: 1, name: "Ada" }] },
    },
    get_person: { args: { person_id: 5 }, request: { method: "GET", url: `${API}/v2/persons/5`, query: "absent" } },
    create_person: {
      args: { name: "Ada Lovelace", emails: [{ value: "ada@example.com", primary: true }], org_id: 7, visible_to: 3, custom_fields: { a1b2: "VIP" } },
      request: {
        method: "POST",
        url: `${API}/v2/persons`,
        query: "absent",
        json: { name: "Ada Lovelace", emails: [{ value: "ada@example.com", primary: true }], org_id: 7, visible_to: 3, custom_fields: { a1b2: "VIP" } },
      },
      response: { body: { success: true, data: { id: 9 } } },
    },
    update_person: {
      args: { person_id: 5, phones: [{ value: "+62811", label: "mobile" }], owner_id: 2 },
      request: { method: "PATCH", url: `${API}/v2/persons/5`, query: "absent", json: { phones: [{ value: "+62811", label: "mobile" }], owner_id: 2 } },
    },
    delete_person: { args: { person_id: 5 }, request: { method: "DELETE", url: `${API}/v2/persons/5`, query: "absent", body: "absent" } },
    search_persons: {
      args: { term: "ada@example.com", fields: ["email"], exact_match: true, organization_id: 7, include_fields: ["person.picture"] },
      request: { method: "GET", url: `${API}/v2/persons/search`, query: { term: "ada@example.com", fields: "email", exact_match: "true", organization_id: "7", include_fields: "person.picture", limit: "100" } },
      response: searchPage([{ result_score: 1.2, item: { id: 5 } }]),
      expect: { data: [{ result_score: 1.2, item: { id: 5 } }] },
    },
    list_organizations: { args: { owner_id: 2 }, request: { method: "GET", url: `${API}/v2/organizations`, query: { owner_id: "2", limit: "100" } }, response: page([]) },
    get_organization: { args: { organization_id: 7 }, request: { method: "GET", url: `${API}/v2/organizations/7`, query: "absent" } },
    create_organization: {
      args: { name: "Acme", address: { value: "Jl. Sudirman 1, Jakarta" }, website: "https://acme.example" },
      request: { method: "POST", url: `${API}/v2/organizations`, query: "absent", json: { name: "Acme", address: { value: "Jl. Sudirman 1, Jakarta" }, website: "https://acme.example" } },
    },
    update_organization: { args: { organization_id: 7, industry: "42" }, request: { method: "PATCH", url: `${API}/v2/organizations/7`, query: "absent", json: { industry: 42 } } },
    delete_organization: { args: { organization_id: 7 }, request: { method: "DELETE", url: `${API}/v2/organizations/7`, query: "absent", body: "absent" } },
    search_organizations: {
      args: { term: "Acme", fields: ["name", "address"] },
      request: { method: "GET", url: `${API}/v2/organizations/search`, query: { term: "Acme", fields: "name,address", limit: "100" } },
      response: searchPage([]),
    },
    list_deals: {
      args: { status: "open", pipeline_id: 1, stage_id: 3, updated_since: "2026-01-01T00:00:00Z", cursor: "c2" },
      request: { method: "GET", url: `${API}/v2/deals`, query: { status: "open", pipeline_id: "1", stage_id: "3", updated_since: "2026-01-01T00:00:00Z", cursor: "c2", limit: "100" } },
      response: page([{ id: 11 }]),
    },
    get_deal: { args: { deal_id: 11 }, request: { method: "GET", url: `${API}/v2/deals/11`, query: "absent" } },
    create_deal: {
      args: { deal_title: "Acme renewal", value: 5000000, currency: "IDR", person_id: 5, org_id: 7, stage_id: 3, expected_close_date: "2026-12-31" },
      request: {
        method: "POST",
        url: `${API}/v2/deals`,
        query: "absent",
        json: { title: "Acme renewal", value: 5000000, currency: "IDR", person_id: 5, org_id: 7, stage_id: 3, expected_close_date: "2026-12-31" },
      },
    },
    update_deal: { args: { deal_id: 11, status: "lost", lost_reason: "Budget" }, request: { method: "PATCH", url: `${API}/v2/deals/11`, query: "absent", json: { status: "lost", lost_reason: "Budget" } } },
    delete_deal: { args: { deal_id: 11 }, request: { method: "DELETE", url: `${API}/v2/deals/11`, query: "absent", body: "absent" } },
    search_deals: {
      args: { term: "renewal", status: "open", person_id: 5 },
      request: { method: "GET", url: `${API}/v2/deals/search`, query: { term: "renewal", status: "open", person_id: "5", limit: "100" } },
      response: searchPage([{ result_score: 0.9, item: { id: 11 } }]),
    },
    list_activities: {
      args: { deal_id: 11, done: false, sort_by: "due_date" },
      request: { method: "GET", url: `${API}/v2/activities`, query: { deal_id: "11", done: "false", sort_by: "due_date", limit: "100" } },
      response: page([{ id: 21 }]),
    },
    get_activity: { args: { activity_id: 21, include_fields: ["attendees"] }, request: { method: "GET", url: `${API}/v2/activities/21`, query: { include_fields: "attendees" } } },
    create_activity: {
      args: { subject: "Call Ada", activity_type: "call", deal_id: 11, participants: [{ person_id: 5, primary: true }], due_date: "2026-12-01", due_time: "09:00" },
      request: {
        method: "POST",
        url: `${API}/v2/activities`,
        query: "absent",
        json: { subject: "Call Ada", type: "call", deal_id: 11, participants: [{ person_id: 5, primary: true }], due_date: "2026-12-01", due_time: "09:00" },
      },
    },
    update_activity: { args: { activity_id: 21, done: true }, request: { method: "PATCH", url: `${API}/v2/activities/21`, query: "absent", json: { done: true } } },
    delete_activity: { args: { activity_id: 21 }, request: { method: "DELETE", url: `${API}/v2/activities/21`, query: "absent", body: "absent" } },
    list_pipelines: { args: {}, request: { method: "GET", url: `${API}/v2/pipelines`, query: { limit: "100" } }, response: page([{ id: 1, name: "Sales" }]) },
    list_stages: { args: { pipeline_id: 1, sort_by: "order_nr" }, request: { method: "GET", url: `${API}/v2/stages`, query: { pipeline_id: "1", sort_by: "order_nr", limit: "100" } }, response: page([]) },
    list_notes: {
      args: { deal_id: 11, sort: "add_time DESC", limit: 20 },
      request: { method: "GET", url: `${API}/v1/notes`, query: { deal_id: "11", sort: "add_time DESC", limit: "20" } },
      response: { body: { success: true, data: [{ id: 31 }], additional_data: { pagination: { start: 0, limit: 20, more_items_in_collection: false } } } },
      expect: { data: [{ id: 31 }] },
    },
    get_note: { args: { note_id: 31 }, request: { method: "GET", url: `${API}/v1/notes/31`, query: "absent" } },
    create_note: {
      args: { content: "Called, wants a demo", deal_id: 11, pinned_to_deal_flag: 1 },
      request: { method: "POST", url: `${API}/v1/notes`, query: "absent", json: { content: "Called, wants a demo", deal_id: 11, pinned_to_deal_flag: 1 } },
    },
    update_note: { args: { note_id: 31, content: "Demo booked" }, request: { method: "PUT", url: `${API}/v1/notes/31`, query: "absent", json: { content: "Demo booked" } } },
    delete_note: { args: { note_id: 31 }, request: { method: "DELETE", url: `${API}/v1/notes/31`, query: "absent", body: "absent" } },
    get_current_user: { args: {}, request: { method: "GET", url: `${API}/v1/users/me`, query: "absent" }, response: { body: { success: true, data: { id: 2, company_domain: "acme" } } }, expect: { data: { id: 2, company_domain: "acme" } } },
  },
});
