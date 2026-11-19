import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition, wrapHunterDefinition } from "../definition.mjs";

// The generated suite calls api_request as a tool with an arbitrary path, which the tool path allowlist refuses
// (tested in hunter.test.mjs), so the contract runs without that one guard.
const pluginDefinition = wrapHunterDefinition(restDefinition, { guardApiRequestPaths: false });

const API = "https://api.hunter.io/v2";
const lead = { email: "ada@example.com", first_name: "Ada", job_position: "CTO", company: "Example", leads_list_id: 7, custom_attributes: { segment: "retail" } };
const leadJson = { email: "ada@example.com", first_name: "Ada", position: "CTO", company: "Example", leads_list_id: 7, custom_attributes: { segment: "retail" } };

describeRestPluginContract(pluginDefinition, {
  operations: {
    domain_search: {
      args: { domain: "example.com", limit: 20, offset: 10, email_type: "personal", seniority: ["senior", "executive"], department: ["it"], required_field: ["full_name"], verification_status: ["valid"] },
      request: {
        method: "GET",
        url: `${API}/domain-search`,
        query: { domain: "example.com", limit: "20", offset: "10", type: "personal", seniority: "senior,executive", department: "it", required_field: "full_name", verification_status: "valid" },
      },
      response: { body: { data: { domain: "example.com", pattern: "{first}", emails: [{ value: "ada@example.com" }] }, meta: { results: 1 } } },
      expect: { data: { data: { domain: "example.com", pattern: "{first}", emails: [{ value: "ada@example.com" }] }, meta: { results: 1 } } },
    },
    find_email: {
      args: { domain: "example.com", first_name: "Ada", last_name: "Lovelace", max_duration: 5 },
      request: { method: "GET", url: `${API}/email-finder`, query: { domain: "example.com", first_name: "Ada", last_name: "Lovelace", max_duration: "5" } },
    },
    verify_email: { args: { email: "ada@example.com" }, request: { method: "GET", url: `${API}/email-verifier`, query: { email: "ada@example.com" } } },
    count_emails: { args: { company: "Example Inc", email_type: "generic" }, request: { method: "GET", url: `${API}/email-count`, query: { company: "Example Inc", type: "generic" } } },
    enrich_person: { args: { email: "ada@example.com" }, request: { method: "GET", url: `${API}/people/find`, query: { email: "ada@example.com" } } },
    enrich_company: { args: { domain: "example.com" }, request: { method: "GET", url: `${API}/companies/find`, query: { domain: "example.com" } } },
    discover_companies: {
      args: { query: "fintech companies in Jakarta", headcount: ["11-50"], limit: 25 },
      request: { method: "POST", url: `${API}/discover`, query: "absent", json: { query: "fintech companies in Jakarta", headcount: ["11-50"], limit: 25 } },
    },
    get_account: { args: {}, request: { method: "GET", url: `${API}/account`, query: "absent" } },
    list_leads: {
      args: { leads_list_id: 7, company: "Example", limit: 50, cursor: "50" },
      request: { method: "GET", url: `${API}/leads`, query: { leads_list_id: "7", company: "Example", offset: "50", limit: "50" } },
      response: { body: { data: { leads: [{ id: 1, email: "ada@example.com" }] }, meta: { count: 1, total: 51 } } },
      expect: { data: [{ id: 1, email: "ada@example.com" }] },
    },
    get_lead: { args: { lead_id: 1 }, request: { method: "GET", url: `${API}/leads/1`, query: "absent" } },
    create_lead: { args: lead, request: { method: "POST", url: `${API}/leads`, query: "absent", json: leadJson }, response: { status: 201, body: { data: { id: 1 } } } },
    upsert_lead: { args: lead, request: { method: "PUT", url: `${API}/leads`, query: "absent", json: leadJson } },
    update_lead: { args: { lead_id: 1, notes: "Met at expo" }, request: { method: "PUT", url: `${API}/leads/1`, query: "absent", json: { notes: "Met at expo" } }, response: { status: 204 } },
    delete_lead: { args: { lead_id: 1 }, request: { method: "DELETE", url: `${API}/leads/1`, query: "absent", body: "absent" }, response: { status: 204 } },
    list_leads_lists: {
      args: { limit: 10 },
      request: { method: "GET", url: `${API}/leads_lists`, query: { limit: "10" } },
      response: { body: { data: { leads_lists: [{ id: 7, name: "Expo", leads_count: 3 }] }, meta: { total: 1 } } },
      expect: { data: [{ id: 7, name: "Expo", leads_count: 3 }] },
    },
    get_leads_list: { args: { list_id: 7, limit: 50 }, request: { method: "GET", url: `${API}/leads_lists/7`, query: { limit: "50" } } },
    create_leads_list: { args: { name: "Expo 2026" }, request: { method: "POST", url: `${API}/leads_lists`, query: "absent", json: { name: "Expo 2026" } }, response: { status: 201, body: { data: { id: 8 } } } },
    update_leads_list: { args: { list_id: 7, name: "Expo 2026 hot" }, request: { method: "PUT", url: `${API}/leads_lists/7`, query: "absent", json: { name: "Expo 2026 hot" } }, response: { status: 204 } },
    delete_leads_list: { args: { list_id: 7 }, request: { method: "DELETE", url: `${API}/leads_lists/7`, query: "absent", body: "absent" }, response: { status: 204 } },
  },
});
