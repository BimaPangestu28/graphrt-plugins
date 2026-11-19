/**
 * Document operations: get, list, run_query (reads); create and update (agent tools opt-in); delete (node only).
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { assertToolWriteAllowed } from "../lib/client.mjs";
import { checkCollectionPath, checkDocumentPath } from "../lib/document-paths.mjs";
import { decodeDocument, encodeFields, quoteFieldPath } from "../lib/firestore-values.mjs";
import { capDocument, capDocuments } from "../lib/result-cap.mjs";
import { buildStructuredQuery } from "../lib/structured-query.mjs";

const VALUE_FORMAT_PROPERTY = {
  type: "string",
  enum: ["plain", "typed"],
  default: "plain",
  description: "plain: JSON values (timestamps etc. as {\"timestampValue\": \"...\"}); typed: Firestore Value JSON such as {\"stringValue\": \"x\"}",
};
const DOCUMENT_PATH_PROPERTY = { type: "string", minLength: 1, description: "Document path, e.g. users/u1 or users/u1/orders/o1" };
const MASK_PROPERTY = { type: "array", items: { type: "string" }, maxItems: 100, description: "Only return these field paths, e.g. [\"name\", \"address.city\"]" };
const FIELDS_PROPERTY = { type: "object", description: "Document fields, e.g. {\"name\": \"Ana\", \"visits\": 3, \"joined\": {\"timestampValue\": \"2026-11-19T10:00:00Z\"}}" };
const MAX_QUERY_LIMIT = 1000;

// Repeated query parameters (mask.fieldPaths=a&mask.fieldPaths=b), which the shared client's `query` cannot express.
function repeatedQuery(entries) {
  const queryText = entries.filter(([, value]) => value !== undefined).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
  return queryText ? `?${queryText}` : "";
}

function maskEntries(mask) {
  return (mask ?? []).map((fieldPath) => ["mask.fieldPaths", fieldPath]);
}

function preconditionEntries(mustExist) {
  return mustExist === undefined ? [] : [["currentDocument.exists", String(mustExist)]];
}

// A create whose outcome is unknown is not retried (an auto id would create a duplicate); say how to check.
async function withCreateOutcomeHint(createPromise, args) {
  try {
    return await createPromise;
  } catch (createError) {
    if (!(createError instanceof PluginError) || !createError.message.includes("outcome unknown")) throw createError;
    const checkHint = args.document_id ? `get_document ${args.collection_path}/${args.document_id}` : `list_documents or run_query on ${args.collection_path}`;
    throw new PluginError(`${createError.message}. To check: ${checkHint}`, { kind: createError.kind, retryable: false });
  }
}

async function updateDocument({ client, args, signal }) {
  const fields = encodeFields(args.fields, args.value_format);
  const deleteFields = args.delete_fields ?? [];
  if (!args.merge && deleteFields.length > 0) throw new PluginError("`delete_fields` needs merge true (a full replace already drops missing fields)", { kind: "invalid_input" });
  const maskFieldNames = args.merge ? [...Object.keys(args.fields), ...deleteFields] : [];
  if (args.merge && maskFieldNames.length === 0) throw new PluginError("Nothing to update: pass `fields` or `delete_fields`", { kind: "invalid_input" });
  const entries = [...maskFieldNames.map((fieldName) => ["updateMask.fieldPaths", quoteFieldPath(fieldName)]), ...preconditionEntries(args.must_exist ? true : undefined)];
  // Writing the same fields again gives the same document, so a retry after an unknown outcome is safe.
  const document = await client.request({ method: "PATCH", path: `/documents/${checkDocumentPath(args.path)}${repeatedQuery(entries)}`, json: { fields }, signal, idempotent: true });
  return decodeDocument(document, args.value_format);
}

export const documentOperations = [
  {
    name: "get_document",
    title: "Get document",
    description: "Read one document by path (fields decoded to plain JSON)",
    parameters: { type: "object", properties: { path: DOCUMENT_PATH_PROPERTY, mask: MASK_PROPERTY, value_format: VALUE_FORMAT_PROPERTY }, required: ["path"] },
    run: async ({ client, args, signal }) => {
      const document = await client.request({ path: `/documents/${checkDocumentPath(args.path)}${repeatedQuery(maskEntries(args.mask))}`, signal });
      return { data: capDocument(decodeDocument(document, args.value_format), client.settings.maxResultBytes) };
    },
  },
  {
    name: "list_documents",
    title: "List documents",
    description: "List the documents of a collection (or subcollection), paginated with next_cursor",
    parameters: {
      type: "object",
      properties: {
        collection_path: { type: "string", minLength: 1, description: "Collection path, e.g. users or users/u1/orders" },
        order_by: { type: "string", description: "e.g. \"created desc\"" },
        mask: MASK_PROPERTY,
        limit: { type: "integer", minimum: 1, maximum: 300, default: 50, description: "Documents per page" },
        cursor: { type: "string", description: "next_cursor from the previous call" },
        value_format: VALUE_FORMAT_PROPERTY,
      },
      required: ["collection_path"],
    },
    run: async ({ client, args, signal }) => {
      const entries = [["pageSize", String(args.limit)], ["pageToken", args.cursor], ["orderBy", args.order_by], ...maskEntries(args.mask)];
      const response = await client.request({ path: `/documents/${checkCollectionPath(args.collection_path)}${repeatedQuery(entries)}`, signal });
      const capped = capDocuments((response.documents ?? []).map((document) => decodeDocument(document, args.value_format)), client.settings.maxResultBytes);
      return { data: { documents: capped.documents, truncated: capped.truncated, omitted_count: capped.omittedCount }, next_cursor: response.nextPageToken ?? null };
    },
  },
  {
    name: "run_query",
    title: "Run query",
    description: "Query a collection (or a collection group) with where filters (AND), order_by, select, limit and offset",
    parameters: {
      type: "object",
      properties: {
        collection_id: { type: "string", minLength: 1, description: "Collection id to query, e.g. orders" },
        parent_path: { type: "string", description: "Document path the collection lives under, e.g. users/u1 (default: the database root)" },
        all_descendants: { type: "boolean", default: false, description: "Collection group query: every collection with this id at any depth under the parent" },
        where: { type: "array", items: { type: "object" }, maxItems: 30, description: "Filters, e.g. [{\"field\": \"status\", \"op\": \"==\", \"value\": \"open\"}, {\"field\": \"total\", \"op\": \">=\", \"value\": 100}]" },
        order_by: { type: "array", items: { type: "string" }, description: "e.g. [\"total desc\", \"created\"]" },
        select: MASK_PROPERTY,
        limit: { type: "integer", minimum: 1, maximum: MAX_QUERY_LIMIT, default: 100, description: "Maximum documents" },
        offset: { type: "integer", minimum: 0, maximum: 10000, description: "Skip this many results (skipped documents are still billed as reads)" },
        value_format: VALUE_FORMAT_PROPERTY,
      },
      required: ["collection_id"],
    },
    run: async ({ client, args, signal }) => {
      const parentPath = args.parent_path === undefined ? "/documents" : `/documents/${checkDocumentPath(args.parent_path, "parent_path")}`;
      const results = await client.request({ method: "POST", path: `${parentPath}:runQuery`, json: { structuredQuery: buildStructuredQuery(args) }, signal, idempotent: true });
      const documents = (Array.isArray(results) ? results : []).filter((result) => result.document).map((result) => decodeDocument(result.document, args.value_format));
      const capped = capDocuments(documents, client.settings.maxResultBytes);
      return { data: { documents: capped.documents, count: capped.documents.length, truncated: capped.truncated, omitted_count: capped.omittedCount } };
    },
  },
  {
    name: "create_document",
    title: "Create document",
    description: "Create a document in a collection (with document_id, or an auto id); fails if it already exists (as an agent tool only when FIRESTORE_TOOL_ALLOW_WRITES=1)",
    parameters: {
      type: "object",
      properties: {
        collection_path: { type: "string", minLength: 1, description: "Collection path, e.g. users or users/u1/orders" },
        document_id: { type: "string", description: "Document id (default: an auto id; with an id a retry cannot create a duplicate)" },
        fields: FIELDS_PROPERTY,
        value_format: VALUE_FORMAT_PROPERTY,
      },
      required: ["collection_path", "fields"],
    },
    run: async (context) => {
      const { client, args, signal } = context;
      assertToolWriteAllowed(context, "create_document");
      if (args.document_id !== undefined && (args.document_id.includes("/") || args.document_id === "." || args.document_id === "..")) {
        throw new PluginError("`document_id` must be a single id without slashes", { kind: "invalid_input" });
      }
      const path = `/documents/${checkCollectionPath(args.collection_path)}${repeatedQuery([["documentId", args.document_id]])}`;
      const document = await withCreateOutcomeHint(client.request({ method: "POST", path, json: { fields: encodeFields(args.fields, args.value_format) }, signal }), args);
      return { data: decodeDocument(document, args.value_format) };
    },
  },
  {
    name: "update_document",
    title: "Update document",
    description: "Update a document: merge (default) sets only the given top-level fields and removes delete_fields; merge false replaces the whole document (as an agent tool only when FIRESTORE_TOOL_ALLOW_WRITES=1)",
    parameters: {
      type: "object",
      properties: {
        path: DOCUMENT_PATH_PROPERTY,
        fields: FIELDS_PROPERTY,
        merge: { type: "boolean", default: true, description: "true: only the given top-level fields change; false: the document becomes exactly `fields`" },
        delete_fields: { type: "array", items: { type: "string" }, maxItems: 100, description: "Top-level fields to remove (with merge)" },
        must_exist: { type: "boolean", default: true, description: "Fail with not found instead of creating the document" },
        value_format: VALUE_FORMAT_PROPERTY,
      },
      required: ["path", "fields"],
    },
    run: async (context) => {
      assertToolWriteAllowed(context, "update_document");
      return { data: await updateDocument(context) };
    },
  },
  {
    name: "delete_document",
    title: "Delete document",
    description: "Delete a document (its subcollections are not deleted); workflow nodes only",
    nodeOnly: true,
    parameters: {
      type: "object",
      properties: { path: DOCUMENT_PATH_PROPERTY, must_exist: { type: "boolean", default: false, description: "Fail with not found when the document does not exist" } },
      required: ["path"],
    },
    run: async ({ client, args, signal }) => {
      const query = repeatedQuery(preconditionEntries(args.must_exist ? true : undefined));
      // With must_exist, a retry after an unknown outcome could report not_found for a delete that worked: no retries then.
      await client.request({ method: "DELETE", path: `/documents/${checkDocumentPath(args.path)}${query}`, signal, idempotent: !args.must_exist });
      return { data: { deleted: true, path: args.path } };
    },
  },
];
