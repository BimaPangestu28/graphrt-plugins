/**
 * Contract for every plugin that opts into per-user tool tokens (`toolUserToken`, see
 * shared/lib/tool-user-token.mjs): with `<PLUGIN>_TOOL_TOKEN_SOURCE=context`,
 *   - every tool call without `context.secrets.access_token` is refused with `auth_error` and sends nothing;
 *   - `api_request` (when the plugin has it) sends the context token and none of the env credentials;
 *   - the token does not appear in the tool result.
 * Each plugin is loaded through its own copy of the shared lib, as it runs when installed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { findSharedPlugins } from "../plugins.mjs";

const USER_TOKEN = "ctx-user-token-0123456789";
// Non-credential settings some plugins need before they can build a request URL.
const REQUIRED_SETTINGS = {
  pipedrive: { PIPEDRIVE_COMPANY_DOMAIN: "acme" },
  salesforce: { SALESFORCE_INSTANCE_URL: "https://acme.my.salesforce.com" },
  trello: { TRELLO_API_KEY: "appkey0123456789" },
};
// api_request paths an agent tool may read, for plugins that restrict them.
const READ_PATHS = {
  asana: "/users/me",
  calendly: "/users/me",
  clickup: "/team",
  gitlab: "/projects",
  hubspot: "/crm/v3/owners",
  pipedrive: "/v2/persons",
  slack: "/users.list",
  todoist: "/projects",
  trello: "/members/me/boards",
  typeform: "/forms",
  vercel: "/v2/user",
  "zoho-crm": "/users",
  zoom: "/users/me",
};

const optedInPlugins = [];
for (const pluginDirectory of findSharedPlugins()) {
  const manifest = JSON.parse(readFileSync(join(pluginDirectory, "graphrt-plugin.json"), "utf8"));
  const sourceEnv = `${manifest.name.toUpperCase().replace(/-/g, "_")}_TOOL_TOKEN_SOURCE`;
  if (manifest.permissions.env?.includes(sourceEnv)) optedInPlugins.push({ pluginDirectory, manifest, sourceEnv });
}

test("plugins that opt in are found", () => {
  assert.ok(optedInPlugins.length >= 30, `found ${optedInPlugins.length}`);
});

function createFetchSpy() {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push(`${url} ${JSON.stringify(init.headers ?? {})} ${typeof init.body === "string" ? init.body : ""}`);
    return new Response(JSON.stringify({ ok: true, echoed: USER_TOKEN }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { requests, fetchImpl };
}

async function loadPlugin({ pluginDirectory }) {
  const { pluginDefinition } = await import(pathToFileURL(join(pluginDirectory, "definition.mjs")).href);
  const { createOperationRunner } = await import(pathToFileURL(join(pluginDirectory, "lib", "shared", "operations.mjs")).href);
  const { toolContext } = await import(pathToFileURL(join(pluginDirectory, "lib", "shared", "graphrt-plugin.mjs")).href);
  return { pluginDefinition, createOperationRunner, toolContext };
}

function buildEnvironment(pluginDefinition, sourceEnv) {
  const credentialEnv = [pluginDefinition.tokenEnv, ...(pluginDefinition.toolUserToken?.credentialEnv ?? [])].filter(Boolean);
  const decoys = Object.fromEntries(credentialEnv.map((envName) => [envName, `decoy${envName.toLowerCase().replace(/_/g, "")}`]));
  return { environment: { ...decoys, ...REQUIRED_SETTINGS[pluginDefinition.name], [sourceEnv]: "context" }, decoyValues: Object.values(decoys) };
}

for (const plugin of optedInPlugins) {
  const pluginName = basename(plugin.pluginDirectory);

  test(`${pluginName}: tool calls without a context token are refused before any request`, async () => {
    const { pluginDefinition, createOperationRunner } = await loadPlugin(plugin);
    const { environment, decoyValues } = buildEnvironment(pluginDefinition, plugin.sourceEnv);
    const { requests, fetchImpl } = createFetchSpy();
    const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl });
    for (const tool of plugin.manifest.tools) {
      await assert.rejects(runOperation(tool.name, {}, { source: "tool" }), (error) => {
        assert.equal(error.kind, "auth_error", `${tool.name}: ${error.message}`);
        assert.ok(decoyValues.every((decoy) => !error.message.includes(decoy)));
        return true;
      });
    }
    assert.equal(requests.length, 0);
  });

  if (!plugin.manifest.tools.some((tool) => tool.name === "api_request")) continue;

  test(`${pluginName}: api_request sends the context token and no env credential`, async () => {
    const { pluginDefinition, createOperationRunner, toolContext } = await loadPlugin(plugin);
    const { environment, decoyValues } = buildEnvironment(pluginDefinition, plugin.sourceEnv);
    const { requests, fetchImpl } = createFetchSpy();
    const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl, resolveHostAddresses: async () => ["93.184.216.34"] });
    const callContext = toolContext({ secrets: { access_token: USER_TOKEN } });
    const output = await runOperation("api_request", { path: READ_PATHS[pluginName] ?? "/graphrt-contract-check" }, { source: "tool", toolContext: callContext });
    assert.ok(requests.length >= 1, "a request was sent");
    assert.ok(requests.some((request) => request.includes(USER_TOKEN)), `the context token was sent: ${requests.join("\n")}`);
    for (const decoy of decoyValues) assert.ok(requests.every((request) => !request.includes(decoy)), `env credential ${decoy} was not sent`);
    assert.ok(!JSON.stringify(output).includes(USER_TOKEN), "the token is not in the result");
  });
}
