import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition, wrapZohoDefinition } from "../definition.mjs";

// The generated suite calls api_request as a tool with an arbitrary path, which the tool path allowlist refuses
// (tested in zoho-crm.test.mjs), so the contract runs without that one guard.
const pluginDefinition = wrapZohoDefinition(restDefinition, { guardApiRequestPaths: false });

const API = "https://www.zohoapis.com/crm/v8";
const LEAD_ID = "4876876000000376008";
const LEAD = { id: LEAD_ID, Last_Name: "Daly", Email: "p.daly@example.com" };

// The contract runs with ZOHO_ACCESS_TOKEN only (no refresh trio), so the credential is sent as is.
describeRestPluginContract(pluginDefinition, {
  checkAuth: (call, credential) => assert.equal(call.headers.authorization, `Zoho-oauthtoken ${credential}`),
  operations: {
    list_modules: { args: {}, request: { method: "GET", url: `${API}/settings/modules`, query: "absent" }, response: { body: { modules: [{ api_name: "Leads" }] } }, expect: { data: [{ api_name: "Leads" }] } },
    list_fields: { args: { module: "Leads" }, request: { method: "GET", url: `${API}/settings/fields`, query: { module: "Leads" } }, response: { body: { fields: [{ api_name: "Email" }] } } },
    list_related_lists: { args: { module: "Accounts" }, request: { method: "GET", url: `${API}/settings/related_lists`, query: { module: "Accounts" } }, response: { body: { related_lists: [] } } },
    list_users: { args: { user_type: "ActiveUsers" }, request: { method: "GET", url: `${API}/users`, query: { type: "ActiveUsers", per_page: "200" } }, response: { body: { users: [{ id: "u1" }], info: { more_records: false } } } },
    get_org: { args: {}, request: { method: "GET", url: `${API}/org`, query: "absent" }, response: { body: { org: [{ company_name: "Zylker" }] } }, expect: { data: { company_name: "Zylker" } } },
    list_records: {
      args: { module: "Leads", fields: ["Last_Name", "Email"], sort_by: "Modified_Time", sort_order: "desc", limit: 50 },
      request: { method: "GET", url: `${API}/Leads`, query: { fields: "Last_Name,Email", sort_by: "Modified_Time", sort_order: "desc", per_page: "50" } },
      response: { body: { data: [LEAD], info: { more_records: true, next_page_token: "c8582xx9e7" } } },
      expect: { data: [LEAD] },
    },
    get_record: {
      args: { module: "Leads", record_id: LEAD_ID, fields: ["Email"] },
      request: { method: "GET", url: `${API}/Leads/${LEAD_ID}`, query: { fields: "Email" } },
      response: { body: { data: [LEAD] } },
      expect: { data: LEAD },
    },
    search_records: {
      args: { module: "Leads", criteria: "(Email:equals:p.daly@example.com)" },
      request: { method: "GET", url: `${API}/Leads/search`, query: { criteria: "(Email:equals:p.daly@example.com)", per_page: "200" } },
      response: { body: { data: [LEAD], info: { more_records: false } } },
    },
    coql_query: {
      args: { select_query: "select Last_Name, Email from Leads where Lead_Status = 'Contacted' limit 0, 200" },
      request: { method: "POST", url: `${API}/coql`, query: "absent", json: { select_query: "select Last_Name, Email from Leads where Lead_Status = 'Contacted' limit 0, 200" } },
    },
    list_related_records: {
      args: { module: "Accounts", record_id: "4876876000000333001", related_list: "Contacts", fields: ["Last_Name"] },
      request: { method: "GET", url: `${API}/Accounts/4876876000000333001/Contacts`, query: { fields: "Last_Name", per_page: "200" } },
      response: { body: { data: [{ id: "c1" }], info: { more_records: false } } },
    },
    insert_records: {
      args: { module: "Leads", records: [{ Last_Name: "Daly", Email: "p.daly@example.com" }] },
      request: { method: "POST", url: `${API}/Leads`, query: "absent", json: { data: [{ Last_Name: "Daly", Email: "p.daly@example.com" }], trigger: [] } },
      response: { status: 201, body: { data: [{ code: "SUCCESS", status: "success", details: { id: LEAD_ID } }] } },
    },
    update_records: {
      args: { module: "Leads", records: [{ id: LEAD_ID, Lead_Status: "Contacted" }], trigger: ["workflow"] },
      request: { method: "PUT", url: `${API}/Leads`, query: "absent", json: { data: [{ id: LEAD_ID, Lead_Status: "Contacted" }], trigger: ["workflow"] } },
    },
    upsert_records: {
      args: { module: "Leads", records: [{ Last_Name: "Daly", Email: "p.daly@example.com" }], duplicate_check_fields: ["Email"] },
      request: { method: "POST", url: `${API}/Leads/upsert`, query: "absent", json: { data: [{ Last_Name: "Daly", Email: "p.daly@example.com" }], duplicate_check_fields: ["Email"], trigger: [] } },
    },
    delete_records: {
      args: { module: "Leads", ids: [LEAD_ID, "4876876000000376009"], wf_trigger: false },
      request: { method: "DELETE", url: `${API}/Leads`, query: { ids: `${LEAD_ID},4876876000000376009`, wf_trigger: "false" }, body: "absent" },
    },
  },
});
