// Runs on the EXPORTED pluginDefinition (with every wrapper and guard), as an agent tool would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const ENVIRONMENT = {"MICROSOFT_CLIENT_ID": "client-1", "MICROSOFT_CLIENT_SECRET": "onedrive-secret-0001", "MICROSOFT_REFRESH_TOKEN": "onedrive-refresh-0001"};
const SECRETS = ["onedrive-secret-0001", "onedrive-access-token-0001"];

async function runAsTool(args, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const fetchWithTokenEndpoint = (url, init) => {
    if (String(url).startsWith("https://login.microsoftonline.com/")) return Promise.resolve(Response.json({ access_token: "onedrive-access-token-0001", expires_in: 3600 }));
    return recordingFetch(url, init);
  };
  const run = createOperationRunner(pluginDefinition, ENVIRONMENT, { fetchImpl: fetchWithTokenEndpoint });
  const outcome = await run("api_request", args, { source: "tool" }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("exported pluginDefinition: tool api_request redacts credentials echoed in a GET response", async () => {
  const { output, error } = await runAsTool({ path: "/me/drive/root/children" }, [{ body: { echoed: SECRETS.join(" ") } }]);
  if (error) throw error;
  for (const secretValue of SECRETS) assert.ok(!JSON.stringify(output).includes(secretValue), `${secretValue} leaked`);
});

test("exported pluginDefinition: tool api_request refuses POST, even on a path tools may read", async () => {
  const { error, calls } = await runAsTool({ path: "/me/drive/root/children", method: "POST", body: { name: "x" } }, [{ body: {} }]);
  assert.equal(error?.kind, "permission_denied");
  assert.equal(calls.length, 0);
});
