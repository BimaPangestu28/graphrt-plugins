/**
 * Pinecone data-plane hosts. Each index has its own host (`describe_index` → `host`, e.g.
 * `docs-example-a1b2c3d.svc.aped-4627-b74a.pinecone.io`), and the API key is sent to it, so the host must be one of
 * Pinecone's: https under `.pinecone.io` (PrivateLink hosts included), or Pinecone Local on http://localhost.
 *
 * `addIndexHostArgument` gives data-plane operations an optional `index_host` argument that overrides
 * PINECONE_INDEX_HOST for one call; the argument must be a Pinecone host (Pinecone Local on localhost only from the env,
 * so a workflow template or an agent cannot point the API key at a local service). The declarative layer resolves an operation's base URL from the environment, so the
 * wrapper validates the argument and passes it on as PINECONE_INDEX_HOST in that call's environment only.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const INDEX_HOST_ENV = "PINECONE_INDEX_HOST";
const PINECONE_HOST_SUFFIX = ".pinecone.io";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const INDEX_HOST_PARAMETER = {
  type: "string",
  description: `Index host from describe_index (\`host\`), e.g. my-index-abc123.svc.aped-4627-b74a.pinecone.io; default ${INDEX_HOST_ENV}`,
};

/**
 * Turns an index host into the data-plane base URL, refusing anything that is not a Pinecone host.
 *
 * @param hostText - Host with or without `https://`, or `http://localhost:<port>` for Pinecone Local (string)
 * @param options - `{allowLocal}`: accept Pinecone Local on localhost (default true; false for call arguments) (object, optional)
 * @returns Base URL without a trailing slash, e.g. "https://my-index-abc.svc.aped-4627-b74a.pinecone.io" (string)
 * @throws Error - Missing host, not under .pinecone.io, plain http to a remote host, or a path, query or credentials
 *
 * @example
 * resolveIndexHostUrl("my-index-abc.svc.aped-4627-b74a.pinecone.io"); // "https://my-index-abc.svc.aped-4627-b74a.pinecone.io"
 */
export function resolveIndexHostUrl(hostText, { allowLocal = true } = {}) {
  const trimmedHost = typeof hostText === "string" ? hostText.trim() : "";
  if (trimmedHost === "") throw new Error(`set ${INDEX_HOST_ENV} or pass index_host (the index's host from describe_index)`);
  const hostUrl = parseHostUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedHost) ? trimmedHost : `https://${trimmedHost}`);
  const hostname = hostUrl.hostname.toLowerCase();
  const isLocal = allowLocal && hostUrl.protocol === "http:" && LOCAL_HOSTS.has(hostname);
  const isPinecone = hostUrl.protocol === "https:" && hostname.endsWith(PINECONE_HOST_SUFFIX) && hostname.length > PINECONE_HOST_SUFFIX.length;
  const hasExtras = hostUrl.username || hostUrl.password || hostUrl.search || hostUrl.hash || !["", "/"].includes(hostUrl.pathname);
  if ((!isLocal && !isPinecone) || hasExtras) {
    throw new Error(`index_host / ${INDEX_HOST_ENV} must be an index host under ${PINECONE_HOST_SUFFIX} (https, no path), or http://localhost:<port> for Pinecone Local; got ${JSON.stringify(trimmedHost)}`);
  }
  return `${hostUrl.protocol}//${hostUrl.host.toLowerCase()}`;
}

function parseHostUrl(urlText) {
  try {
    return new URL(urlText);
  } catch {
    throw new Error(`index_host / ${INDEX_HOST_ENV} is not a valid host: ${JSON.stringify(urlText)}`);
  }
}

/**
 * Adds an optional `index_host` argument to the named operations; it replaces PINECONE_INDEX_HOST for that call.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @param operationNames - Data-plane operation names (string[])
 * @returns A new definition (object)
 * @throws PluginError kind `invalid_input` - At call time, when index_host is not a Pinecone host
 */
export function addIndexHostArgument(pluginDefinition, operationNames) {
  const dataPlaneNames = new Set(operationNames);
  const wrapOperation = (operation) => {
    if (!dataPlaneNames.has(operation.name)) return operation;
    const parameters = { ...operation.parameters, properties: { index_host: INDEX_HOST_PARAMETER, ...operation.parameters.properties } };
    const run = (context) => {
      const { index_host: indexHost, ...args } = context.args ?? {};
      if (indexHost === undefined) return operation.run({ ...context, args });
      checkIndexHostArgument(indexHost);
      return operation.run({ ...context, args, environment: { ...context.environment, [INDEX_HOST_ENV]: indexHost } });
    };
    return { ...operation, parameters, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

function checkIndexHostArgument(indexHost) {
  try {
    resolveIndexHostUrl(indexHost, { allowLocal: false });
  } catch (hostError) {
    const localNote = " (Pinecone Local on localhost is only accepted from PINECONE_INDEX_HOST, never as an argument)";
    throw new PluginError(`${hostError.message}${localNote}`, { kind: "invalid_input" });
  }
}
