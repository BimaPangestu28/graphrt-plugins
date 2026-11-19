import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { restDefinition, wrapQontakDefinition } from "../definition.mjs";

// The generated suite calls api_request as a tool with an arbitrary path, which the tool path allowlist refuses
// (tested in qontak.test.mjs), so the contract runs without that one guard.
const pluginDefinition = wrapQontakDefinition(restDefinition, { guardApiRequestPaths: false });

const CHAT = "https://api.mekari.com/qontak/chat/v1";
const CRM = "https://api.mekari.com/qontak/crm";
const TEMPLATE_ID = "6c1b1b0e-0000-4000-8000-000000000001";
const INTEGRATION_ID = "a02979a6-a2fe-431a-ac91-8ceccdaf419b";
const ROOM_ID = "c1d8198a-9eb5-4952-9183-137670a2db9a";
const BROADCAST_ID = "98b463bc-a8f1-4f19-84df-ae62967ff795";

/**
 * Recomputes the Mekari HMAC signature of a recorded call (an independent re-implementation of the signing rule).
 *
 * @param call - Recorded fetch call (object)
 * @param clientSecret - Expected secret (string)
 */
function assertMekariSignature(call, clientSecret) {
  const parsedUrl = new URL(call.url);
  const signingText = `date: ${call.headers.date}\n${call.method} ${parsedUrl.pathname}${parsedUrl.search} HTTP/1.1`;
  const expected = createHmac("sha256", clientSecret).update(signingText).digest("base64");
  assert.equal(call.headers.authorization, `hmac username="fake-client-id", algorithm="hmac-sha256", headers="date request-line", signature="${expected}"`);
  assert.ok(Math.abs(Date.parse(call.headers.date) - Date.now()) < 60000, "Date header is current");
}

const CRM_SAMPLES = {
  contact: { create: { first_name: "Budi", last_name: "Santoso", email: "budi@example.co.id", telephone: "6281234567890" }, update: { job_title: "Owner" }, filters: [{ name: "Budi" }, { name: "Budi" }] },
  company: { create: { name: "Toko Maju", website: "tokomaju.example" }, update: { city: "Bandung" }, filters: [{ website: "tokomaju.example" }, { website: "tokomaju.example" }] },
  deal: { create: { name: "Paket A", crm_pipeline_id: 2, crm_stage_id: 1, currency: "IDR", size: 1500000 }, update: { crm_stage_id: 3 }, filters: [{ name: "Paket" }, { name: "Paket" }] },
  task: { create: { name: "Follow up", crm_person_id: 86, due_date: "2026-12-01T10:00:00.000+07:00" }, update: { detail: "Called" }, filters: [{ crm_task_status_id: 1 }, { crm_task_status_id: "1" }] },
  note: { create: { note: "Minta penawaran", note_type: "Crm::PersonNote", crm_person_id: 86 }, update: { note: "Sudah dikirim" }, filters: [{ crm_deal_id: 5 }, { crm_deal_id: "5" }] },
};
const PLURALS = { contact: "contacts", company: "companies", deal: "deals", task: "tasks", note: "notes" };
const toWire = (fields) => Object.fromEntries(Object.entries(fields).map(([fieldName, fieldValue]) => [fieldName === "note_type" ? "type" : fieldName, fieldValue]));

function crmCases() {
  const cases = {};
  for (const [singular, sample] of Object.entries(CRM_SAMPLES)) {
    const plural = PLURALS[singular];
    const [filterArgs, filterQuery] = sample.filters;
    const queryOf = (filters) => Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, String(value)]));
    cases[`list_${plural}`] = {
      args: { ...filterArgs, limit: 50, cursor: "2" },
      request: { method: "GET", url: `${CRM}/${plural}`, query: { ...queryOf(filterQuery), page: "2", per_page: "50" } },
      response: { body: { meta: { status: 200 }, response: [{ id: 1 }] } },
      expect: { data: [{ id: 1 }] },
    };
    cases[`get_${singular}`] = { args: { [`${singular}_id`]: 7 }, request: { method: "GET", url: `${CRM}/${plural}/7`, query: "absent" }, response: { body: { meta: { status: 200 }, response: { id: 7 } } }, expect: { data: { id: 7 } } };
    cases[`create_${singular}`] = { args: sample.create, request: { method: "POST", url: `${CRM}/${plural}`, query: "absent", json: toWire(sample.create) }, response: { status: 201, body: { response: { id: 8 } } } };
    cases[`update_${singular}`] = { args: { [`${singular}_id`]: 7, ...sample.update }, request: { method: "PUT", url: `${CRM}/${plural}/7`, query: "absent", json: toWire(sample.update) } };
    cases[`delete_${singular}`] = { args: { [`${singular}_id`]: 7 }, request: { method: "DELETE", url: `${CRM}/${plural}/7`, query: "absent", body: "absent" } };
  }
  return cases;
}

describeRestPluginContract(pluginDefinition, {
  environment: { QONTAK_CLIENT_ID: "fake-client-id", QONTAK_TOOL_RECIPIENT_ALLOWLIST: "+6281234567890" },
  checkAuth: assertMekariSignature,
  operations: {
    list_whatsapp_templates: {
      args: { status: "APPROVED", limit: 20, offset: 1 },
      request: { method: "GET", url: `${CHAT}/templates/whatsapp`, query: { status: "APPROVED", limit: "20", offset: "1" } },
      response: { body: { status: "success", data: [{ id: TEMPLATE_ID, name: "otp" }], meta: { pagination: { offset: 1, limit: 20 } } } },
      expect: { data: [{ id: TEMPLATE_ID, name: "otp" }] },
    },
    get_whatsapp_template: { args: { template_id: TEMPLATE_ID }, request: { method: "GET", url: `${CHAT}/templates/${TEMPLATE_ID}/whatsapp`, query: "absent" } },
    list_integrations: {
      args: { target_channel: "wa" },
      request: { method: "GET", url: `${CHAT}/integrations`, query: { target_channel: "wa" } },
      response: { body: { status: "success", data: [{ id: INTEGRATION_ID, target_channel: "wa" }] } },
      expect: { data: [{ id: INTEGRATION_ID, target_channel: "wa" }] },
    },
    list_rooms: { args: { query: "Budi", status: "resolved", limit: 10 }, request: { method: "GET", url: `${CHAT}/rooms`, query: { query: "Budi", status: "resolved", limit: "10" } } },
    get_room: { args: { room_id: ROOM_ID }, request: { method: "GET", url: `${CHAT}/rooms/${ROOM_ID}`, query: "absent" } },
    list_room_histories: { args: { room_id: ROOM_ID }, request: { method: "GET", url: `${CHAT}/rooms/${ROOM_ID}/histories`, query: "absent" } },
    send_whatsapp_template: {
      args: { to_number: "+62 812-3456-7890", to_name: "Budi", message_template_id: TEMPLATE_ID, channel_integration_id: INTEGRATION_ID, parameters: { body: [{ key: "1", value_text: "Budi", value: "name" }] } },
      request: {
        method: "POST",
        url: `${CHAT}/broadcasts/whatsapp/direct`,
        query: "absent",
        json: { to_number: "6281234567890", to_name: "Budi", message_template_id: TEMPLATE_ID, channel_integration_id: INTEGRATION_ID, language: { code: "id" }, parameters: { body: [{ key: "1", value_text: "Budi", value: "name" }] } },
      },
      response: { status: 201, body: { status: "success", data: { id: BROADCAST_ID } } },
      expect: { data: { id: BROADCAST_ID } },
    },
    list_whatsapp_broadcasts: { args: { start_date: "2026-11-01", limit: 5 }, request: { method: "GET", url: `${CHAT}/broadcasts/whatsapp`, query: { start_date: "2026-11-01", limit: "5" } } },
    get_whatsapp_broadcast: { args: { broadcast_id: BROADCAST_ID }, request: { method: "GET", url: `${CHAT}/broadcasts/${BROADCAST_ID}/whatsapp`, query: "absent" } },
    get_whatsapp_broadcast_log: { args: { broadcast_id: BROADCAST_ID }, request: { method: "GET", url: `${CHAT}/broadcasts/${BROADCAST_ID}/whatsapp/log`, query: "absent" } },
    ...crmCases(),
    list_pipelines: { args: {}, request: { method: "GET", url: `${CRM}/pipelines`, query: "absent" } },
    get_pipeline: { args: { pipeline_id: 2 }, request: { method: "GET", url: `${CRM}/pipelines/2`, query: "absent" } },
    list_pipeline_stages: { args: { pipeline_id: 2 }, request: { method: "GET", url: `${CRM}/pipelines/2/stages`, query: "absent" } },
  },
});
