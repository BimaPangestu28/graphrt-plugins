import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { contractDefinition } from "../definition.mjs";

const API = "https://googleads.googleapis.com/v26";
const CUSTOMER = "1234567890";
const QUERY = "SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status = 'ENABLED'";
const statusUpdate = [{ updateMask: "status", update: { resourceName: `customers/${CUSTOMER}/campaigns/111`, status: "PAUSED" } }];

// The simple mutates are contract-tested with their raw `operations` argument; their id-based arguments, the
// reports, the budget cap and the api_request allowlist are covered in agent-policy.test.mjs.
describeRestPluginContract(contractDefinition, {
  checkAuth: (call, credential) => assert.equal(call.headers.authorization, `Bearer ${credential}`),
  operations: {
    list_accessible_customers: {
      args: {},
      request: { method: "GET", url: `${API}/customers:listAccessibleCustomers`, query: "absent" },
      response: { body: { resourceNames: [`customers/${CUSTOMER}`] } },
      expect: { data: [`customers/${CUSTOMER}`] },
    },
    search: {
      args: { customer_id: "123-456-7890", query: QUERY },
      request: { method: "POST", url: `${API}/customers/${CUSTOMER}/googleAds:search`, query: "absent", json: { query: QUERY } },
      response: { body: { results: [{ campaign: { id: "111", name: "Brand" } }], nextPageToken: "page-2", fieldMask: "campaign.id,campaign.name" } },
      expect: { data: [{ campaign: { id: "111", name: "Brand" } }] },
    },
    search_stream: {
      args: { customer_id: CUSTOMER, query: QUERY },
      request: { method: "POST", url: `${API}/customers/${CUSTOMER}/googleAds:searchStream`, query: "absent", json: { query: QUERY } },
    },
    set_campaign_status: {
      args: { customer_id: CUSTOMER, operations: statusUpdate, validate_only: true },
      request: { method: "POST", url: `${API}/customers/${CUSTOMER}/campaigns:mutate`, query: "absent", json: { operations: statusUpdate, validateOnly: true } },
    },
    set_ad_group_status: {
      args: { customer_id: CUSTOMER, operations: [{ updateMask: "status", update: { resourceName: `customers/${CUSTOMER}/adGroups/222`, status: "ENABLED" } }] },
      request: { method: "POST", url: `${API}/customers/${CUSTOMER}/adGroups:mutate`, query: "absent", json: { operations: [{ updateMask: "status", update: { resourceName: `customers/${CUSTOMER}/adGroups/222`, status: "ENABLED" } }] } },
    },
    set_campaign_budget_amount: {
      // 20000000 micros = 20.00 in the account currency.
      args: { customer_id: CUSTOMER, operations: [{ updateMask: "amountMicros", update: { resourceName: `customers/${CUSTOMER}/campaignBudgets/333`, amountMicros: "20000000" } }] },
      request: {
        method: "POST",
        url: `${API}/customers/${CUSTOMER}/campaignBudgets:mutate`,
        query: "absent",
        json: { operations: [{ updateMask: "amountMicros", update: { resourceName: `customers/${CUSTOMER}/campaignBudgets/333`, amountMicros: "20000000" } }] },
      },
    },
    mutate_campaigns: {
      args: { customer_id: CUSTOMER, operations: [{ remove: `customers/${CUSTOMER}/campaigns/111` }], partial_failure: true },
      request: { method: "POST", url: `${API}/customers/${CUSTOMER}/campaigns:mutate`, query: "absent", json: { operations: [{ remove: `customers/${CUSTOMER}/campaigns/111` }], partialFailure: true } },
    },
    mutate_campaign_budgets: {
      args: { customer_id: CUSTOMER, operations: [{ create: { name: "Daily 20", amountMicros: "20000000" } }], response_content_type: "MUTABLE_RESOURCE" },
      request: {
        method: "POST",
        url: `${API}/customers/${CUSTOMER}/campaignBudgets:mutate`,
        query: "absent",
        json: { operations: [{ create: { name: "Daily 20", amountMicros: "20000000" } }], responseContentType: "MUTABLE_RESOURCE" },
      },
    },
    mutate_ad_groups: {
      args: { customer_id: CUSTOMER, operations: [{ remove: `customers/${CUSTOMER}/adGroups/222` }] },
      request: { method: "POST", url: `${API}/customers/${CUSTOMER}/adGroups:mutate`, query: "absent", json: { operations: [{ remove: `customers/${CUSTOMER}/adGroups/222` }] } },
    },
    mutate_ad_group_ads: {
      args: { customer_id: CUSTOMER, operations: [{ update: { resourceName: `customers/${CUSTOMER}/adGroupAds/222~444`, status: "PAUSED" }, updateMask: "status" }], validate_only: true },
      request: {
        method: "POST",
        url: `${API}/customers/${CUSTOMER}/adGroupAds:mutate`,
        query: "absent",
        json: { operations: [{ update: { resourceName: `customers/${CUSTOMER}/adGroupAds/222~444`, status: "PAUSED" }, updateMask: "status" }], validateOnly: true },
      },
    },
    mutate_ad_group_criteria: {
      args: { customer_id: CUSTOMER, operations: [{ create: { adGroup: `customers/${CUSTOMER}/adGroups/222`, keyword: { text: "running shoes", matchType: "PHRASE" } } }] },
      request: {
        method: "POST",
        url: `${API}/customers/${CUSTOMER}/adGroupCriteria:mutate`,
        query: "absent",
        json: { operations: [{ create: { adGroup: `customers/${CUSTOMER}/adGroups/222`, keyword: { text: "running shoes", matchType: "PHRASE" } } }] },
      },
    },
    mutate: {
      args: { customer_id: CUSTOMER, operations: [{ campaignOperation: { update: { resourceName: `customers/${CUSTOMER}/campaigns/111`, name: "Brand 2" }, updateMask: "name" } }] },
      request: {
        method: "POST",
        url: `${API}/customers/${CUSTOMER}/googleAds:mutate`,
        query: "absent",
        json: { mutateOperations: [{ campaignOperation: { update: { resourceName: `customers/${CUSTOMER}/campaigns/111`, name: "Brand 2" }, updateMask: "name" } }] },
      },
    },
  },
});
