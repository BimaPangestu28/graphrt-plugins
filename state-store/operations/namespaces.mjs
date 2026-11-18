/**
 * Housekeeping: list namespaces, and clear one (node only, so an agent cannot wipe seen ids).
 */
import { requireNamespace } from "../lib/limits.mjs";
import { formatTime } from "../lib/namespace-state.mjs";
import { CURSOR_PARAMETER, LIMIT_PARAMETER, NAMESPACE_PARAMETER, paginateByName } from "./common.mjs";

const listNamespacesOperation = {
  name: "list_namespaces",
  title: "List namespaces",
  description: "List the namespaces in the store (sorted) with their file size and last modification time.",
  parameters: { type: "object", properties: { limit: LIMIT_PARAMETER, cursor: CURSOR_PARAMETER } },
  run: async ({ client, args }) => {
    const namespaceFiles = await client.listNamespaceFiles();
    const { pageItems, nextCursor } = paginateByName(namespaceFiles, (item) => item.namespace, args);
    const namespaces = pageItems.map(({ namespace, bytes, modifiedAtMs }) => ({ namespace, bytes, modified_at: formatTime(modifiedAtMs) }));
    return { data: { namespaces }, next_cursor: nextCursor };
  },
};

const clearNamespaceOperation = {
  name: "clear_namespace",
  title: "Clear namespace",
  description: "Delete a namespace's file: all its seen ids and keys. Workflow node only (never an agent tool).",
  nodeOnly: true,
  parameters: { type: "object", properties: { namespace: NAMESPACE_PARAMETER }, required: ["namespace"] },
  run: async ({ client, args, signal }) => {
    const namespace = requireNamespace(args.namespace);
    return { data: { namespace, cleared: await client.removeNamespace(namespace, { signal }) } };
  },
};

export const namespaceOperations = [listNamespacesOperation, clearNamespaceOperation];
