/**
 * Metadata operations: the bases a token can see and a base's tables, fields and views.
 * Both need the `schema.bases:read` scope.
 */
import { resolveBaseId } from "../lib/client.mjs";
import { BASE_ID_PROPERTY, CURSOR_PROPERTY } from "./common.mjs";

export const metaOperations = [
  {
    name: "list_bases",
    title: "List bases",
    description: "List the Airtable bases the token can access (id, name, permission level), up to 1000 per page.",
    parameters: { type: "object", properties: { cursor: CURSOR_PROPERTY } },
    run: async ({ client, args, signal }) => {
      const page = await client.request({ path: "/meta/bases", query: { offset: args.cursor }, signal });
      return { data: page, next_cursor: page?.offset ?? null };
    },
  },
  {
    name: "get_base_schema",
    title: "Get base schema",
    description: "Get a base's tables with their fields (names, ids, types, select options) and views.",
    parameters: { type: "object", properties: { base_id: BASE_ID_PROPERTY } },
    run: async (context) => ({
      data: await context.client.request({ path: `/meta/bases/${resolveBaseId(context)}/tables`, signal: context.signal }),
    }),
  },
];
