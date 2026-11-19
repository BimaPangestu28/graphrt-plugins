import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://graph.facebook.com/v27.0";
const CAMPAIGN_FIELDS = "id,name,objective,status,effective_status,daily_budget,lifetime_budget,budget_remaining,bid_strategy,start_time,stop_time,created_time,updated_time";
const AD_SET_FIELDS = "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,budget_remaining,billing_event,optimization_goal,bid_amount,start_time,end_time,targeting";
const AD_FIELDS = "id,name,adset_id,campaign_id,status,effective_status,creative{id,name},created_time,updated_time";
const INSIGHT_FIELDS = "campaign_name,adset_name,ad_name,impressions,reach,clicks,ctr,cpc,cpm,spend,actions";
const ACCOUNT_FIELDS = "id,account_id,name,account_status,currency,timezone_name,amount_spent,spend_cap,balance,business";

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls opt-in operations as tools (set_budget needs the cap) and api_request on "/anything".
  environment: { META_ADS_TOOL_MAX_DAILY_BUDGET: "100000", META_ADS_TOOL_ACCOUNT_IDS: "1", META_ADS_TOOL_API_EXTRA_PATHS: "/anything" },
  operations: {
    list_ad_accounts: {
      args: { limit: 25 },
      request: { method: "GET", url: `${API}/me/adaccounts`, query: { fields: "id,account_id,name,account_status,currency,timezone_name,amount_spent,business", limit: "25" } },
      response: { body: { data: [{ id: "act_1" }], paging: { cursors: { after: "QUFF" }, next: "https://graph.facebook.com/v27.0/me/adaccounts?after=QUFF" } } },
      expect: { data: [{ id: "act_1" }] },
    },
    get_ad_account: {
      args: { ad_account_id: "act_1" },
      request: { method: "GET", url: `${API}/act_1`, query: { fields: ACCOUNT_FIELDS } },
    },
    list_campaigns: {
      args: { ad_account_id: "act_1", effective_status: ["ACTIVE", "PAUSED"], filtering: [{ field: "name", operator: "CONTAIN", value: "promo" }], limit: 10 },
      request: {
        method: "GET",
        url: `${API}/act_1/campaigns`,
        query: { fields: CAMPAIGN_FIELDS, effective_status: '["ACTIVE","PAUSED"]', filtering: '[{"field":"name","operator":"CONTAIN","value":"promo"}]', limit: "10" },
      },
    },
    list_ad_sets: {
      args: { ad_account_id: "act_1", fields: "id,name" },
      request: { method: "GET", url: `${API}/act_1/adsets`, query: { fields: "id,name", limit: "50" } },
    },
    list_ads: {
      args: { ad_account_id: "act_1", effective_status: ["ACTIVE"] },
      request: { method: "GET", url: `${API}/act_1/ads`, query: { fields: AD_FIELDS, effective_status: '["ACTIVE"]', limit: "50" } },
    },
    list_ad_creatives: {
      args: { ad_account_id: "act_1" },
      request: { method: "GET", url: `${API}/act_1/adcreatives`, query: { fields: "id,name,title,body,object_story_spec,thumbnail_url,status", limit: "50" } },
    },
    get_campaign: { args: { campaign_id: "120200001" }, request: { method: "GET", url: `${API}/120200001`, query: { fields: CAMPAIGN_FIELDS } } },
    get_ad_set: { args: { ad_set_id: "120200002" }, request: { method: "GET", url: `${API}/120200002`, query: { fields: AD_SET_FIELDS } } },
    get_ad: { args: { ad_id: "120200003" }, request: { method: "GET", url: `${API}/120200003`, query: { fields: AD_FIELDS } } },
    get_insights: {
      args: { object_id: "act_1", date_preset: "last_7d", level: "campaign", breakdowns: ["age", "gender"], time_increment: "1", sort: ["spend_descending"], limit: 100 },
      request: {
        method: "GET",
        url: `${API}/act_1/insights`,
        query: { fields: INSIGHT_FIELDS, date_preset: "last_7d", level: "campaign", breakdowns: '["age","gender"]', time_increment: "1", sort: '["spend_descending"]', limit: "100" },
      },
      response: { body: { data: [{ campaign_name: "Promo", spend: "12.34" }], paging: { cursors: { after: "QUFF" } } } },
      expect: { data: [{ campaign_name: "Promo", spend: "12.34" }] },
    },
    run_insights_report: {
      args: { object_id: "act_1", level: "ad", time_range: { since: "2026-01-01", until: "2026-10-31" }, breakdowns: ["publisher_platform"] },
      request: {
        method: "POST",
        url: `${API}/act_1/insights`,
        query: "absent",
        json: { fields: INSIGHT_FIELDS, level: "ad", time_range: { since: "2026-01-01", until: "2026-10-31" }, breakdowns: ["publisher_platform"] },
      },
    },
    get_insights_report_rows: {
      args: { report_run_id: "6000001" },
      request: { method: "GET", url: `${API}/6000001/insights`, query: { limit: "50" } },
    },
    list_lead_forms: {
      args: { page_id: "1000001" },
      request: { method: "GET", url: `${API}/1000001/leadgen_forms`, query: { fields: "id,name,status,leads_count,created_time,locale", limit: "50" } },
    },
    list_leads: {
      args: { lead_source_id: "2000001", filtering: [{ field: "time_created", operator: "GREATER_THAN", value: 1761945743 }] },
      request: {
        method: "GET",
        url: `${API}/2000001/leads`,
        query: { fields: "id,created_time,ad_id,form_id,field_data", filtering: '[{"field":"time_created","operator":"GREATER_THAN","value":1761945743}]', limit: "50" },
      },
    },
    set_status: {
      // As a tool the object's account is read first (the canned body answers it); object_type is not sent.
      args: { object_id: "120200001", object_type: "campaign", status: "PAUSED" },
      request: { method: "POST", url: `${API}/120200001`, query: "absent", form: { status: "PAUSED" } },
      response: { body: { account_id: "1", success: true } },
    },
    set_budget: {
      // 2000 minor units = USD 20.00 for a USD account.
      args: { object_id: "120200001", object_type: "campaign", daily_budget: 2000 },
      request: { method: "POST", url: `${API}/120200001`, query: "absent", form: { daily_budget: "2000" } },
      response: { body: { account_id: "1", success: true } },
    },
    create_campaign: {
      args: { ad_account_id: "act_1", name: "Launch", objective: "OUTCOME_TRAFFIC", special_ad_categories: [], daily_budget: 5000 },
      request: { method: "POST", url: `${API}/act_1/campaigns`, query: "absent", json: { name: "Launch", objective: "OUTCOME_TRAFFIC", special_ad_categories: [], status: "PAUSED", daily_budget: 5000 } },
    },
    create_ad_set: {
      args: { ad_account_id: "act_1", name: "ID 18+", campaign_id: "120200001", billing_event: "IMPRESSIONS", optimization_goal: "LINK_CLICKS", targeting: { geo_locations: { countries: ["ID"] } }, execution_options: ["validate_only"] },
      request: {
        method: "POST",
        url: `${API}/act_1/adsets`,
        query: "absent",
        json: { name: "ID 18+", campaign_id: "120200001", status: "PAUSED", billing_event: "IMPRESSIONS", optimization_goal: "LINK_CLICKS", targeting: { geo_locations: { countries: ["ID"] } }, execution_options: ["validate_only"] },
      },
    },
    create_ad_creative: {
      args: { ad_account_id: "act_1", name: "Creative A", object_story_id: "1000001_3000001" },
      request: { method: "POST", url: `${API}/act_1/adcreatives`, query: "absent", json: { name: "Creative A", object_story_id: "1000001_3000001" } },
    },
    create_ad: {
      args: { ad_account_id: "act_1", name: "Ad A", adset_id: "120200002", creative: { creative_id: "120200004" } },
      request: { method: "POST", url: `${API}/act_1/ads`, query: "absent", json: { name: "Ad A", adset_id: "120200002", creative: { creative_id: "120200004" }, status: "PAUSED" } },
    },
    delete_object: {
      args: { object_id: "120200003" },
      request: { method: "DELETE", url: `${API}/120200003`, query: "absent", body: "absent" },
    },
  },
});
