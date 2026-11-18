/**
 * Token operation: refresh an OAuth 2.0 user access token.
 */
import { refreshAccessToken } from "../lib/token-refresh.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";

function rejectInput(message) {
  throw new PluginError(message, { kind: "invalid_input" });
}

export const tokenOperations = [
  {
    name: "refresh_access_token",
    title: "Refresh X access token",
    // Node only: refresh tokens and new access tokens must never pass through an LLM.
    nodeOnly: true,
    description:
      "Exchange a refresh token (scope offline.access) for a new access token. X rotates refresh tokens: store the returned refresh_token. Defaults to X_REFRESH_TOKEN / X_CLIENT_ID; uses X_CLIENT_SECRET for confidential clients.",
    parameters: {
      type: "object",
      properties: {
        refresh_token: { type: "string", minLength: 1, description: "Current refresh token (default: X_REFRESH_TOKEN)" },
        client_id: { type: "string", minLength: 1, description: "OAuth 2.0 client id of the X app (default: X_CLIENT_ID)" },
      },
    },
    run: async ({ client, args, environment, signal }) => {
      const refreshToken = args.refresh_token ?? environment.X_REFRESH_TOKEN;
      const clientId = args.client_id ?? environment.X_CLIENT_ID;
      if (!refreshToken || !clientId) rejectInput("Pass `refresh_token` and `client_id`, or set X_REFRESH_TOKEN and X_CLIENT_ID");
      return { data: await refreshAccessToken({ fetchImpl: client.fetchImpl, environment, refreshToken, clientId, signal }) };
    },
  },
];
