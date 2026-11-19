import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition, wrapBrevoDefinition } from "../definition.mjs";

// The generated suite calls api_request as a tool with an arbitrary path, which the tool path allowlist refuses
// (tested in brevo.test.mjs), so the contract runs without that one guard.
const pluginDefinition = wrapBrevoDefinition(restDefinition, { guardApiRequestPaths: false });

const API = "https://api.brevo.com/v3";

describeRestPluginContract(pluginDefinition, {
  operations: {
    get_account: { args: {}, request: { method: "GET", url: `${API}/account`, query: "absent" }, response: { body: { email: "shop@example.com", plan: [] } } },
    list_contacts: {
      args: { list_ids: [2, 7], modified_since: "2026-01-01T00:00:00.000Z", limit: 100, sort: "asc" },
      request: { method: "GET", url: `${API}/contacts`, query: { modifiedSince: "2026-01-01T00:00:00.000Z", listIds: "2,7", sort: "asc", limit: "100" } },
      response: { body: { contacts: [{ id: 1 }], count: 1 } },
      expect: { data: [{ id: 1 }] },
    },
    get_contact: {
      args: { identifier: "ada@example.com", identifier_type: "email_id", start_date: "2026-01-01", end_date: "2026-01-31" },
      request: { method: "GET", url: `${API}/contacts/ada%40example.com`, query: { identifierType: "email_id", startDate: "2026-01-01", endDate: "2026-01-31" } },
    },
    create_contact: {
      args: { email: "ada@example.com", attributes: { FIRSTNAME: "Ada" }, list_ids: [2], update_enabled: true },
      request: { method: "POST", url: `${API}/contacts`, query: "absent", json: { email: "ada@example.com", attributes: { FIRSTNAME: "Ada" }, listIds: [2], updateEnabled: true } },
      response: { status: 201, body: { id: 21 } },
    },
    update_contact: {
      args: { identifier: "21", identifier_type: "contact_id", attributes: { LASTNAME: "Lovelace" }, unlink_list_ids: [7] },
      request: { method: "PUT", url: `${API}/contacts/21`, query: { identifierType: "contact_id" }, json: { attributes: { LASTNAME: "Lovelace" }, unlinkListIds: [7] } },
      response: { status: 204, body: "" },
    },
    delete_contact: { args: { identifier: "ada@example.com" }, request: { method: "DELETE", url: `${API}/contacts/ada%40example.com`, query: "absent", body: "absent" }, response: { status: 204, body: "" } },
    list_lists: { args: {}, request: { method: "GET", url: `${API}/contacts/lists`, query: { limit: "10" } }, response: { body: { lists: [{ id: 2 }], count: 1 } }, expect: { data: [{ id: 2 }] } },
    get_list: { args: { list_id: 2 }, request: { method: "GET", url: `${API}/contacts/lists/2`, query: "absent" } },
    list_list_contacts: { args: { list_id: 2, limit: 500 }, request: { method: "GET", url: `${API}/contacts/lists/2/contacts`, query: { limit: "500" } }, response: { body: { contacts: [], count: 0 } } },
    add_contacts_to_list: {
      args: { list_id: 2, emails: ["ada@example.com"] },
      request: { method: "POST", url: `${API}/contacts/lists/2/contacts/add`, query: "absent", json: { emails: ["ada@example.com"] } },
      response: { status: 201, body: { contacts: { success: ["ada@example.com"], failure: [] } } },
    },
    send_transactional_email: {
      args: {
        sender_email: "shop@example.com",
        sender_name: "Shop",
        to: [{ email: "ada@example.com", name: "Ada" }],
        template_id: 12,
        params: { ORDER: "A-12" },
        reply_to_email: "help@example.com",
        tags: ["order"],
      },
      request: {
        method: "POST",
        url: `${API}/smtp/email`,
        query: "absent",
        json: { sender: { email: "shop@example.com", name: "Shop" }, to: [{ email: "ada@example.com", name: "Ada" }], replyTo: { email: "help@example.com" }, templateId: 12, params: { ORDER: "A-12" }, tags: ["order"] },
      },
      response: { status: 201, body: { messageId: "<m1@smtp-relay.mailin.fr>" } },
    },
    list_email_templates: { args: { template_status: true }, request: { method: "GET", url: `${API}/smtp/templates`, query: { templateStatus: "true", limit: "50" } }, response: { body: { templates: [], count: 0 } } },
    list_email_events: {
      args: { email: "ada@example.com", event: "delivered", days: 7 },
      request: { method: "GET", url: `${API}/smtp/statistics/events`, query: { email: "ada@example.com", event: "delivered", days: "7", limit: "50" } },
      response: { body: { events: [{ event: "delivered" }] } },
    },
    list_email_campaigns: {
      args: { campaign_type: "classic", status: "sent", statistics: "globalStats" },
      request: { method: "GET", url: `${API}/emailCampaigns`, query: { type: "classic", status: "sent", statistics: "globalStats", excludeHtmlContent: "true", limit: "50" } },
      response: { body: { campaigns: [{ id: 5 }], count: 1 } },
    },
    get_email_campaign: { args: { campaign_id: 5, statistics: "statsByDevice" }, request: { method: "GET", url: `${API}/emailCampaigns/5`, query: { statistics: "statsByDevice" } } },
    send_campaign_now: { args: { campaign_id: 5 }, request: { method: "POST", url: `${API}/emailCampaigns/5/sendNow`, query: "absent", body: "absent" }, response: { status: 204, body: "" } },
    list_webhooks: { args: { webhook_type: "transactional" }, request: { method: "GET", url: `${API}/webhooks`, query: { type: "transactional" } } },
    get_webhook: { args: { webhook_id: 3 }, request: { method: "GET", url: `${API}/webhooks/3`, query: "absent" } },
  },
});
