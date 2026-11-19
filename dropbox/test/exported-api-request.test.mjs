// Runs on the EXPORTED pluginDefinition (with every wrapper and guard), as an agent tool would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const ENVIRONMENT = {"DROPBOX_APP_KEY": "app-key", "DROPBOX_APP_SECRET": "dropbox-secret-0001", "DROPBOX_REFRESH_TOKEN": "dropbox-refresh-0001"};
const SECRETS = ["dropbox-secret-0001", "dropbox-access-token-0001"];

async function runAsTool(args, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const fetchWithTokenEndpoint = (url, init) => {
    if (String(url).startsWith("https://api.dropboxapi.com/oauth2/token")) return Promise.resolve(Response.json({ access_token: "dropbox-access-token-0001", expires_in: 3600 }));
    return recordingFetch(url, init);
  };
  const run = createOperationRunner(pluginDefinition, ENVIRONMENT, { fetchImpl: fetchWithTokenEndpoint });
  const outcome = await run("api_request", args, { source: "tool" }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("exported pluginDefinition: tool api_request redacts credentials echoed in a GET response", async () => {
  const { output, error } = await runAsTool({ path: "/files/list_folder" }, [{ body: { echoed: SECRETS.join(" ") } }]);
  if (error) throw error;
  for (const secretValue of SECRETS) assert.ok(!JSON.stringify(output).includes(secretValue), `${secretValue} leaked`);
});

test("exported pluginDefinition: tool api_request refuses POST, even on a path tools may read", async () => {
  const { error, calls } = await runAsTool({ path: "/files/list_folder", method: "POST", body: { name: "x" } }, [{ body: {} }]);
  assert.equal(error?.kind, "permission_denied");
  assert.equal(calls.length, 0);
});
