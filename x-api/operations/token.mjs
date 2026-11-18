/**
 * Token operation: refresh an OAuth 2.0 user access token.
 */
import { refreshAccessToken } from "../lib/token-refresh.mjs";

export const tokenOperations = [
  {
    name: "refresh_access_token",
    title: "Refresh X access token",
    description:
      "Exchange a refresh token (scope offline.access) for a new access token. X rotates refresh tokens: store the returned refresh_token. Uses X_CLIENT_SECRET for confidential clients.",
    parameters: {
      type: "object",
      properties: {
        refresh_token: { type: "string", minLength: 1, description: "Current refresh token" },
        client_id: { type: "string", minLength: 1, description: "OAuth 2.0 client id of the X app" },
      },
      required: ["refresh_token", "client_id"],
    },
    run: async ({ client, args, environment, signal }) => ({
      data: await refreshAccessToken({ fetchImpl: client.fetchImpl, environment, refreshToken: args.refresh_token, clientId: args.client_id, signal }),
    }),
  },
];
