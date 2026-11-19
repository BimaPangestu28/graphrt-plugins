/**
 * Discovery operations: list_databases and list_collections.
 */
import { collectDocuments } from "../lib/result-limits.mjs";
import { isToolDatabaseAllowed } from "../lib/query-guard.mjs";
import { DATABASE_PROPERTY, MAX_DOCUMENTS, resolveNamespace } from "./common.mjs";

const listDatabases = {
  name: "list_databases",
  title: "List databases",
  description: "List the databases the connection's user may see, with their size on disk. Agent tool calls only see the databases they may use.",
  parameters: { type: "object", properties: {} },
  run: ({ client, signal, source }) =>
    client.withDatabase(
      null,
      async ({ mongoClient }) => {
        const listing = await mongoClient.db("admin").admin().listDatabases({ nameOnly: false, authorizedDatabases: true, signal });
        const visible = (listing.databases ?? []).filter((entry) => source !== "tool" || isToolDatabaseAllowed(client.settings, entry.name));
        const databases = visible.map((entry) => ({
          name: entry.name,
          size_on_disk: typeof entry.sizeOnDisk === "number" ? entry.sizeOnDisk : Number(entry.sizeOnDisk ?? 0),
          empty: Boolean(entry.empty),
        }));
        return { data: { databases, count: databases.length } };
      },
      { signal },
    ),
};

const listCollections = {
  name: "list_collections",
  title: "List collections",
  description: "List the collections and views in a database (at most 1000 names).",
  parameters: { type: "object", properties: { database: DATABASE_PROPERTY } },
  run: (context) => {
    const { databaseName } = resolveNamespace(context, { needsCollection: false });
    return context.client.withDatabase(
      databaseName,
      async ({ database }) => {
        const cursor = database.listCollections({}, { nameOnly: true, authorizedCollections: true, signal: context.signal });
        const page = await collectDocuments(cursor, {
          maxDocuments: MAX_DOCUMENTS,
          maxBytes: context.client.settings.maxResultBytes,
          encode: (entry) => ({ name: entry.name, type: entry.type ?? "collection" }),
        });
        const truncated = page.truncated || page.hasMore;
        return { data: { database: databaseName, collections: page.documents, count: page.documents.length, truncated } };
      },
      { signal: context.signal },
    );
  },
};

export const listingOperations = [listDatabases, listCollections];
