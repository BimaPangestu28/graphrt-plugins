/**
 * Table operations: list tables (paginated) and describe one table.
 */
import { checkTableName, TABLE_PROPERTY } from "./request-parts.mjs";

function summarizeIndexes(indexes) {
  return (indexes ?? []).map((index) => ({ name: index.IndexName, key_schema: index.KeySchema, projection: index.Projection?.ProjectionType ?? null, status: index.IndexStatus ?? null }));
}

/**
 * Condenses a DescribeTable `Table` to the fields a workflow or agent needs.
 *
 * @param table - DescribeTable response `Table` (object)
 * @returns Summary with name, status, keys, attribute types, counts, billing and indexes (object)
 */
export function summarizeTable(table = {}) {
  return {
    name: table.TableName ?? null,
    arn: table.TableArn ?? null,
    status: table.TableStatus ?? null,
    key_schema: table.KeySchema ?? [],
    attribute_definitions: table.AttributeDefinitions ?? [],
    item_count: table.ItemCount ?? null,
    size_bytes: table.TableSizeBytes ?? null,
    billing_mode: table.BillingModeSummary?.BillingMode ?? (table.ProvisionedThroughput ? "PROVISIONED" : null),
    created_at: typeof table.CreationDateTime === "number" ? new Date(table.CreationDateTime * 1000).toISOString() : null,
    global_secondary_indexes: summarizeIndexes(table.GlobalSecondaryIndexes),
    local_secondary_indexes: summarizeIndexes(table.LocalSecondaryIndexes),
    stream: table.StreamSpecification ?? null,
    deletion_protection: table.DeletionProtectionEnabled ?? null,
  };
}

export const tableOperations = [
  {
    name: "list_tables",
    title: "List tables",
    description: "List DynamoDB table names in the region, paginated with next_cursor",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 100, description: "Maximum table names per page" },
        cursor: { type: "string", description: "next_cursor from the previous call" },
      },
    },
    run: async ({ client, args, signal, source }) => {
      const response = await client.call("ListTables", { Limit: args.limit, ExclusiveStartTableName: args.cursor }, { signal, isRead: true });
      const allowedTables = source === "tool" ? client.settings.allowedTables : null;
      const tableNames = (response.TableNames ?? []).filter((tableName) => !allowedTables || allowedTables.has(tableName));
      return { data: { table_names: tableNames }, next_cursor: response.LastEvaluatedTableName ?? null };
    },
  },
  {
    name: "describe_table",
    title: "Describe table",
    description: "Describe a table: key schema, attribute types, item count, size, billing mode and indexes",
    parameters: { type: "object", properties: { table: TABLE_PROPERTY }, required: ["table"] },
    run: async ({ client, args, signal }) => {
      const response = await client.call("DescribeTable", { TableName: checkTableName(args.table) }, { signal, isRead: true });
      return { data: summarizeTable(response.Table) };
    },
  },
];
