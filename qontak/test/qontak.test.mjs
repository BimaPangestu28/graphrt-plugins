import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { buildRequestLine, signMekariRequest } from "../lib/mekari-hmac.mjs";
import { stripSecretFields } from "../lib/secret-fields.mjs";
import { pluginDefinition } from "../definition.mjs";

const HMAC_ENV = { QONTAK_CLIENT_ID: "fake-client-id", QONTAK_CLIENT_SECRET: "fake-secret" };
const BEARER_ENV = { QONTAK_CHAT_TOKEN: "fake-chat-token", QONTAK_CRM_TOKEN: "fake-crm-token" };
const SEND_ENV = { ...HMAC_ENV, QONTAK_TOOL_ALLOW_SEND: "1", QONTAK_TOOL_RECIPIENT_ALLOWLIST: "+6281234567890" };
const sendArgs = (toNumber) => ({ to_number: toNumber, to_name: "Budi", message_template_id: "t1", channel_integration_id: "i1" });

async function runQontak(operationName, args, { environment = HMAC_ENV, source = "tool", responses = [{ body: { status: "success", data: {} } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("Mekari HMAC: request line and signature match a fixed vector", () => {
  assert.equal(buildRequestLine("get", "https://api.mekari.com/qontak/crm/contacts?page=1"), "GET /qontak/crm/contacts?page=1 HTTP/1.1");
  const signed = signMekariRequest({ method: "GET", url: "https://api.mekari.com/qontak/crm/contacts?page=1", clientId: "fake-client-id", clientSecret: "fake-secret", date: new Date("2021-11-10T07:24:29Z") });
  assert.equal(signed.date, "Wed, 10 Nov 2021 07:24:29 GMT");
  assert.equal(signed.signature, "EUf/sZ6pyDf/GCHKBN4xXu9yirVfrSX8UvR9WA1sRDU=");
  assert.equal(signed.authorization, 'hmac username="fake-client-id", algorithm="hmac-sha256", headers="date request-line", signature="EUf/sZ6pyDf/GCHKBN4xXu9yirVfrSX8UvR9WA1sRDU="');
});

// Independent vectors: the signing strings are written out by hand and the expected values were computed with
//   printf '<signing string>' | openssl dgst -sha256 -hmac fake-secret -binary | base64
//   printf '<body>' | openssl dgst -sha256 -binary | base64
const OPENSSL_VECTORS = {
  getWithQuery: {
    signingString: "date: Wed, 10 Nov 2021 07:24:29 GMT\nGET /qontak/crm/contacts?page=2&per_page=25 HTTP/1.1",
    signature: "qYfk2rN7F+x31hvMpSv7JzTuX40yjn+JkUoGBiVjxjc=",
  },
  postWithQuery: {
    signingString: "date: Wed, 10 Nov 2021 07:24:29 GMT\nPOST /qontak/chat/v1/broadcasts/whatsapp/direct?source=graphrt HTTP/1.1",
    signature: "lmQ1NN4bMqu2J1iiZy0NyvcRCNtFFTWnKELOQ2khnwk=",
    body: '{"to_name":"Budi"}',
    digest: "SHA-256=OiC3RW0PcmP04h1uNG2TxfedyRO6IQfETEcFcGPR0Go=",
  },
};
const expectedAuthorization = (signature) => `hmac username="fake-client-id", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`;

test("Mekari HMAC matches openssl vectors: exact Authorization for GET with a query, and Digest for a POST body", () => {
  const date = new Date("2021-11-10T07:24:29Z");
  const getUrl = "https://api.mekari.com/qontak/crm/contacts?page=2&per_page=25";
  const getSigned = signMekariRequest({ method: "GET", url: getUrl, clientId: "fake-client-id", clientSecret: "fake-secret", date });
  assert.equal(`date: ${getSigned.date}\n${buildRequestLine("GET", getUrl)}`, OPENSSL_VECTORS.getWithQuery.signingString);
  assert.equal(getSigned.authorization, expectedAuthorization(OPENSSL_VECTORS.getWithQuery.signature));
  assert.equal(getSigned.digest, undefined, "no body, no Digest");
  const postUrl = "https://api.mekari.com/qontak/chat/v1/broadcasts/whatsapp/direct?source=graphrt";
  const postSigned = signMekariRequest({ method: "POST", url: postUrl, clientId: "fake-client-id", clientSecret: "fake-secret", date, body: OPENSSL_VECTORS.postWithQuery.body });
  assert.equal(postSigned.authorization, expectedAuthorization(OPENSSL_VECTORS.postWithQuery.signature));
  assert.equal(postSigned.digest, OPENSSL_VECTORS.postWithQuery.digest);
});

test("a signed send carries the exact Date, Authorization and Digest headers (openssl vector, fixed clock)", async (context) => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T03:00:00Z") });
  context.after(() => mock.timers.reset());
  const { error, calls } = await runQontak("send_whatsapp_template", sendArgs("+6281234567890"), { source: "node" });
  if (error) throw error;
  assert.equal(calls[0].body, '{"to_number":"6281234567890","to_name":"Budi","message_template_id":"t1","channel_integration_id":"i1","language":{"code":"id"}}');
  assert.equal(calls[0].headers.date, "Thu, 19 Nov 2026 03:00:00 GMT");
  assert.equal(calls[0].headers.authorization, expectedAuthorization("VIgSbP27oBC1CxC1kX0hx4+sW5LedDjDklGtFbSy+mY="));
  assert.equal(calls[0].headers.digest, "SHA-256=pkLkkgkbNlwZaQWmMa3JDDa0/8zTp628Dnv/XIaHCgk=");
});

test("GET requests carry no Digest header", async () => {
  const { calls } = await runQontak("list_rooms", {});
  assert.equal(calls[0].headers.digest, undefined);
});

test("a node access_token is refused in HMAC mode and used as a Bearer token in bearer mode", async () => {
  const recordingFetch = createRecordingFetch([{ body: { data: [] } }]);
  const hmacRun = createOperationRunner(pluginDefinition, HMAC_ENV, { fetchImpl: recordingFetch });
  const refused = await hmacRun("list_rooms", { access_token: "fake-node-token" }, { source: "node" }).then(() => null, (error) => error);
  assert.equal(refused?.kind, "invalid_input");
  assert.match(refused.message, /HMAC/);
  assert.equal(recordingFetch.calls.length, 0);
  const bearerRun = createOperationRunner(pluginDefinition, BEARER_ENV, { fetchImpl: recordingFetch });
  await bearerRun("list_rooms", { access_token: "fake-node-token" }, { source: "node" });
  assert.equal(recordingFetch.calls[0].headers.authorization, "Bearer fake-node-token");
});

test("manifest: CRM deletes are node only, sends and CRM writes are opt-in, every auth env is declared", () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["delete_contact", "delete_company", "delete_deal", "delete_task", "delete_note"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  assert.deepEqual(manifest.permissions.env.sort(), [
    "QONTAK_AUTH_MODE",
    "QONTAK_CHAT_TOKEN",
    "QONTAK_CLIENT_ID",
    "QONTAK_CLIENT_SECRET",
    "QONTAK_CRM_TOKEN",
    "QONTAK_CRM_USER_SSO_ID",
    "QONTAK_TOOL_ALLOW_CRM_WRITES",
    "QONTAK_TOOL_ALLOW_SEND",
    "QONTAK_TOOL_RECIPIENT_ALLOWLIST",
  ]);
});

test("HMAC mode: gateway hosts, a current Date header, X-Crm-User-Sso-Id only on CRM requests", async () => {
  const environment = { ...HMAC_ENV, QONTAK_CRM_USER_SSO_ID: "3f0c1a2b-0000-4000-8000-00000000abcd" };
  const crm = await runQontak("list_contacts", {}, { environment, responses: [{ body: { response: [] } }] });
  if (crm.error) throw crm.error;
  assert.equal(new URL(crm.calls[0].url).origin + new URL(crm.calls[0].url).pathname, "https://api.mekari.com/qontak/crm/contacts");
  assert.match(crm.calls[0].headers.authorization, /^hmac username="fake-client-id", algorithm="hmac-sha256", headers="date request-line", signature="[A-Za-z0-9+/=]+"$/);
  assert.equal(crm.calls[0].headers["x-crm-user-sso-id"], "3f0c1a2b-0000-4000-8000-00000000abcd");
  const chat = await runQontak("list_rooms", {}, { environment });
  assert.equal(chat.calls[0].url, "https://api.mekari.com/qontak/chat/v1/rooms");
  assert.equal(chat.calls[0].headers["x-crm-user-sso-id"], undefined);
});

test("bearer mode: older hosts, the chat token for chat and the CRM token for CRM", async () => {
  const chat = await runQontak("list_whatsapp_templates", {}, { environment: BEARER_ENV });
  assert.equal(chat.calls[0].url, "https://service-chat.qontak.com/api/open/v1/templates/whatsapp");
  assert.equal(chat.calls[0].headers.authorization, "Bearer fake-chat-token");
  const crm = await runQontak("list_pipelines", {}, { environment: BEARER_ENV, responses: [{ body: { response: [] } }] });
  assert.equal(crm.calls[0].url, "https://app.qontak.com/api/v3.1/pipelines");
  assert.equal(crm.calls[0].headers.authorization, "Bearer fake-crm-token");
  const missingCrmToken = await runQontak("list_pipelines", {}, { environment: { QONTAK_CHAT_TOKEN: "fake-chat-token" } });
  assert.equal(missingCrmToken.error?.kind, "auth_error");
  assert.match(missingCrmToken.error.message, /QONTAK_CRM_TOKEN/);
});

test("no credentials, or an unknown QONTAK_AUTH_MODE, fail before any request", async () => {
  const none = await runQontak("list_rooms", {}, { environment: {} });
  assert.equal(none.error?.kind, "auth_error");
  assert.equal(none.calls.length, 0);
  const badMode = await runQontak("list_rooms", {}, { environment: { ...HMAC_ENV, QONTAK_AUTH_MODE: "basic" } });
  assert.equal(badMode.error?.kind, "invalid_input");
  assert.equal(badMode.calls.length, 0);
});

test("the client secret and signature never appear in errors", async () => {
  const { error } = await runQontak("list_rooms", {}, { responses: [{ status: 400, body: { message: "bad secret fake-secret" } }] });
  assert.equal(error.message.includes("fake-secret"), false);
});

test("send_whatsapp_template as a tool needs the opt-in and an exact allowlist match", async () => {
  const noOptIn = await runQontak("send_whatsapp_template", sendArgs("+6281234567890"), { environment: { ...HMAC_ENV, QONTAK_TOOL_RECIPIENT_ALLOWLIST: "+6281234567890" } });
  assert.equal(noOptIn.error?.kind, "permission_denied");
  assert.match(noOptIn.error.message, /QONTAK_TOOL_ALLOW_SEND/);
  const noAllowlist = await runQontak("send_whatsapp_template", sendArgs("+6281234567890"), { environment: { ...HMAC_ENV, QONTAK_TOOL_ALLOW_SEND: "1" } });
  assert.equal(noAllowlist.error?.kind, "permission_denied");
  assert.match(noAllowlist.error.message, /QONTAK_TOOL_RECIPIENT_ALLOWLIST/);
  const stranger = await runQontak("send_whatsapp_template", sendArgs("+6281299999999"), { environment: SEND_ENV });
  assert.equal(stranger.error?.kind, "permission_denied");
  for (const refused of [noOptIn, noAllowlist, stranger]) assert.equal(refused.calls.length, 0);
  const allowed = await runQontak("send_whatsapp_template", sendArgs("+62 812-3456-7890"), { environment: SEND_ENV });
  if (allowed.error) throw allowed.error;
  assert.equal(allowed.calls[0].json.to_number, "6281234567890");
});

test("send_whatsapp_template refuses national numbers (no +) for nodes too, and is never retried", async () => {
  const national = await runQontak("send_whatsapp_template", sendArgs("081234567890"), { source: "node" });
  assert.equal(national.error?.kind, "invalid_input");
  assert.equal(national.calls.length, 0);
  const failed = await runQontak("send_whatsapp_template", sendArgs("+6281234567890"), { source: "node", responses: [{ status: 502, body: {} }, { body: {} }] });
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.error.retryable, false);
  assert.match(failed.error.message, /get_whatsapp_broadcast_log/);
});

test("CRM writes as tools need QONTAK_TOOL_ALLOW_CRM_WRITES=1; deals need pipeline and stage", async () => {
  const refused = await runQontak("create_deal", { name: "Paket A", crm_pipeline_id: 2, crm_stage_id: 1 });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.match(refused.error.message, /QONTAK_TOOL_ALLOW_CRM_WRITES/);
  const allowed = await runQontak("update_contact", { contact_id: 7, job_title: "Owner" }, { environment: { ...HMAC_ENV, QONTAK_TOOL_ALLOW_CRM_WRITES: "1" } });
  if (allowed.error) throw allowed.error;
  const missingStage = await runQontak("create_deal", { name: "Paket A", crm_pipeline_id: 2 }, { source: "node" });
  assert.equal(missingStage.error?.kind, "invalid_input");
});

test("list_integrations strips secret-looking fields for tools only", async () => {
  const integration = { id: "i1", target_channel: "wa", settings: { phone_number: "6281234567890", access_token: "leak", webhook_url: "https://x", app_secret: "leak" } };
  const asTool = await runQontak("list_integrations", {}, { responses: [{ body: { data: [integration] } }] });
  assert.deepEqual(asTool.output.data, [{ id: "i1", target_channel: "wa", settings: { phone_number: "6281234567890", access_token: "[removed]", webhook_url: "[removed]", app_secret: "[removed]" } }]);
  const asNode = await runQontak("list_integrations", {}, { source: "node", responses: [{ body: { data: [integration] } }] });
  assert.equal(asNode.output.data[0].settings.access_token, "leak");
  assert.deepEqual(stripSecretFields([{ apiKey: 1, nested: [{ password: 2, ok: 3 }] }]), [{ apiKey: "[removed]", nested: [{ password: "[removed]", ok: 3 }] }]);
});

test("stripSecretFields also strips bearer/auth keys and {key|name, value} pairs whose name is secret-ish", () => {
  const settings = {
    bearer: "x",
    Authorization: "Bearer x",
    auth: { user: "u" },
    api_key: "x",
    credentials: "x",
    headers: [{ key: "X-Api-Key", value: "leak" }, { name: "Content-Type", value: "application/json" }, { name: "access_token", value: "leak" }],
  };
  assert.deepEqual(stripSecretFields(settings), {
    bearer: "[removed]",
    Authorization: "[removed]",
    auth: "[removed]",
    api_key: "[removed]",
    credentials: "[removed]",
    headers: [{ key: "X-Api-Key", value: "[removed]" }, { name: "Content-Type", value: "application/json" }, { name: "access_token", value: "[removed]" }],
  });
});

test("stripSecretFields drops values nested past the depth limit instead of returning them unstripped", () => {
  let deep = { access_token: "leak" };
  for (let level = 0; level < 30; level += 1) deep = { child: deep };
  const stripped = JSON.stringify(stripSecretFields(deep));
  assert.equal(stripped.includes("leak"), false);
  assert.match(stripped, /\[removed: too deep\]/);
});

test("api_request as a tool only reads templates, rooms and broadcasts (not integrations), no bypasses", async () => {
  for (const path of ["/integrations", "/integrations/i1", "/rooms/%2e%2e/integrations", "/rooms/%252e%252e/integrations", "/users"]) {
    const refused = await runQontak("api_request", { path });
    assert.equal(refused.error?.kind, "permission_denied", path);
    assert.equal(refused.calls.length, 0, path);
  }
  const allowed = await runQontak("api_request", { path: "/rooms/r1/participants" });
  if (allowed.error) throw allowed.error;
});
