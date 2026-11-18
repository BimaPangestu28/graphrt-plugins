import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiRequestOperation } from "../lib/api-request-operation.mjs";
import { validateArguments } from "../lib/params.mjs";

function createRecordingClient() {
  const requests = [];
  return { requests, request: async (requestOptions) => (requests.push(requestOptions), { ok: true }) };
}

test("api_request forwards method, path, query and JSON body", async () => {
  const operation = createApiRequestOperation({ apiName: "Demo API", examplePath: "/me" });
  const client = createRecordingClient();
  const args = validateArguments(operation.parameters, { method: "post", path: "/me/feed", query: '{"a":1}', body: { message: "hi" } });
  const result = await operation.run({ client, args });
  assert.deepEqual(client.requests[0], { method: "POST", path: "/me/feed", query: { a: 1 }, json: { message: "hi" }, signal: undefined, redactResponse: true });
  assert.deepEqual(result, { data: { ok: true } });
});

test("api_request rejects a path that does not start with a slash", async () => {
  const operation = createApiRequestOperation({ apiName: "Demo API", examplePath: "/me" });
  const args = validateArguments(operation.parameters, { method: "GET", path: "me" });
  await assert.rejects(operation.run({ client: createRecordingClient(), args }), (error) => error.kind === "invalid_input");
});

test("api_request rejects a body on GET", async () => {
  const operation = createApiRequestOperation({ apiName: "Demo API", examplePath: "/me" });
  const args = validateArguments(operation.parameters, { path: "/me", body: { a: 1 } });
  await assert.rejects(operation.run({ client: createRecordingClient(), args }), (error) => error.kind === "invalid_input");
});

test("api_request asks the client to redact credentials from the response", async () => {
  const operation = createApiRequestOperation({ apiName: "Demo API", examplePath: "/me" });
  const client = createRecordingClient();
  await operation.run({ client, args: validateArguments(operation.parameters, { path: "/me" }) });
  assert.equal(client.requests[0].redactResponse, true);
});
