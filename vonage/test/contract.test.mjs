import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const MESSAGES_URL = "https://api.nexmo.com/v1/messages";
const ACCEPTED = { status: 202, body: { message_uuid: "aaaaaaaa-bbbb-cccc-dddd-0123456789ab" } };

describeRestPluginContract(pluginDefinition, {
  // The allowlist lets the generated opt-in tests' tool sends through (tools need both).
  environment: { VONAGE_TOOL_RECIPIENT_ALLOWLIST: "+6281234567890" },
  operations: {
    number_insight: {
      args: { level: "standard", number: "+6281234567890", country: "ID" },
      request: { method: "GET", url: "https://api.nexmo.com/ni/standard/json", query: { number: "+6281234567890", country: "ID" } },
      response: { body: { status: 0, status_message: "Success", international_format_number: "6281234567890" } },
      expect: { data: { status: 0, status_message: "Success", international_format_number: "6281234567890" } },
    },
    get_balance: {
      args: {},
      request: { method: "GET", url: "https://rest.nexmo.com/account/get-balance", query: "absent" },
      response: { body: { value: 10.28, autoReload: false } },
      expect: { data: { value: 10.28, autoReload: false } },
    },
    send_sms: {
      args: { to: "+62 812 3456 7890", from: "AcmeShop", text: "Hello", client_ref: "order-1", encoding_type: "unicode" },
      request: { method: "POST", url: MESSAGES_URL, query: "absent", json: { to: "6281234567890", from: "AcmeShop", text: "Hello", sms: { encoding_type: "unicode" }, client_ref: "order-1", channel: "sms", message_type: "text" } },
      response: ACCEPTED,
      expect: { data: ACCEPTED.body },
    },
    send_whatsapp_text: {
      args: { to: "+6281234567890", from: "+14157386102", text: "Hi" },
      request: { method: "POST", url: MESSAGES_URL, query: "absent", json: { to: "6281234567890", from: "14157386102", text: "Hi", channel: "whatsapp", message_type: "text" } },
      response: ACCEPTED,
    },
    send_whatsapp_image: {
      args: { to: "+6281234567890", from: "+14157386102", image_url: "https://example.com/a.png", caption: "Receipt" },
      request: { method: "POST", url: MESSAGES_URL, query: "absent", json: { to: "6281234567890", from: "14157386102", image: { url: "https://example.com/a.png", caption: "Receipt" }, channel: "whatsapp", message_type: "image" } },
      response: ACCEPTED,
    },
    send_whatsapp_template: {
      args: { to: "+6281234567890", from: "+14157386102", template_name: "ns:order_update", template_parameters: ["Ada", "A-1"], locale: "id" },
      request: {
        method: "POST",
        url: MESSAGES_URL,
        query: "absent",
        json: { to: "6281234567890", from: "14157386102", template: { name: "ns:order_update", parameters: ["Ada", "A-1"] }, whatsapp: { locale: "id", policy: "deterministic" }, channel: "whatsapp", message_type: "template" },
      },
      response: ACCEPTED,
    },
    send_whatsapp_custom: {
      args: { to: "+6281234567890", from: "+14157386102", custom: { type: "template", template: { name: "promo", language: { policy: "deterministic", code: "en" } } } },
      request: {
        method: "POST",
        url: MESSAGES_URL,
        query: "absent",
        json: { to: "6281234567890", from: "14157386102", custom: { type: "template", template: { name: "promo", language: { policy: "deterministic", code: "en" } } }, channel: "whatsapp", message_type: "custom" },
      },
      response: ACCEPTED,
    },
  },
});
