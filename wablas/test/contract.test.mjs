import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const BASE_URL = "https://pati.wablas.com";
const QUEUED = { body: { status: true, message: "Message is pending and waiting to be processed", data: { device_id: "A5DOYJ", quota: 88, messages: [{ id: "m1", phone: "6281234567890", status: "pending" }] } } };

describeRestPluginContract(pluginDefinition, {
  // The allowlist lets the generated opt-in tests' tool sends through (tools need both).
  environment: { WABLAS_DOMAIN: "pati.wablas.com", WABLAS_SECRET_KEY: "contract-secret-key", WABLAS_TOOL_RECIPIENT_ALLOWLIST: "+6281234567890" },
  checkAuth: (call, credential) => assert.equal(call.headers.authorization, `${credential}.contract-secret-key`),
  operations: {
    list_message_reports: {
      args: { phone: "6281234567890", status: "sent", limit: 10, cursor: "2" },
      request: { method: "GET", url: `${BASE_URL}/api/report/message`, query: { phone: "6281234567890", status: "sent", page: "2", perPage: "10" } },
      response: { body: { status: true, totalData: 1, perPage: 10, page: 2, totalPage: 2, message: [{ id: "m1" }] } },
      expect: { data: [{ id: "m1" }] },
    },
    send_message: {
      args: { phone: "+62 812 3456 7890", message: "Halo", ref_id: "order-1" },
      request: { method: "POST", url: `${BASE_URL}/api/v2/send-message`, query: "absent", json: { data: [{ phone: "6281234567890", message: "Halo", ref_id: "order-1" }] } },
      response: QUEUED,
      expect: { data: QUEUED.body },
    },
    send_image: {
      args: { phone: "+6281234567890", image: "https://example.com/a.png", caption: "Struk" },
      request: { method: "POST", url: `${BASE_URL}/api/v2/send-image`, query: "absent", json: { data: [{ phone: "6281234567890", image: "https://example.com/a.png", caption: "Struk" }] } },
      response: QUEUED,
    },
    send_document: {
      args: { phone: "+6281234567890", document: "https://example.com/invoice.pdf" },
      request: { method: "POST", url: `${BASE_URL}/api/v2/send-document`, query: "absent", json: { data: [{ phone: "6281234567890", document: "https://example.com/invoice.pdf" }] } },
      response: QUEUED,
    },
    send_video: {
      args: { phone: "+6281234567890", video: "https://example.com/demo.mp4", caption: "Demo" },
      request: { method: "POST", url: `${BASE_URL}/api/v2/send-video`, query: "absent", json: { data: [{ phone: "6281234567890", video: "https://example.com/demo.mp4", caption: "Demo" }] } },
      response: QUEUED,
    },
    cancel_message: {
      args: { message_id: "m1" },
      request: { method: "GET", url: `${BASE_URL}/api/cancel-message`, query: { id: "m1" } },
      response: { body: { status: true, message: "cancelled" } },
    },
    resend_message: {
      args: { message_id: "m1" },
      request: { method: "GET", url: `${BASE_URL}/api/resend-message`, query: { id: "m1" } },
      response: { body: { status: true, message: "resent" } },
    },
  },
});
