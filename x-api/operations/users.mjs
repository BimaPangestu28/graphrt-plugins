/**
 * User operations: the authenticated user and lookups by username.
 */
import { mergeQueryParams, QUERY_PARAMS_PROPERTY } from "../lib/parameters.mjs";

export const userOperations = [
  {
    name: "get_me",
    title: "Get my X profile",
    description: "Read the authenticated X user (id, name, username). Use query_params for user.fields/expansions.",
    parameters: { type: "object", properties: { query_params: QUERY_PARAMS_PROPERTY } },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ path: "/2/users/me", query: mergeQueryParams(args.query_params, {}), signal }),
    }),
  },
  {
    name: "get_user_by_username",
    title: "Get X user by username",
    description: "Look up an X user by username (without @).",
    parameters: {
      type: "object",
      properties: {
        username: { type: "string", pattern: "^[A-Za-z0-9_]{1,15}$", description: "Username without @" },
        query_params: QUERY_PARAMS_PROPERTY,
      },
      required: ["username"],
    },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ path: `/2/users/by/username/${args.username}`, query: mergeQueryParams(args.query_params, {}), signal }),
    }),
  },
];
