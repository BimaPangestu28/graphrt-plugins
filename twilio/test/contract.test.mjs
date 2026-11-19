import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const ACCOUNT_SID = `AC${"0".repeat(31)}1`;
const ACCOUNT_URL = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}`;

describeRestPluginContract(pluginDefinition, {
  // The allowlist lets the generated opt-in test's tool send through (tools need both).
  environment: { TWILIO_ACCOUNT_SID: ACCOUNT_SID, TWILIO_TOOL_RECIPIENT_ALLOWLIST: "+6281234567890" },
  operations: {
    lookup_phone_number: {
      args: { phone_number: "+6281234567890" },
      request: { method: "GET", url: "https://lookups.twilio.com/v2/PhoneNumbers/%2B6281234567890", query: "absent" },
      response: { body: { phone_number: "+6281234567890", valid: true } },
      expect: { data: { phone_number: "+6281234567890", valid: true } },
    },
    lookup_phone_number_data: {
      args: { phone_number: "0812 3456 7890", fields: ["line_type_intelligence", "sms_pumping_risk"], country_code: "ID" },
      request: { method: "GET", url: "https://lookups.twilio.com/v2/PhoneNumbers/0812%203456%207890", query: { Fields: "line_type_intelligence,sms_pumping_risk", CountryCode: "ID" } },
    },
    get_balance: {
      args: {},
      request: { method: "GET", url: `${ACCOUNT_URL}/Balance.json`, query: "absent" },
      response: { body: { currency: "USD", balance: "12.50", account_sid: ACCOUNT_SID } },
      expect: { data: { currency: "USD", balance: "12.50", account_sid: ACCOUNT_SID } },
    },
    send_sms: {
      args: { to: "+62 812-3456-7890", from: "+15005550006", body: "Hello", media_urls: ["https://example.com/a.png", "https://example.com/b.png"] },
      request: { method: "POST", url: `${ACCOUNT_URL}/Messages.json`, query: "absent", form: { To: "+6281234567890", Body: "Hello", MediaUrl: ["https://example.com/a.png", "https://example.com/b.png"], From: "+15005550006" } },
      response: { status: 201, body: { sid: "SM1", status: "queued" } },
      expect: { data: { sid: "SM1", status: "queued" } },
    },
    send_whatsapp: {
      args: { to: "+6281234567890", from: "+14155238886", content_sid: "HX1", content_variables: '{"1":"Ada"}' },
      request: { method: "POST", url: `${ACCOUNT_URL}/Messages.json`, query: "absent", form: { To: "whatsapp:+6281234567890", ContentSid: "HX1", ContentVariables: '{"1":"Ada"}', From: "whatsapp:+14155238886" } },
    },
    list_messages: {
      args: { to: "+6281234567890", date_sent_after: "2026-11-01", page_size: 2, cursor: "1:PAabc" },
      request: { method: "GET", url: `${ACCOUNT_URL}/Messages.json`, query: { To: "+6281234567890", "DateSent>": "2026-11-01", PageSize: "2", Page: "1", PageToken: "PAabc" } },
      response: { body: { messages: [{ sid: "SM1" }], next_page_uri: `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json?PageSize=2&Page=2&PageToken=PAdef` } },
      expect: { data: [{ sid: "SM1" }] },
    },
    get_message: {
      args: { message_sid: "SM1" },
      request: { method: "GET", url: `${ACCOUNT_URL}/Messages/SM1.json`, query: "absent" },
    },
    delete_message: {
      args: { message_sid: "SM1" },
      request: { method: "DELETE", url: `${ACCOUNT_URL}/Messages/SM1.json`, query: "absent", body: "absent" },
      response: { status: 204 },
    },
    list_calls: {
      args: { status: "completed", start_time_before: "2026-11-02" },
      request: { method: "GET", url: `${ACCOUNT_URL}/Calls.json`, query: { Status: "completed", "StartTime<": "2026-11-02", PageSize: "50" } },
      response: { body: { calls: [{ sid: "CA1" }], next_page_uri: null } },
      expect: { data: [{ sid: "CA1" }] },
    },
    get_call: {
      args: { call_sid: "CA1" },
      request: { method: "GET", url: `${ACCOUNT_URL}/Calls/CA1.json`, query: "absent" },
    },
    create_call: {
      args: { to: "+1 555 010 0000", from: "+15005550006", twiml: "<Response><Say>Hi</Say></Response>", ring_timeout_seconds: 20 },
      request: { method: "POST", url: `${ACCOUNT_URL}/Calls.json`, query: "absent", form: { To: "+15550100000", From: "+15005550006", Twiml: "<Response><Say>Hi</Say></Response>", Timeout: "20" } },
    },
  },
});
