import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition, wrapMailchimpDefinition } from "../definition.mjs";

// The generated suite calls api_request as a tool with an arbitrary path, which the tool path allowlist refuses
// (tested in mailchimp.test.mjs), so the contract runs without that one guard.
const pluginDefinition = wrapMailchimpDefinition(restDefinition, { guardApiRequestPaths: false });

const API = "https://us21.api.mailchimp.com/3.0";
const HASH = "3e3417d7ef77d5932a6734b916515ed5";
const MEMBER = `${API}/lists/l1/members/${HASH}`;

describeRestPluginContract(pluginDefinition, {
  environment: { MAILCHIMP_API_KEY: "contract-test-credential-0001-us21" },
  operations: {
    ping: { args: {}, request: { method: "GET", url: `${API}/ping`, query: "absent" }, response: { body: { health_status: "Everything's Chimpy!" } } },
    list_audiences: {
      args: { email: "ada@example.com", fields: ["lists.id", "lists.name"], limit: 20, sort_dir: "DESC" },
      request: { method: "GET", url: `${API}/lists`, query: { email: "ada@example.com", fields: "lists.id,lists.name", sort_dir: "DESC", count: "20" } },
      response: { body: { lists: [{ id: "l1" }], total_items: 1 } },
      expect: { data: [{ id: "l1" }] },
    },
    get_audience: { args: { list_id: "l1" }, request: { method: "GET", url: `${API}/lists/l1`, query: "absent" } },
    list_members: {
      args: { list_id: "l1", status: "subscribed", since_last_changed: "2026-01-01T00:00:00+00:00" },
      request: { method: "GET", url: `${API}/lists/l1/members`, query: { status: "subscribed", since_last_changed: "2026-01-01T00:00:00+00:00", count: "50" } },
      response: { body: { members: [{ id: HASH }], total_items: 1 } },
      expect: { data: [{ id: HASH }] },
    },
    get_member: { args: { list_id: "l1", subscriber_hash: HASH }, request: { method: "GET", url: MEMBER, query: "absent" } },
    search_members: { args: { query: "ada@example.com", list_id: "l1" }, request: { method: "GET", url: `${API}/search-members`, query: { query: "ada@example.com", list_id: "l1" } } },
    upsert_member: {
      args: { list_id: "l1", subscriber_hash: HASH, status_if_new: "pending", merge_fields: { FNAME: "Ada" }, tags: ["lead"] },
      request: { method: "PUT", url: MEMBER, query: "absent", json: { status_if_new: "pending", merge_fields: { FNAME: "Ada" }, tags: ["lead"] } },
    },
    list_member_tags: { args: { list_id: "l1", subscriber_hash: HASH }, request: { method: "GET", url: `${MEMBER}/tags`, query: { count: "50" } }, response: { body: { tags: [], total_items: 0 } } },
    update_member_tags: {
      args: { list_id: "l1", subscriber_hash: HASH, tags: [{ name: "vip", status: "active" }], is_syncing: true },
      request: { method: "POST", url: `${MEMBER}/tags`, query: "absent", json: { tags: [{ name: "vip", status: "active" }], is_syncing: true } },
      response: { status: 204, body: "" },
    },
    archive_member: { args: { list_id: "l1", subscriber_hash: HASH }, request: { method: "DELETE", url: MEMBER, query: "absent", body: "absent" }, response: { status: 204, body: "" } },
    delete_member_permanently: {
      args: { list_id: "l1", subscriber_hash: HASH },
      request: { method: "POST", url: `${MEMBER}/actions/delete-permanent`, query: "absent", body: "absent" },
      response: { status: 204, body: "" },
    },
    list_campaigns: {
      args: { campaign_type: "regular", status: "sent", list_id: "l1", sort_field: "send_time", limit: 5 },
      request: { method: "GET", url: `${API}/campaigns`, query: { type: "regular", status: "sent", list_id: "l1", sort_field: "send_time", count: "5" } },
      response: { body: { campaigns: [{ id: "c1" }], total_items: 1 } },
    },
    get_campaign: { args: { campaign_id: "c1" }, request: { method: "GET", url: `${API}/campaigns/c1`, query: "absent" } },
    get_campaign_content: { args: { campaign_id: "c1", fields: ["plain_text"] }, request: { method: "GET", url: `${API}/campaigns/c1/content`, query: { fields: "plain_text" } } },
    send_campaign: { args: { campaign_id: "c1" }, request: { method: "POST", url: `${API}/campaigns/c1/actions/send`, query: "absent", body: "absent" }, response: { status: 204, body: "" } },
    schedule_campaign: {
      args: { campaign_id: "c1", schedule_time: "2026-12-01T09:30:00Z", batch_count: 2, batch_delay: 15 },
      request: { method: "POST", url: `${API}/campaigns/c1/actions/schedule`, query: "absent", json: { schedule_time: "2026-12-01T09:30:00Z", batch_delivery: { batch_count: 2, batch_delay: 15 } } },
      response: { status: 204, body: "" },
    },
    unschedule_campaign: { args: { campaign_id: "c1" }, request: { method: "POST", url: `${API}/campaigns/c1/actions/unschedule`, query: "absent", body: "absent" }, response: { status: 204, body: "" } },
    list_reports: {
      args: { campaign_type: "regular", since_send_time: "2026-01-01T00:00:00+00:00" },
      request: { method: "GET", url: `${API}/reports`, query: { type: "regular", since_send_time: "2026-01-01T00:00:00+00:00", count: "50" } },
      response: { body: { reports: [{ id: "c1" }], total_items: 1 } },
    },
    get_report: { args: { campaign_id: "c1" }, request: { method: "GET", url: `${API}/reports/c1`, query: "absent" } },
    list_audience_webhooks: { args: { list_id: "l1" }, request: { method: "GET", url: `${API}/lists/l1/webhooks`, query: "absent" } },
    get_audience_webhook: { args: { list_id: "l1", webhook_id: "w1" }, request: { method: "GET", url: `${API}/lists/l1/webhooks/w1`, query: "absent" } },
    list_batch_webhooks: { args: {}, request: { method: "GET", url: `${API}/batch-webhooks`, query: { count: "50" } }, response: { body: { webhooks: [], total_items: 0 } } },
  },
});
