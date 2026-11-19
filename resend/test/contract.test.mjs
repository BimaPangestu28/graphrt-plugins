import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition, wrapResendDefinition } from "../definition.mjs";

const API = "https://api.resend.com";
// The generated suite calls api_request as a tool with "/anything", which the tool path allowlist refuses
// (tested in resend.test.mjs), so the contract runs with every other wrapper applied.
const contractDefinition = wrapResendDefinition(restDefinition, { guardApiRequestPaths: false });

describeRestPluginContract(contractDefinition, {
  operations: {
    send_email: {
      args: { from: "Acme <news@example.com>", to: ["ada@example.com"], subject: "Hi", html: "<p>Hello</p>", scheduled_at: "in 1 hour", tags: [{ name: "category", value: "welcome" }] },
      request: {
        method: "POST",
        url: `${API}/emails`,
        query: "absent",
        json: { from: "Acme <news@example.com>", to: ["ada@example.com"], subject: "Hi", html: "<p>Hello</p>", scheduled_at: "in 1 hour", tags: [{ name: "category", value: "welcome" }] },
      },
      response: { body: { id: "e1" } },
      expect: { data: { id: "e1" } },
    },
    send_batch_emails: {
      args: { emails: [{ from: "news@example.com", to: ["a@example.com"], subject: "A", text: "x" }, { from: "news@example.com", to: ["b@example.com"], subject: "B", text: "y" }] },
      request: {
        method: "POST",
        url: `${API}/emails/batch`,
        query: "absent",
        json: [{ from: "news@example.com", to: ["a@example.com"], subject: "A", text: "x" }, { from: "news@example.com", to: ["b@example.com"], subject: "B", text: "y" }],
      },
      response: { body: { data: [{ id: "e1" }, { id: "e2" }] } },
    },
    get_email: { args: { email_id: "e1" }, request: { method: "GET", url: `${API}/emails/e1`, query: "absent" }, response: { body: { object: "email", id: "e1", last_event: "delivered" } } },
    list_emails: {
      args: { limit: 10, cursor: "e9" },
      request: { method: "GET", url: `${API}/emails`, query: { limit: "10", after: "e9" } },
      response: { body: { object: "list", has_more: true, data: [{ id: "e8" }, { id: "e7" }] } },
      expect: { data: [{ id: "e8" }, { id: "e7" }] },
    },
    reschedule_email: { args: { email_id: "e1", scheduled_at: "2026-12-01T09:00:00Z" }, request: { method: "PATCH", url: `${API}/emails/e1`, query: "absent", json: { scheduled_at: "2026-12-01T09:00:00Z" } } },
    cancel_email: { args: { email_id: "e1" }, request: { method: "POST", url: `${API}/emails/e1/cancel`, query: "absent", body: "absent" } },
    list_domains: {
      args: {},
      request: { method: "GET", url: `${API}/domains`, query: { limit: "20" } },
      response: { body: { object: "list", has_more: false, data: [{ id: "d1", name: "example.com", status: "verified" }] } },
      expect: { data: [{ id: "d1", name: "example.com", status: "verified" }] },
    },
    get_domain: { args: { domain_id: "d1" }, request: { method: "GET", url: `${API}/domains/d1`, query: "absent" }, response: { body: { id: "d1", records: [{ record: "SPF", type: "MX" }] } } },
  },
});
