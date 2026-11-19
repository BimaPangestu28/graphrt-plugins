/**
 * Supabase-specific wrappers around the declarative operations:
 * - applyRowQueries: turns structured `filters` into PostgREST's `and=(...)` value (postgrest-query.mjs), checks
 *   `order`, and refuses update/delete calls without a filter (PostgREST would change or delete every row).
 * - applyUpsertResolution: maps `duplicates: "merge" | "ignore"` to the Prefer header of an upsert.
 * - refuseToolOverwrites: agent tools may upload new objects but never overwrite one (`upsert: true` is node only).
 * Each wrapper validates before the declarative run, so a bad argument never reaches the API.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { buildFilterExpression, validateOrder } from "./postgrest-query.mjs";

const RETURN_PREFERENCE = "return=representation,missing=default";

/**
 * Wraps the run of the named operations of a definition.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationNames - Operations to wrap (string[])
 * @param transformContext - `(context, operationName) => context`, may throw (function)
 * @returns A new definition (object)
 */
function wrapOperations(pluginDefinition, operationNames, transformContext) {
  const wrapped = new Set(operationNames);
  const wrapOperation = (operation) => {
    if (!wrapped.has(operation.name)) return operation;
    return { ...operation, run: (context) => operation.run(transformContext(context, operation.name)) };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

/**
 * Encodes `filters` and checks `order` on row operations; operations in `filterRequired` need at least one filter.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param policy - `{operationNames: string[], filterRequired: string[]}` (object)
 * @returns A new definition (object)
 * @throws PluginError kind `invalid_input` - (at run time) bad filters or order, or no filter where one is required
 */
export function applyRowQueries(pluginDefinition, { operationNames, filterRequired }) {
  const requiring = new Set(filterRequired);
  return wrapOperations(pluginDefinition, operationNames, (context, operationName) => {
    const { filters, order } = context.args;
    if (requiring.has(operationName) && (!Array.isArray(filters) || filters.length === 0)) {
      throw new PluginError(`\`${operationName}\` needs at least one filter, so it never changes every row of the table`, { kind: "invalid_input" });
    }
    const args = { ...context.args, filters: Array.isArray(filters) ? buildFilterExpression(filters) : undefined };
    if (order !== undefined) args.order = validateOrder(order);
    return { ...context, args };
  });
}

/**
 * Maps an upsert's `duplicates` choice to its Prefer header value.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationName - The upsert operation (string)
 * @returns A new definition (object)
 */
export function applyUpsertResolution(pluginDefinition, operationName) {
  return wrapOperations(pluginDefinition, [operationName], (context) => {
    const resolution = context.args.duplicates === "ignore" ? "ignore-duplicates" : "merge-duplicates";
    return { ...context, args: { ...context.args, duplicates: `resolution=${resolution},${RETURN_PREFERENCE}` } };
  });
}

/**
 * Refuses `upsert: true` (overwrite an existing object) for agent tools.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationName - The upload operation (string)
 * @returns A new definition (object)
 * @throws PluginError kind `permission_denied` - (at run time) a tool asks to overwrite
 */
export function refuseToolOverwrites(pluginDefinition, operationName) {
  return wrapOperations(pluginDefinition, [operationName], (context) => {
    if (context.source === "tool" && context.args.upsert === true) {
      throw new PluginError(`\`${operationName}\` as an agent tool cannot overwrite existing objects (upsert); use a workflow node`, { kind: "permission_denied" });
    }
    return context;
  });
}

export { RETURN_PREFERENCE };
