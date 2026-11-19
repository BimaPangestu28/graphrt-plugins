/**
 * Catalog operations: datasets, tables and a table's schema.
 */
import { pathSegment } from "../lib/shared/path.mjs";
import { summarizeSchema } from "../lib/row-decoding.mjs";
import { pickProjectId } from "../lib/settings.mjs";

export const PROJECT_PROPERTY = { type: "string", description: "Google Cloud project id (default BIGQUERY_PROJECT_ID)" };
const DATASET_PROPERTY = { type: "string", minLength: 1, description: "Dataset id, e.g. analytics" };
const PAGE_PROPERTIES = {
  limit: { type: "integer", minimum: 1, maximum: 1000, default: 100, description: "Maximum results per page" },
  cursor: { type: "string", description: "next_cursor from the previous call" },
};

function datasetPath(args, settings) {
  return `/projects/${pathSegment(pickProjectId(args, settings))}/datasets/${pathSegment(args.dataset_id)}`;
}

function toIsoTime(millisecondsText) {
  const milliseconds = Number(millisecondsText);
  return Number.isFinite(milliseconds) && millisecondsText !== undefined ? new Date(milliseconds).toISOString() : null;
}

/**
 * Condenses a Table resource.
 *
 * @param table - BigQuery Table resource (object)
 * @returns `{table_id, type, description, num_rows, num_bytes, created_at, modified_at, location, partitioning, clustering, schema}` (object)
 */
export function summarizeTable(table = {}) {
  return {
    table_id: table.tableReference?.tableId ?? null,
    dataset_id: table.tableReference?.datasetId ?? null,
    type: table.type ?? null,
    description: table.description ?? null,
    num_rows: table.numRows === undefined ? null : Number(table.numRows),
    num_bytes: table.numBytes === undefined ? null : Number(table.numBytes),
    created_at: toIsoTime(table.creationTime),
    modified_at: toIsoTime(table.lastModifiedTime),
    location: table.location ?? null,
    partitioning: table.timePartitioning ?? table.rangePartitioning ?? null,
    clustering: table.clustering?.fields ?? null,
    require_partition_filter: table.requirePartitionFilter ?? false,
    schema: summarizeSchema(table.schema),
  };
}

export const catalogOperations = [
  {
    name: "list_datasets",
    title: "List datasets",
    description: "List the datasets of a project",
    parameters: {
      type: "object",
      properties: { project_id: PROJECT_PROPERTY, filter: { type: "string", description: "Label filter, e.g. labels.env:prod" }, ...PAGE_PROPERTIES },
    },
    run: async ({ client, args, signal }) => {
      const path = `/projects/${pathSegment(pickProjectId(args, client.settings))}/datasets`;
      const response = await client.request({ path, query: { maxResults: args.limit, pageToken: args.cursor, filter: args.filter }, signal });
      const datasets = (response.datasets ?? []).map((dataset) => ({ dataset_id: dataset.datasetReference?.datasetId ?? null, location: dataset.location ?? null, friendly_name: dataset.friendlyName ?? null, labels: dataset.labels ?? {} }));
      return { data: { datasets }, next_cursor: response.nextPageToken ?? null };
    },
  },
  {
    name: "list_tables",
    title: "List tables",
    description: "List the tables and views of a dataset",
    parameters: { type: "object", properties: { project_id: PROJECT_PROPERTY, dataset_id: DATASET_PROPERTY, ...PAGE_PROPERTIES }, required: ["dataset_id"] },
    run: async ({ client, args, signal }) => {
      const response = await client.request({ path: `${datasetPath(args, client.settings)}/tables`, query: { maxResults: args.limit, pageToken: args.cursor }, signal });
      const tables = (response.tables ?? []).map((table) => ({ table_id: table.tableReference?.tableId ?? null, type: table.type ?? null, created_at: toIsoTime(table.creationTime), partitioning: table.timePartitioning ?? table.rangePartitioning ?? null, clustering: table.clustering?.fields ?? null }));
      return { data: { tables, total_items: response.totalItems ?? null }, next_cursor: response.nextPageToken ?? null };
    },
  },
  {
    name: "get_table",
    title: "Get table schema",
    description: "Get a table's schema (nested fields flattened), row and byte counts, partitioning and clustering",
    parameters: {
      type: "object",
      properties: { project_id: PROJECT_PROPERTY, dataset_id: DATASET_PROPERTY, table_id: { type: "string", minLength: 1, description: "Table or view id" } },
      required: ["dataset_id", "table_id"],
    },
    run: async ({ client, args, signal }) => {
      const table = await client.request({ path: `${datasetPath(args, client.settings)}/tables/${pathSegment(args.table_id)}`, signal });
      return { data: summarizeTable(table) };
    },
  },
];
