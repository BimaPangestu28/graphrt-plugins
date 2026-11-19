import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const ENVIRONMENT = { HUBSPOT_ACCESS_TOKEN: "pat-na1-test-token" };

async function runHubSpot(operationName, args, { source = "tool", responses = [{ body: { results: [] } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, ENVIRONMENT, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("manifest: archive and association removal are node only; create_note takes simple fields", () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["archive_object", "remove_association"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  for (const toolName of ["search_objects", "create_object", "update_object", "associate_objects", "create_note", "api_request"]) assert.equal(toolNames.includes(toolName), true, toolName);
  const noteTool = manifest.tools.find((tool) => tool.name === "create_note");
  assert.deepEqual(noteTool.parameters.required, ["body"]);
  assert.ok(noteTool.parameters.properties.contact_ids);
});

test("create_note defaults hs_timestamp to now and links every record kind", async () => {
  const before = Date.now();
  const { error, calls } = await runHubSpot("create_note", { body: "Demo booked", company_ids: ["77"], ticket_ids: ["5"] }, { responses: [{ status: 201, body: { id: "n1" } }] });
  if (error) throw error;
  const { properties, associations } = calls[0].json;
  assert.ok(Date.parse(properties.hs_timestamp) >= before - 1000);
  assert.deepEqual(associations.map((association) => association.types[0].associationTypeId), [190, 228]);
});

test("api_request as a tool reads CRM paths but not other GET endpoints; nodes are not limited", async () => {
  const crmRead = await runHubSpot("api_request", { path: "/crm/objects/2026-09/contacts/401/associations/deals" });
  if (crmRead.error) throw crmRead.error;
  assert.equal(new URL(crmRead.calls[0].url).pathname, "/crm/objects/2026-09/contacts/401/associations/deals");
  for (const path of ["/marketing/v3/transactional/smtp-tokens", "/webhooks/v3/1/settings", "/crm/objects/../../marketing/v3/transactional/smtp-tokens", "/crm/objects/%2e%2e/x", "/crm/objects/%252e%252e/%252e%252e/marketing/v3/transactional/smtp-tokens", "/crm/v3/extensions/calling/1/settings", "/crm/objects/a%2f..%2f..%2fwebhooks"]) {
    const refused = await runHubSpot("api_request", { path });
    assert.equal(refused.error?.kind, "permission_denied", path);
    assert.equal(refused.calls.length, 0, path);
  }
  const nodeRead = await runHubSpot("api_request", { path: "/marketing/v3/emails" }, { source: "node" });
  if (nodeRead.error) throw nodeRead.error;
});

test("HubSpot error categories map to error kinds", async () => {
  const cases = [
    [401, { status: "error", message: "Authentication credentials not found.", category: "INVALID_AUTHENTICATION", correlationId: "c1" }, "auth_error"],
    [403, { status: "error", message: "This app hasn't been granted all required scopes.", category: "MISSING_SCOPES", correlationId: "c2" }, "permission_denied"],
    [400, { status: "error", message: "Property values were not valid", category: "VALIDATION_ERROR", correlationId: "c3" }, "invalid_input"],
    [404, { status: "error", message: "Object not found.", category: "OBJECT_NOT_FOUND", correlationId: "c4" }, "not_found"],
  ];
  for (const [status, body, expectedKind] of cases) {
    const { error } = await runHubSpot("get_object", { object_type: "contacts", object_id: "1" }, { responses: [{ status, body }] });
    assert.equal(error?.kind, expectedKind, body.category);
    assert.match(error.message, new RegExp(body.message.slice(0, 20)));
  }
});

test("object types outside the list are refused before any request", async () => {
  const { error, calls } = await runHubSpot("list_objects", { object_type: "secrets" });
  assert.equal(error?.kind, "invalid_input");
  assert.equal(calls.length, 0);
});
