import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition, wrapApolloDefinition } from "../definition.mjs";

// The generated suite calls api_request as a tool with an arbitrary path, which the tool path allowlist refuses
// (tested in apollo.test.mjs), so the contract runs without that one guard.
const pluginDefinition = wrapApolloDefinition(restDefinition, { guardApiRequestPaths: false });

const API = "https://api.apollo.io/api/v1";

describeRestPluginContract(pluginDefinition, {
  operations: {
    search_people: {
      args: { person_titles: ["marketing manager", "cmo"], person_locations: ["Indonesia"], revenue_min: 1000000, limit: 10, cursor: "2" },
      request: {
        method: "POST",
        url: `${API}/mixed_people/api_search`,
        query: { "person_titles[]": ["marketing manager", "cmo"], "person_locations[]": "Indonesia", "revenue_range[min]": "1000000", page: "2", per_page: "10" },
        body: "absent",
      },
      response: { body: { total_entries: 1, people: [{ id: "p1", first_name: "Ada", last_name_obfuscated: "Lo***e" }] } },
      expect: { data: [{ id: "p1", first_name: "Ada", last_name_obfuscated: "Lo***e" }] },
    },
    search_organizations: {
      args: { q_organization_name: "Tokopedia", organization_locations: ["Jakarta, Indonesia"] },
      request: { method: "POST", url: `${API}/mixed_companies/search`, query: { q_organization_name: "Tokopedia", "organization_locations[]": "Jakarta, Indonesia", per_page: "25" }, body: "absent" },
      response: { body: { organizations: [{ id: "o1", name: "Tokopedia" }], pagination: { page: 1, per_page: 25, total_entries: 1, total_pages: 1 } } },
      expect: { data: [{ id: "o1", name: "Tokopedia" }] },
    },
    enrich_person: {
      args: { email: "ada@example.com", reveal_personal_emails: false },
      request: { method: "POST", url: `${API}/people/match`, query: { email: "ada@example.com", reveal_personal_emails: "false" }, body: "absent" },
    },
    enrich_person_with_callback: {
      args: { linkedin_url: "https://www.linkedin.com/in/ada", reveal_phone_number: true, webhook_url: "https://hooks.example.com/apollo" },
      request: { method: "POST", url: `${API}/people/match`, query: { linkedin_url: "https://www.linkedin.com/in/ada", reveal_phone_number: "true", webhook_url: "https://hooks.example.com/apollo" }, body: "absent" },
    },
    bulk_enrich_people: {
      args: { details: [{ email: "ada@example.com" }, { first_name: "Budi", last_name: "Santoso", domain: "example.co.id" }], reveal_personal_emails: true },
      request: { method: "POST", url: `${API}/people/bulk_match`, query: { reveal_personal_emails: "true" }, json: { details: [{ email: "ada@example.com" }, { first_name: "Budi", last_name: "Santoso", domain: "example.co.id" }] } },
    },
    enrich_organization: { args: { domain: "example.com" }, request: { method: "GET", url: `${API}/organizations/enrich`, query: { domain: "example.com" } } },
    bulk_enrich_organizations: {
      args: { details: [{ domain: "example.com" }, { name: "Example", website: "example.co.id" }] },
      request: { method: "POST", url: `${API}/organizations/bulk_enrich`, query: "absent", json: { details: [{ domain: "example.com" }, { name: "Example", website: "example.co.id" }] } },
    },
    search_contacts: {
      args: { q_keywords: "ada", sort_by_field: "contact_created_at", limit: 50 },
      request: { method: "POST", url: `${API}/contacts/search`, query: "absent", json: { q_keywords: "ada", sort_by_field: "contact_created_at", per_page: 50 } },
      response: { body: { contacts: [{ id: "c1" }], pagination: { page: 1, per_page: 50, total_entries: 51, total_pages: 2 } } },
      expect: { data: [{ id: "c1" }] },
    },
    get_contact: { args: { contact_id: "c1" }, request: { method: "GET", url: `${API}/contacts/c1`, query: "absent" } },
    create_contact: {
      args: { first_name: "Ada", last_name: "Lovelace", job_title: "CTO", email: "ada@example.com", label_names: ["Expo"], run_dedupe: true },
      request: { method: "POST", url: `${API}/contacts`, query: "absent", json: { first_name: "Ada", last_name: "Lovelace", title: "CTO", email: "ada@example.com", label_names: ["Expo"], run_dedupe: true } },
    },
    update_contact: { args: { contact_id: "c1", job_title: "CEO" }, request: { method: "PATCH", url: `${API}/contacts/c1`, query: "absent", json: { title: "CEO" } } },
    list_contact_stages: {
      args: {},
      request: { method: "GET", url: `${API}/contact_stages`, query: "absent" },
      response: { body: { contact_stages: [{ id: "s1", name: "Cold" }] } },
      expect: { data: [{ id: "s1", name: "Cold" }] },
    },
    search_accounts: {
      args: { q_organization_name: "Example" },
      request: { method: "POST", url: `${API}/accounts/search`, query: "absent", json: { q_organization_name: "Example", per_page: 25 } },
      response: { body: { accounts: [{ id: "a1" }], pagination: { total_pages: 1 } } },
      expect: { data: [{ id: "a1" }] },
    },
    search_sequences: {
      args: { q_name: "Onboarding" },
      request: { method: "POST", url: `${API}/emailer_campaigns/search`, query: { q_name: "Onboarding", per_page: "25" }, body: "absent" },
      response: { body: { emailer_campaigns: [{ id: "e1", name: "Onboarding" }], pagination: { total_pages: 1 } } },
      expect: { data: [{ id: "e1", name: "Onboarding" }] },
    },
    list_email_accounts: { args: {}, request: { method: "GET", url: `${API}/email_accounts`, query: "absent" }, response: { body: { email_accounts: [{ id: "m1" }] } }, expect: { data: [{ id: "m1" }] } },
    add_contacts_to_sequence: {
      args: { sequence_id: "e1", contact_ids: ["c1", "c2"], send_email_from_email_account_id: "m1", sequence_status: "paused" },
      request: {
        method: "POST",
        url: `${API}/emailer_campaigns/e1/add_contact_ids`,
        query: { emailer_campaign_id: "e1", "contact_ids[]": ["c1", "c2"], send_email_from_email_account_id: "m1", status: "paused" },
        body: "absent",
      },
    },
    get_api_usage: { args: {}, request: { method: "POST", url: `${API}/usage_stats/api_usage_stats`, query: "absent", body: "absent" } },
  },
});
