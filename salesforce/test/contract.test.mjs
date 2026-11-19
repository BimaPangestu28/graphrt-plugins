import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://acme.my.salesforce.com/services/data/v66.0";
const ACCOUNT_ID = "001D000000IqhSLIAZ";
const SOQL = "SELECT Id, Name FROM Account WHERE Industry = 'Retail' LIMIT 50";
const QUERY_PAGE = { totalSize: 3000, done: false, nextRecordsUrl: "/services/data/v66.0/query/01gD0000002HU6KIAW-2000", records: [{ Id: ACCOUNT_ID, Name: "Acme" }] };

describeRestPluginContract(pluginDefinition, {
  environment: { SALESFORCE_INSTANCE_URL: "https://acme.my.salesforce.com" },
  operations: {
    get_limits: { args: {}, request: { method: "GET", url: `${API}/limits`, query: "absent" }, response: { body: { DailyApiRequests: { Max: 15000, Remaining: 14998 } } } },
    describe_global: {
      args: {},
      request: { method: "GET", url: `${API}/sobjects`, query: "absent" },
      response: { body: { encoding: "UTF-8", sobjects: [{ name: "Account" }] } },
      expect: { data: [{ name: "Account" }] },
    },
    describe_sobject: { args: { sobject: "Invoice__c" }, request: { method: "GET", url: `${API}/sobjects/Invoice__c/describe`, query: "absent" } },
    query: { args: { soql: SOQL }, request: { method: "GET", url: `${API}/query`, query: { q: SOQL } }, response: { body: QUERY_PAGE }, expect: { data: QUERY_PAGE } },
    query_all: { args: { soql: SOQL }, request: { method: "GET", url: `${API}/queryAll`, query: { q: SOQL } } },
    query_more: {
      args: { query_locator: "/services/data/v66.0/query/01gD0000002HU6KIAW-2000" },
      request: { method: "GET", url: `${API}/query/01gD0000002HU6KIAW-2000`, query: "absent" },
    },
    search: {
      args: { sosl: "FIND {Acme} IN NAME FIELDS RETURNING Account(Id, Name)" },
      request: { method: "GET", url: `${API}/search`, query: { q: "FIND {Acme} IN NAME FIELDS RETURNING Account(Id, Name)" } },
      response: { body: { searchRecords: [{ Id: ACCOUNT_ID }] } },
      expect: { data: [{ Id: ACCOUNT_ID }] },
    },
    list_recently_viewed: { args: { max_records: 10 }, request: { method: "GET", url: `${API}/recent`, query: { limit: "10" } } },
    get_updated: {
      args: { sobject: "Account", start: "2026-11-01T00:00:00Z", end: "2026-11-19T00:00:00Z" },
      request: { method: "GET", url: `${API}/sobjects/Account/updated/`, query: { start: "2026-11-01T00:00:00Z", end: "2026-11-19T00:00:00Z" } },
    },
    get_deleted: {
      args: { sobject: "Account", start: "2026-11-01T00:00:00Z", end: "2026-11-19T00:00:00Z" },
      request: { method: "GET", url: `${API}/sobjects/Account/deleted/`, query: { start: "2026-11-01T00:00:00Z", end: "2026-11-19T00:00:00Z" } },
    },
    get_record: {
      args: { sobject: "Account", record_id: ACCOUNT_ID, fields: ["Id", "Name", "Industry"] },
      request: { method: "GET", url: `${API}/sobjects/Account/${ACCOUNT_ID}`, query: { fields: "Id,Name,Industry" } },
    },
    get_record_by_external_id: {
      args: { sobject: "Account", external_id_field: "Customer_Number__c", external_id: "CN/42" },
      request: { method: "GET", url: `${API}/sobjects/Account/Customer_Number__c/CN%2F42`, query: "absent" },
    },
    create_record: {
      args: { sobject: "Account", fields: { Name: "Acme", Industry: "Retail" } },
      request: { method: "POST", url: `${API}/sobjects/Account`, query: "absent", json: { Name: "Acme", Industry: "Retail" } },
      response: { status: 201, body: { id: ACCOUNT_ID, success: true, errors: [] } },
    },
    update_record: {
      args: { sobject: "Account", record_id: ACCOUNT_ID, fields: { Industry: "Banking" } },
      request: { method: "PATCH", url: `${API}/sobjects/Account/${ACCOUNT_ID}`, query: "absent", json: { Industry: "Banking" } },
      response: { status: 204 },
    },
    upsert_record: {
      args: { sobject: "Account", external_id_field: "Customer_Number__c", external_id: "CN42", fields: { Name: "Acme" } },
      request: { method: "PATCH", url: `${API}/sobjects/Account/Customer_Number__c/CN42`, query: "absent", json: { Name: "Acme" } },
      response: { status: 201, body: { id: ACCOUNT_ID, success: true, created: true } },
    },
    delete_record: { args: { sobject: "Account", record_id: ACCOUNT_ID }, request: { method: "DELETE", url: `${API}/sobjects/Account/${ACCOUNT_ID}`, query: "absent", body: "absent" }, response: { status: 204 } },
  },
});
