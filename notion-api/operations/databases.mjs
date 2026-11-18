/**
 * Database and data source operations. Since Notion-Version 2025-09-03 a database is a container of one or
 * more data sources (tables); querying and page schemas belong to the data source.
 */
import { extractNotionId, notionIdSegment, rejectInput, toCursorResult } from "../lib/client.mjs";
import { buildPagination, CURSOR_PROPERTY, DATA_SOURCE_ID_PROPERTY, DATABASE_ID_PROPERTY, LIMIT_PROPERTY } from "./common.mjs";

/**
 * Picks the data source to use: `data_source_id` as given, or the only data source of `database_id`.
 *
 * @param context - `{client, args, signal}` with args.data_source_id or args.database_id (object)
 * @returns Data source id (Promise<string>)
 * @throws PluginError kind `invalid_input` - Neither/both given, or the database has several data sources
 */
export async function resolveDataSourceId({ client, args, signal }) {
  if (args.data_source_id && args.database_id) rejectInput("Pass either `data_source_id` or `database_id`, not both");
  if (args.data_source_id) return extractNotionId(args.data_source_id);
  if (!args.database_id) rejectInput("Pass `data_source_id` or `database_id`");
  const database = await client.request({ path: `/databases/${notionIdSegment(args.database_id)}`, signal });
  const dataSources = Array.isArray(database?.data_sources) ? database.data_sources : [];
  if (dataSources.length === 1) return dataSources[0].id;
  if (dataSources.length === 0) rejectInput("The database has no data sources the integration can see");
  const choices = dataSources.map((dataSource) => `${dataSource.name ?? "(unnamed)"} = ${dataSource.id}`).join("; ");
  return rejectInput(`The database has ${dataSources.length} data sources; pass \`data_source_id\`, one of: ${choices}`);
}

/**
 * Reads a data source (its property schema).
 *
 * @param context - `{client, signal}` (object)
 * @param dataSourceId - Data source id (string)
 * @returns Data source object (Promise<object>)
 */
export function fetchDataSource({ client, signal }, dataSourceId) {
  return client.request({ path: `/data_sources/${notionIdSegment(dataSourceId)}`, signal });
}

export const databaseOperations = [
  {
    name: "get_database",
    title: "Get database",
    description: "Get a Notion database: title, parent and its `data_sources` (id and name of each table).",
    parameters: { type: "object", properties: { database_id: { type: "string", description: "Database id or URL" } }, required: ["database_id"] },
    run: async ({ client, args, signal }) => ({ data: await client.request({ path: `/databases/${notionIdSegment(args.database_id)}`, signal }) }),
  },
  {
    name: "get_data_source",
    title: "Get data source",
    description: "Get a Notion data source (a database table) with its property schema: names, types and select options.",
    parameters: { type: "object", properties: { data_source_id: DATA_SOURCE_ID_PROPERTY, database_id: DATABASE_ID_PROPERTY } },
    run: async (context) => ({ data: await fetchDataSource(context, await resolveDataSourceId(context)) }),
  },
  {
    name: "query_database",
    title: "Query database",
    description:
      "Query the pages of a Notion database (its data source) with an optional Notion filter and sorts, one page of results at a time.",
    parameters: {
      type: "object",
      properties: {
        data_source_id: DATA_SOURCE_ID_PROPERTY,
        database_id: DATABASE_ID_PROPERTY,
        filter: { type: "object", description: 'Notion filter, e.g. {"property": "Stage", "select": {"equals": "Won"}}' },
        sorts: { type: "array", description: 'Notion sorts, e.g. [{"property": "Due", "direction": "ascending"}]' },
        limit: LIMIT_PROPERTY,
        cursor: CURSOR_PROPERTY,
      },
    },
    run: async (context) => {
      const { client, args, signal } = context;
      const dataSourceId = await resolveDataSourceId(context);
      const json = { filter: args.filter, sorts: args.sorts, ...buildPagination(args) };
      const path = `/data_sources/${notionIdSegment(dataSourceId)}/query`;
      return toCursorResult(await client.request({ method: "POST", path, json, signal, idempotent: true }));
    },
  },
];
