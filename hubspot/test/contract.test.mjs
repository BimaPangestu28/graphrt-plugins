import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { wrapCreateNote } from "../lib/hubspot-notes.mjs";
import { restDefinition } from "../definition.mjs";

// The generated suite calls api_request as a tool with an arbitrary path, which the tool path allowlist refuses
// (tested in hubspot.test.mjs), so the contract runs on the definition with only create_note wrapped.
const contractDefinition = { ...restDefinition, operations: restDefinition.operations.map((operation) => (operation.name === "create_note" ? wrapCreateNote(operation) : operation)) };

const OBJECTS = "https://api.hubapi.com/crm/objects/2026-09";
const page = (results, after) => ({ body: { results, ...(after ? { paging: { next: { after, link: "https://api.hubapi.com/x" } } } : {}) } });

describeRestPluginContract(contractDefinition, {
  checkAuth: (call, credential) => assert.equal(call.headers.authorization, `Bearer ${credential}`),
  operations: {
    list_objects: {
      args: { object_type: "contacts", properties: ["email", "firstname"], associations: ["companies"], limit: 50, cursor: "331" },
      request: { method: "GET", url: `${OBJECTS}/contacts`, query: { properties: "email,firstname", associations: "companies", limit: "50", after: "331" } },
      response: page([{ id: "401", properties: { email: "ada@example.com" } }], "402"),
      expect: { data: [{ id: "401", properties: { email: "ada@example.com" } }] },
    },
    get_object: {
      args: { object_type: "contacts", object_id: "ada@example.com", id_property: "email", properties: ["lifecyclestage"] },
      request: { method: "GET", url: `${OBJECTS}/contacts/ada%40example.com`, query: { idProperty: "email", properties: "lifecyclestage" } },
      response: { body: { id: "401", properties: { lifecyclestage: "lead" } } },
    },
    search_objects: {
      args: {
        object_type: "deals",
        query: "renewal",
        filter_groups: [{ filters: [{ propertyName: "amount", operator: "GT", value: "1000" }] }],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        properties: ["dealname", "amount"],
        limit: 100,
      },
      request: {
        method: "POST",
        url: `${OBJECTS}/deals/search`,
        query: "absent",
        json: {
          query: "renewal",
          filterGroups: [{ filters: [{ propertyName: "amount", operator: "GT", value: "1000" }] }],
          sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
          properties: ["dealname", "amount"],
          limit: 100,
        },
      },
      response: { body: { total: 1, results: [{ id: "9" }] } },
      expect: { data: [{ id: "9" }] },
    },
    create_object: {
      args: { object_type: "companies", properties: { name: "Acme", domain: "acme.example" } },
      request: { method: "POST", url: `${OBJECTS}/companies`, query: "absent", json: { properties: { name: "Acme", domain: "acme.example" } } },
      response: { status: 201, body: { id: "77", properties: { name: "Acme" } } },
    },
    update_object: {
      args: { object_type: "tickets", object_id: "5", properties: { hs_pipeline_stage: "4" } },
      request: { method: "PATCH", url: `${OBJECTS}/tickets/5`, query: "absent", json: { properties: { hs_pipeline_stage: "4" } } },
    },
    archive_object: { args: { object_type: "deals", object_id: "9" }, request: { method: "DELETE", url: `${OBJECTS}/deals/9`, query: "absent", body: "absent" }, response: { status: 204 } },
    list_associations: {
      args: { from_object_type: "contacts", from_object_id: "401", to_object_type: "companies" },
      request: { method: "GET", url: `${OBJECTS}/contacts/401/associations/companies`, query: { limit: "100" } },
      response: page([{ toObjectId: 77, associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 1, label: "Primary" }] }]),
    },
    associate_objects: {
      args: { from_object_type: "contacts", from_object_id: "401", to_object_type: "companies", to_object_id: "77" },
      request: { method: "PUT", url: `${OBJECTS}/contacts/401/associations/default/companies/77`, query: "absent", body: "absent" },
    },
    remove_association: {
      args: { from_object_type: "contacts", from_object_id: "401", to_object_type: "companies", to_object_id: "77" },
      request: { method: "DELETE", url: `${OBJECTS}/contacts/401/associations/companies/77`, query: "absent", body: "absent" },
      response: { status: 204 },
    },
    create_note: {
      args: { body: "Called Ada", timestamp: "2026-11-19T08:00:00Z", contact_ids: ["401"] },
      request: {
        method: "POST",
        url: `${OBJECTS}/notes`,
        query: "absent",
        json: {
          properties: { hs_note_body: "Called Ada", hs_timestamp: "2026-11-19T08:00:00Z" },
          associations: [{ to: { id: "401" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
        },
      },
      response: { status: 201, body: { id: "n1" } },
    },
    list_properties: {
      args: { object_type: "contacts" },
      request: { method: "GET", url: "https://api.hubapi.com/crm/properties/2026-09/contacts", query: "absent" },
      response: { body: { results: [{ name: "email", type: "string" }] } },
      expect: { data: [{ name: "email", type: "string" }] },
    },
    list_pipelines: { args: { object_type: "deals" }, request: { method: "GET", url: "https://api.hubapi.com/crm/pipelines/2026-09/deals", query: "absent" }, response: { body: { results: [{ id: "default", stages: [] }] } } },
    list_owners: {
      args: { email: "ada@example.com" },
      request: { method: "GET", url: "https://api.hubapi.com/crm/owners/2026-09", query: { email: "ada@example.com", limit: "100" } },
      response: page([{ id: "55", email: "ada@example.com" }]),
    },
    get_account_details: { args: {}, request: { method: "GET", url: "https://api.hubapi.com/account-info/2026-09/details", query: "absent" }, response: { body: { portalId: 123, timeZone: "Asia/Jakarta" } } },
  },
});
