/**
 * Generic `api_request` operation: lets a workflow call any endpoint of the
 * plugin's API that has no dedicated operation. The shared client only allows
 * the API's own origin, so the token never leaves it.
 *
 * Policy: when an agent calls it as a tool, only GET is allowed. Writes through
 * an unrestricted endpoint (payments, deletes, bans) must go through a dedicated
 * operation or a workflow node, where a person chose to make that call.
 */
import { PluginError } from "./graphrt-plugin.mjs";

/**
 * Creates the `api_request` operation for one API.
 *
 * @param options - Operation options (object)
 * @param options.apiName - Human name used in the description, e.g. "Meta Graph API" (string)
 * @param options.examplePath - Example path shown in the description (string)
 * @param options.extraProperties - Additional parameter properties, e.g. an `api` selector (object, optional)
 * @param options.selectClient - `(client, args) => client`, picks the client when a plugin has several (function, optional)
 * @returns Operation definition (object)
 */
export function createApiRequestOperation({ apiName, examplePath, extraProperties = {}, selectClient = (client) => client }) {
  return {
    name: "api_request",
    title: `${apiName} request`,
    description: `Call any ${apiName} endpoint that has no dedicated operation, e.g. path "${examplePath}". Only the API's own host is allowed.`,
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
        path: { type: "string", description: `Path relative to the API base, starting with "/", e.g. "${examplePath}"` },
        query: { type: "object", description: "Query parameters" },
        body: { type: "object", description: "JSON body for POST/PUT/PATCH" },
        ...extraProperties,
      },
      required: ["path"],
    },
    run: async ({ client, args, signal, source }) => {
      if (!args.path.startsWith("/")) {
        throw new PluginError('`path` must start with "/" and be relative to the API base URL', { kind: "invalid_input" });
      }
      const method = args.method.toUpperCase();
      if (source === "tool" && method !== "GET") {
        throw new PluginError(
          `api_request is read-only (GET) when called as an agent tool; use a dedicated operation, or a workflow node for ${method}`,
          { kind: "permission_denied" },
        );
      }
      if (args.body !== undefined && (method === "GET" || method === "DELETE")) {
        throw new PluginError(`\`body\` is not allowed with ${method}; use \`query\``, { kind: "invalid_input" });
      }
      // redactResponse: raw bodies (e.g. paging URLs) may echo the token back.
      const data = await selectClient(client, args).request({ method, path: args.path, query: args.query, json: args.body, signal, redactResponse: true });
      return { data };
    },
  };
}
