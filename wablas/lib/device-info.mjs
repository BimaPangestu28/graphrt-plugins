/**
 * `get_device_info`, hand-written: Wablas documents GET /api/device/info with the device token in the `token`
 * query parameter (https://pati.wablas.com/documentation/api, "Device info"), while every other endpoint takes the
 * Authorization header. Custom auth can only set headers, so this operation adds the query parameter itself. The
 * token is one of the client's secrets, so it is redacted from errors like any credential.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";

export const TOKEN_ENV = "WABLAS_TOKEN";

/**
 * Builds the device info operation.
 *
 * @returns Operation `{name, title, description, parameters, run}` (object)
 */
export function createDeviceInfoOperation() {
  return {
    name: "get_device_info",
    title: "Device info",
    description: "The device's name, sender number, connection status, remaining quota and expiry date",
    nodeOnly: false,
    parameters: { type: "object", properties: {}, required: [] },
    run: async ({ client, environment, source }) => {
      const token = String(environment?.[TOKEN_ENV] ?? "").trim();
      if (token === "") throw new PluginError(`No credential: set the ${TOKEN_ENV} environment variable`, { kind: "auth_error" });
      const body = await client.request({ method: "GET", path: "/api/device/info", query: { token }, redactResponse: true });
      const data = body?.data ?? null;
      return { data: source === "tool" ? truncateForTool(data, DEFAULT_TOOL_OUTPUT) : data, next_cursor: null };
    },
  };
}
