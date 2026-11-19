import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const SENT = { body: { detail: "success! message in queue", id: ["80367170"], process: "pending", requestid: 2937124, status: true, target: ["6281234567890"] } };

describeRestPluginContract(pluginDefinition, {
  // The allowlist lets the generated opt-in test's tool send through (tools need both).
  environment: { FONNTE_TOOL_RECIPIENT_ALLOWLIST: "+6281234567890" },
  operations: {
    get_device: {
      args: {},
      request: { method: "POST", url: "https://api.fonnte.com/device", query: "absent", body: "absent" },
      response: { body: { device: "6281234567890", device_status: "connect", quota: "78", status: true } },
      expect: { data: { device: "6281234567890", device_status: "connect", quota: "78", status: true } },
    },
    validate_numbers: {
      args: { numbers: ["+62 812 3456 7890", "+6285700000000"] },
      request: { method: "POST", url: "https://api.fonnte.com/validate", query: "absent", multipart: { target: "6281234567890,6285700000000", countryCode: "0" } },
      response: { body: { registered: ["6281234567890"], not_registered: ["6285700000000"], status: true } },
    },
    list_whatsapp_groups: {
      args: {},
      request: { method: "POST", url: "https://api.fonnte.com/get-whatsapp-group", query: "absent", body: "absent" },
      response: { body: { data: [{ id: "120363000000000000@g.us", name: "Team" }], status: true } },
    },
    send_message: {
      args: { target: "+6281234567890", message: "Halo {name}", typing: true, connect_only: false },
      request: { method: "POST", url: "https://api.fonnte.com/send", query: "absent", multipart: { target: "6281234567890", message: "Halo {name}", typing: "true", connectOnly: "false", countryCode: "0" } },
      response: SENT,
      expect: { data: SENT.body },
    },
    send_group_message: {
      args: { group_id: "120363000000000000@g.us", message: "Rapat jam 3", file_url: "https://example.com/agenda.pdf", filename: "agenda.pdf" },
      request: { method: "POST", url: "https://api.fonnte.com/send", query: "absent", multipart: { target: "120363000000000000@g.us", message: "Rapat jam 3", url: "https://example.com/agenda.pdf", filename: "agenda.pdf", countryCode: "0" } },
      response: SENT,
    },
    delete_message: {
      args: { message_id: "80367170" },
      request: { method: "POST", url: "https://api.fonnte.com/delete-message", query: "absent", multipart: { id: "80367170" } },
      response: { body: { detail: "message 80367170 successfully deleted", status: true } },
    },
    fetch_whatsapp_groups: {
      args: {},
      request: { method: "POST", url: "https://api.fonnte.com/fetch-group", query: "absent", body: "absent" },
      response: { body: { detail: "update whatsapp group list finished", status: true } },
    },
    disconnect_device: {
      args: {},
      request: { method: "POST", url: "https://api.fonnte.com/disconnect", query: "absent", body: "absent" },
      response: { body: { detail: "device disconnected", status: true } },
    },
  },
});
