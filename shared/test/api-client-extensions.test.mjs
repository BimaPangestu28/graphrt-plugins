import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createApiClient } from "../lib/api-client.mjs";
import { createRecordingFetch } from "../lib/testing.mjs";

const SECRET = "query-secret-9876";

function createQueryAuthClient(fetchImpl, overrides = {}) {
  return createApiClient({
    baseUrl: "https://api.example.com/v1",
    authorize: ({ query }) => {
      query.api_key = SECRET;
      return [SECRET];
    },
    fetchImpl,
    retryBaseDelayMs: 1,
    ...overrides,
  });
}

test("requestWithHeaders returns a redact helper that removes the credential from any value", async () => {
  const recordingFetch = createRecordingFetch([{ body: {}, headers: { link: `<https://api.example.com/v1/x?api_key=${SECRET}>; rel="next"` } }]);
  const response = await createQueryAuthClient(recordingFetch).requestWithHeaders({ path: "/x" });
  assert.equal(response.redact(response.headers.get("link")).includes(SECRET), false);
  assert.deepEqual(response.redact({ nested: [`k=${SECRET}`] }), { nested: ["k=[redacted]"] });
});

test("signRequest sees the final method, URL (with auth query) and encoded body; its headers are sent and its secrets redacted", async () => {
  const recordingFetch = createRecordingFetch([{ status: 400, body: { message: "bad signature sig-value" } }]);
  const seenRequests = [];
  const client = createQueryAuthClient(recordingFetch, {
    signRequest: ({ method, url, headers, body }) => {
      seenRequests.push({ method, url, body });
      headers["x-signature"] = createHmac("sha256", "k").update(`${method}\n${url}\n${body}`).digest("hex");
      return ["sig-value"];
    },
  });
  await assert.rejects(client.request({ method: "POST", path: "/orders", json: { amount: 5 } }), (error) => !error.message.includes("sig-value"));
  assert.deepEqual(seenRequests[0], { method: "POST", url: `https://api.example.com/v1/orders?api_key=${SECRET}`, body: '{"amount":5}' });
  const expectedSignature = createHmac("sha256", "k").update(`POST\nhttps://api.example.com/v1/orders?api_key=${SECRET}\n{"amount":5}`).digest("hex");
  assert.equal(recordingFetch.calls[0].headers["x-signature"], expectedSignature);
});

test("rawResponse returns the unread Response on success and still maps error statuses", async () => {
  const recordingFetch = createRecordingFetch([{ body: "BINARY", headers: { "content-type": "audio/mpeg" } }, { status: 401, body: { message: "no" } }]);
  const client = createQueryAuthClient(recordingFetch);
  const rawResult = await client.requestWithHeaders({ path: "/speech", rawResponse: true });
  assert.equal(rawResult.status, 200);
  assert.equal(await rawResult.response.text(), "BINARY");
  await assert.rejects(client.requestWithHeaders({ path: "/speech", rawResponse: true }), (error) => error.kind === "auth_error");
});
