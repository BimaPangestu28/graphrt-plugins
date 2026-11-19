import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://business-api.tiktok.com/open_api/v1.3";
const ADVERTISER = "7000000000000000001";
const ok = (data) => ({ body: { code: 0, message: "OK", request_id: "r1", data } });
const owned = ok({ list: [{ campaign_id: "c1" }, { campaign_id: "c2" }, { adgroup_id: "g1" }, { ad_id: "a1" }] });

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls opt-in operations as tools (budget changes need the cap) and api_request on "/anything".
  environment: { TIKTOK_ADS_TOOL_MAX_BUDGET: "1000", TIKTOK_ADS_TOOL_ADVERTISER_IDS: ADVERTISER, TIKTOK_ADS_TOOL_API_EXTRA_PATHS: "/anything" },
  operations: {
    get_advertiser_info: {
      args: { advertiser_ids: [ADVERTISER], fields: ["name", "currency", "timezone"] },
      request: { method: "GET", url: `${API}/advertiser/info/`, query: { advertiser_ids: `["${ADVERTISER}"]`, fields: '["name","currency","timezone"]' } },
      response: ok({ list: [{ advertiser_id: ADVERTISER, name: "Shop", currency: "USD" }] }),
      expect: { data: [{ advertiser_id: ADVERTISER, name: "Shop", currency: "USD" }] },
    },
    list_campaigns: {
      args: { advertiser_id: ADVERTISER, fields: ["campaign_id", "campaign_name", "budget"], filtering: { objective_type: "TRAFFIC" }, limit: 50 },
      request: {
        method: "GET",
        url: `${API}/campaign/get/`,
        query: { advertiser_id: ADVERTISER, fields: '["campaign_id","campaign_name","budget"]', filtering: '{"objective_type":"TRAFFIC"}', page_size: "50" },
      },
      response: ok({ list: [{ campaign_id: "c1" }], page_info: { page: 1, page_size: 50, total_number: 1, total_page: 1 } }),
      expect: { data: [{ campaign_id: "c1" }] },
    },
    list_ad_groups: {
      args: { advertiser_id: ADVERTISER, filtering: { campaign_ids: ["c1"] } },
      request: { method: "GET", url: `${API}/adgroup/get/`, query: { advertiser_id: ADVERTISER, filtering: '{"campaign_ids":["c1"]}', page_size: "100" } },
    },
    list_ads: {
      args: { advertiser_id: ADVERTISER },
      request: { method: "GET", url: `${API}/ad/get/`, query: { advertiser_id: ADVERTISER, page_size: "100" } },
    },
    get_report: {
      args: { advertiser_id: ADVERTISER, data_level: "AUCTION_CAMPAIGN", dimensions: ["campaign_id", "stat_time_day"], metrics: ["spend", "impressions", "clicks"], start_date: "2026-11-01", end_date: "2026-11-18", order_field: "spend", order_type: "DESC" },
      request: {
        method: "GET",
        url: `${API}/report/integrated/get/`,
        query: {
          advertiser_id: ADVERTISER,
          report_type: "BASIC",
          data_level: "AUCTION_CAMPAIGN",
          dimensions: '["campaign_id","stat_time_day"]',
          metrics: '["spend","impressions","clicks"]',
          start_date: "2026-11-01",
          end_date: "2026-11-18",
          order_field: "spend",
          order_type: "DESC",
          page_size: "100",
        },
      },
    },
    list_lead_forms: {
      args: { advertiser_id: ADVERTISER, status: "PUBLISHED" },
      request: { method: "GET", url: `${API}/page/get/`, query: { advertiser_id: ADVERTISER, status: "PUBLISHED", business_type: "LEAD_GEN", page_size: "20" } },
    },
    get_lead_form_fields: {
      args: { advertiser_id: ADVERTISER, page_id: "p1" },
      request: { method: "GET", url: `${API}/lead/field/get/`, query: { advertiser_id: ADVERTISER, lead_source: "INSTANT_FORM", page_id: "p1" } },
    },
    get_lead: {
      args: { advertiser_id: ADVERTISER, page_id: "p1" },
      request: { method: "GET", url: `${API}/lead/get/`, query: { advertiser_id: ADVERTISER, lead_source: "INSTANT_FORM", page_id: "p1" } },
    },
    create_lead_download_task: {
      args: { advertiser_id: ADVERTISER, page_id: "p1", lead_region: "eu" },
      request: { method: "POST", url: `${API}/page/lead/task/`, query: "absent", json: { advertiser_id: ADVERTISER, page_id: "p1" }, headers: { "x-lead-region": "eu" } },
    },
    // download_leads is hand-written (lib/lead-download.mjs) and tested in write-guards.test.mjs.
    // As tools, writes first look their objects up under the advertiser: the canned `owned` body answers that.
    set_campaign_status: {
      args: { advertiser_id: ADVERTISER, campaign_ids: ["c1", "c2"], operation_status: "DISABLE" },
      request: { method: "POST", url: `${API}/campaign/status/update/`, query: "absent", json: { advertiser_id: ADVERTISER, campaign_ids: ["c1", "c2"], operation_status: "DISABLE" } },
      response: owned,
    },
    set_ad_group_status: {
      args: { advertiser_id: ADVERTISER, adgroup_ids: ["g1"], operation_status: "DISABLE" },
      request: { method: "POST", url: `${API}/adgroup/status/update/`, query: "absent", json: { advertiser_id: ADVERTISER, adgroup_ids: ["g1"], operation_status: "DISABLE" } },
      response: owned,
    },
    set_ad_status: {
      args: { advertiser_id: ADVERTISER, ad_ids: ["a1"], operation_status: "DISABLE" },
      request: { method: "POST", url: `${API}/ad/status/update/`, query: "absent", json: { advertiser_id: ADVERTISER, ad_ids: ["a1"], operation_status: "DISABLE" } },
      response: owned,
    },
    set_campaign_budget: {
      // 50.5 = USD 50.50 on a USD account (TikTok budgets are in currency units, not cents).
      args: { advertiser_id: ADVERTISER, campaign_id: "c1", budget: 50.5 },
      request: { method: "POST", url: `${API}/campaign/update/`, query: "absent", json: { advertiser_id: ADVERTISER, campaign_id: "c1", budget: 50.5 } },
      response: owned,
    },
    set_ad_group_budgets: {
      args: { advertiser_id: ADVERTISER, scheduled_budget: [{ adgroup_id: "g1", scheduled_budget: 25 }] },
      request: { method: "POST", url: `${API}/adgroup/budget/update/`, query: "absent", json: { advertiser_id: ADVERTISER, scheduled_budget: [{ adgroup_id: "g1", scheduled_budget: 25 }] } },
      response: owned,
    },
    create_campaign: {
      args: { request_body: { advertiser_id: ADVERTISER, campaign_name: "Launch", objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_DAY", budget: 50 } },
      request: { method: "POST", url: `${API}/campaign/create/`, query: "absent", json: { advertiser_id: ADVERTISER, campaign_name: "Launch", objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_DAY", budget: 50 } },
    },
    create_ad_group: {
      args: { request_body: { advertiser_id: ADVERTISER, campaign_id: "c1", adgroup_name: "Group" } },
      request: { method: "POST", url: `${API}/adgroup/create/`, query: "absent", json: { advertiser_id: ADVERTISER, campaign_id: "c1", adgroup_name: "Group" } },
    },
    create_ad: {
      args: { request_body: { advertiser_id: ADVERTISER, adgroup_id: "g1", creatives: [] } },
      request: { method: "POST", url: `${API}/ad/create/`, query: "absent", json: { advertiser_id: ADVERTISER, adgroup_id: "g1", creatives: [] } },
    },
    delete_campaigns: {
      args: { advertiser_id: ADVERTISER, campaign_ids: ["c1"] },
      request: { method: "POST", url: `${API}/campaign/status/update/`, query: "absent", json: { advertiser_id: ADVERTISER, campaign_ids: ["c1"], operation_status: "DELETE" } },
    },
    delete_ad_groups: {
      args: { advertiser_id: ADVERTISER, adgroup_ids: ["g1"] },
      request: { method: "POST", url: `${API}/adgroup/status/update/`, query: "absent", json: { advertiser_id: ADVERTISER, adgroup_ids: ["g1"], operation_status: "DELETE" } },
    },
    delete_ads: {
      args: { advertiser_id: ADVERTISER, ad_ids: ["a1"] },
      request: { method: "POST", url: `${API}/ad/status/update/`, query: "absent", json: { advertiser_id: ADVERTISER, ad_ids: ["a1"], operation_status: "DELETE" } },
    },
  },
});
