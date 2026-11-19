import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { replaceOperation } from "../lib/recipient-policy.mjs";
import { wrapSendMail } from "../lib/sendgrid-mail.mjs";
import { restDefinition } from "../definition.mjs";

// The generated suite calls api_request as a tool with "/anything", which the tool path allowlist refuses
// (tested in sendgrid-mail.test.mjs), so the contract runs on the definition with only send_mail wrapped.
const contractDefinition = replaceOperation(restDefinition, "send_mail", wrapSendMail);

const API = "https://api.sendgrid.com/v3";
const suppressionCase = (path) => ({
  args: { start_time: 1767225600, email: "ada@", limit: 50, cursor: "100" },
  request: { method: "GET", url: `${API}${path}`, query: { start_time: "1767225600", email: "ada@", limit: "50", offset: "100" } },
  response: { body: [{ email: "ada@example.com", created: 1767225601 }] },
  expect: { data: [{ email: "ada@example.com", created: 1767225601 }] },
});

describeRestPluginContract(contractDefinition, {
  operations: {
    send_mail: {
      args: { from: "news@example.com", to: ["ada@example.com"], subject: "Hi", text: "Hello", template_id: "d-1", dynamic_template_data: { name: "Ada" } },
      request: {
        method: "POST",
        url: `${API}/mail/send`,
        query: "absent",
        json: {
          personalizations: [{ to: [{ email: "ada@example.com" }], dynamic_template_data: { name: "Ada" } }],
          from: { email: "news@example.com" },
          subject: "Hi",
          content: [{ type: "text/plain", value: "Hello" }],
          template_id: "d-1",
        },
      },
      response: { status: 202, body: "" },
    },
    send_mail_raw: {
      args: { message: { personalizations: [{ to: [{ email: "a@example.com" }] }, { to: [{ email: "b@example.com" }] }], from: { email: "news@example.com" }, subject: "Hi", content: [{ type: "text/plain", value: "x" }] } },
      request: {
        method: "POST",
        url: `${API}/mail/send`,
        query: "absent",
        json: { personalizations: [{ to: [{ email: "a@example.com" }] }, { to: [{ email: "b@example.com" }] }], from: { email: "news@example.com" }, subject: "Hi", content: [{ type: "text/plain", value: "x" }] },
      },
      response: { status: 202, body: "" },
    },
    list_templates: {
      args: { limit: 10 },
      request: { method: "GET", url: `${API}/templates`, query: { generations: "dynamic", page_size: "10" } },
      response: { body: { result: [{ id: "d-1", name: "Welcome" }], _metadata: { self: `${API}/templates?page_size=10`, count: 1 } } },
      expect: { data: [{ id: "d-1", name: "Welcome" }] },
    },
    get_template: { args: { template_id: "d-1" }, request: { method: "GET", url: `${API}/templates/d-1`, query: "absent" } },
    get_global_stats: {
      args: { start_date: "2026-11-01", aggregated_by: "week" },
      request: { method: "GET", url: `${API}/stats`, query: { start_date: "2026-11-01", aggregated_by: "week" } },
      response: { body: [{ date: "2026-11-01", stats: [{ metrics: { delivered: 3 } }] }] },
    },
    list_bounces: suppressionCase("/suppression/bounces"),
    list_blocks: suppressionCase("/suppression/blocks"),
    list_spam_reports: suppressionCase("/suppression/spam_reports"),
    list_invalid_emails: suppressionCase("/suppression/invalid_emails"),
    list_global_unsubscribes: suppressionCase("/suppression/unsubscribes"),
    list_unsubscribe_groups: { args: {}, request: { method: "GET", url: `${API}/asm/groups`, query: "absent" }, response: { body: [{ id: 42, name: "Newsletter" }] } },
  },
});
