/**
 * Exports a declarative REST plugin (shared/lib/rest-plugin.mjs) as data for its WebAssembly build
 * (wasm/rest-kit): the Node.js plugin stays the single source of the contract, and the WebAssembly build
 * embeds what this script writes.
 *
 * For each port directory `wasm/<plugin>/` with a `rest-port.json`:
 *   - `manifest.json`: what `graphrt_describe` returns, the Node.js plugin's nodes and tools byte for byte;
 *   - `spec.jsonl`: the runtime spec rest-kit reads (APIs, operations, params, auth, errors, pagination), one
 *     JSON document per line so a call parses only what it uses (rest-kit/src/spec.rs);
 *   - `graphrt-plugin.json`: the install manifest (`runtime: wasm`) with the Node.js plugin's permissions and limits.
 *
 * `rest-port.json`: `{"definition": "pluginDefinition", "apis": {"main": "restDefinition"}, "module": "x.wasm"}`;
 * the first API is the plugin's own (operations of the same name and `api_request` run on it), the others are
 * only reachable from the port's Rust hooks. Spec features rest-kit does not implement are refused here, so a
 * port can never silently drop behaviour.
 *
 *   node wasm/scripts/export-rest-spec.mjs [--check] [port ...]
 *
 * `--check` fails when a committed file differs from a fresh export.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WASM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(WASM_DIR, "..");
const PORT_FILE = "rest-port.json";
const SUPPORTED_AUTH = new Set(["none", "bearer", "header", "query"]);
const SUPPORTED_BODY_MODES = new Set(["json", "raw", "form", "text"]);
const UNSUPPORTED_OPERATION_FIELDS = ["job", "download", "multipart", "fileBody", "idempotencyKeyHeader", "minRequestMs"];
const RUNTIME_OPERATION_FIELDS = [
  "name", "method", "path", "baseUrl", "sendCredential", "params", "constants", "response", "pagination", "write",
  "checkHint", "timeoutMs", "toolOutput", "nodeOnly", "toolPolicy", "contentType", "bodyMode", "formArrays",
];
const RUNTIME_PARAM_FIELDS = ["in", "wireName", "style"];

/**
 * Exports one port.
 *
 * @param portName - Directory under wasm/, the plugin's name (string)
 * @returns `{fileName: text}` of the three generated files (Promise<object>)
 * @throws Error - When the definition uses a feature rest-kit does not implement
 */
export async function exportPort(portName) {
  const portDirectory = join(WASM_DIR, portName);
  const portConfig = JSON.parse(readFileSync(join(portDirectory, PORT_FILE), "utf8"));
  const definitionModule = await import(pathToFileURL(join(REPO_ROOT, portName, "definition.mjs")));
  const { buildDescriptors, buildManifest } = await import(pathToFileURL(join(REPO_ROOT, portName, "lib/shared/operations.mjs")));
  const { toolTokenSourceEnv } = await import(pathToFileURL(join(REPO_ROOT, portName, "lib/shared/tool-user-token.mjs")));
  const pluginDefinition = definitionModule[portConfig.definition];
  const apiDefinitions = Object.entries(portConfig.apis).map(([apiName, exportName]) => [apiName, definitionModule[exportName]]);
  const nodeManifest = buildManifest(pluginDefinition);
  const { nodes, tools } = buildDescriptors(pluginDefinition);
  const manifest = { name: pluginDefinition.name, version: pluginDefinition.version, description: pluginDefinition.description, nodes, tools };
  const operations = describeOperations(pluginDefinition, apiDefinitions[0]);
  const spec = {
    name: pluginDefinition.name,
    version: pluginDefinition.version,
    tokenEnv: pluginDefinition.tokenEnv ?? null,
    noCredentials: pluginDefinition.noCredentials === true,
    toolTokenSourceEnv: toolTokenSourceEnv(pluginDefinition) ?? null,
    toolCredentialEnv: describeToolCredentialEnv(pluginDefinition),
    operations,
    apis: Object.fromEntries(apiDefinitions.map(([apiName, apiDefinition]) => [apiName, describeApi(apiName, apiDefinition, outerNamesOf(operations, apiName))])),
  };
  const installManifest = {
    name: nodeManifest.name,
    version: nodeManifest.version,
    description: `${nodeManifest.description} (WebAssembly build)`,
    license: nodeManifest.license,
    runtime: "wasm",
    module: portConfig.module,
    permissions: nodeManifest.permissions,
    limits: nodeManifest.limits,
    nodes: nodeManifest.nodes,
    tools: nodeManifest.tools,
  };
  return {
    "manifest.json": `${JSON.stringify(manifest)}\n`,
    "spec.jsonl": renderSpecLines(spec),
    "graphrt-plugin.json": `${JSON.stringify(installManifest, null, 2)}\n`,
  };
}

// One JSON document per line (rest-kit/src/spec.rs): a call parses only the lines it uses.
function renderSpecLines({ operations, apis, ...plugin }) {
  const lines = [{ plugin: { ...plugin, operations: operations.map(({ schema, ...operation }) => operation) } }];
  for (const operation of operations) lines.push({ schema: operation.name, value: operation.schema });
  for (const [apiName, { operations: apiOperations, ...api }] of Object.entries(apis)) {
    lines.push({ api: apiName, value: api });
    for (const [operationName, operation] of Object.entries(apiOperations)) lines.push({ operation: `${apiName}/${operationName}`, value: operation });
  }
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

function describeToolCredentialEnv(pluginDefinition) {
  if (!pluginDefinition.toolUserToken) return [];
  return [...new Set([pluginDefinition.tokenEnv, ...(pluginDefinition.toolUserToken.credentialEnv ?? [])].filter(Boolean))];
}

// Outer operations: what nodes and tools offer, with the schema their arguments are validated against.
function describeOperations(pluginDefinition, [mainApiName, mainApi]) {
  const mainNames = new Set(mainApi.restSpec.operations.map((operation) => operation.name));
  if (mainApi.restSpec.apiRequest !== false) mainNames.add("api_request");
  return pluginDefinition.operations.map((operation) => ({
    name: operation.name,
    schema: stripDescriptions(operation.parameters),
    nodeOnly: operation.nodeOnly === true,
    api: mainNames.has(operation.name) ? mainApiName : null,
  }));
}

// Operations an outer operation of the same name runs: they are validated with the outer schema, so their own is
// left out of the spec (the hooks validate the others' arguments with it).
function outerNamesOf(operations, apiName) {
  return new Set(operations.filter((operation) => operation.api === apiName).map((operation) => operation.name));
}

function describeApi(apiName, apiDefinition, outerNames) {
  const restSpec = apiDefinition.restSpec;
  if (!restSpec) throw new Error(`api ${apiName}: not a defineRestPlugin definition`);
  if (!SUPPORTED_AUTH.has(restSpec.auth.type)) throw new Error(`${restSpec.name}: auth type ${restSpec.auth.type} is not supported by rest-kit`);
  if (restSpec.idempotencyKeyHeader) throw new Error(`${restSpec.name}: idempotencyKeyHeader is not supported by rest-kit (no randomness in WebAssembly)`);
  const apiRequest = apiDefinition.operations.find((operation) => operation.name === "api_request");
  return {
    name: restSpec.name,
    baseUrl: typeof restSpec.baseUrl === "string" ? restSpec.baseUrl : null,
    allowedHostSuffix: restSpec.allowedHostSuffix ?? null,
    auth: restSpec.auth,
    errors: restSpec.errors ?? {},
    defaultHeaders: restSpec.defaultHeaders ?? {},
    timeoutMs: restSpec.timeoutMs ?? null,
    maxRetries: restSpec.maxRetries ?? null,
    toolOutput: restSpec.toolOutput ?? null,
    apiRequest: Boolean(apiRequest),
    protectedPaths: apiRequest ? describeProtectedPaths(restSpec.operations) : [],
    operations: Object.fromEntries(restSpec.operations.map((operation) => [operation.name, describeRestOperation(restSpec.name, operation, outerNames.has(operation.name) ? undefined : apiDefinition)])),
  };
}

// Same selection as rest-plugin.mjs listProtectedPaths; the pattern is matched by rest-kit.
function describeProtectedPaths(operations) {
  return operations
    .filter((operation) => !operation.baseUrl && ["GET", "HEAD"].includes(operation.method) && (operation.nodeOnly || operation.toolPolicy))
    .map((operation) => ({ operation: operation.name, path: operation.path, optInEnv: operation.nodeOnly ? null : /^optIn:(.+)$/.exec(operation.toolPolicy)[1] }));
}

function describeRestOperation(specName, operation, apiDefinition) {
  const where = `${specName}.${operation.name}`;
  for (const field of UNSUPPORTED_OPERATION_FIELDS) {
    if (operation[field] !== undefined) throw new Error(`${where}: \`${field}\` is not supported by rest-kit`);
  }
  if (!SUPPORTED_BODY_MODES.has(operation.bodyMode)) throw new Error(`${where}: bodyMode ${operation.bodyMode} is not supported by rest-kit`);
  if (operation.response?.binary) throw new Error(`${where}: binary responses are not supported by rest-kit`);
  if (typeof operation.baseUrl === "function") throw new Error(`${where}: a baseUrl function needs a rest-kit hook; use a string`);
  const runtimeOperation = Object.fromEntries(RUNTIME_OPERATION_FIELDS.filter((field) => operation[field] !== undefined).map((field) => [field, operation[field]]));
  runtimeOperation.params = Object.fromEntries(
    Object.entries(operation.params).map(([paramName, paramSpec]) => {
      if (paramSpec.file) throw new Error(`${where}.${paramName}: file params are not supported by rest-kit`);
      return [paramName, Object.fromEntries(RUNTIME_PARAM_FIELDS.filter((field) => paramSpec[field] !== undefined).map((field) => [field, paramSpec[field]]))];
    }),
  );
  if (apiDefinition) runtimeOperation.schema = stripDescriptions(apiDefinition.operations.find((built) => built.name === operation.name).parameters);
  return runtimeOperation;
}

// Validation needs types and constraints only; the descriptions are in manifest.json.
function stripDescriptions(schema) {
  const properties = Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([propertyName, { description, ...constraints }]) => [propertyName, constraints]),
  );
  return { properties, required: schema.required ?? [] };
}

function listPorts() {
  return readdirSync(WASM_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(WASM_DIR, entry.name, PORT_FILE)))
    .map((entry) => entry.name)
    .sort();
}

async function main(commandArguments) {
  const check = commandArguments.includes("--check");
  const requestedPorts = commandArguments.filter((argument) => argument !== "--check");
  let staleFiles = 0;
  for (const portName of requestedPorts.length ? requestedPorts : listPorts()) {
    const generatedFiles = await exportPort(portName);
    for (const [fileName, text] of Object.entries(generatedFiles)) {
      const filePath = join(WASM_DIR, portName, fileName);
      const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
      if (current === text) continue;
      if (check) {
        console.error(`wasm/${portName}/${fileName} is out of date: run node wasm/scripts/export-rest-spec.mjs`);
        staleFiles += 1;
      } else {
        writeFileSync(filePath, text);
        console.error(`wrote wasm/${portName}/${fileName}`);
      }
    }
  }
  if (staleFiles > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
