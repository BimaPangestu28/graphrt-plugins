/**
 * Shopify Admin GraphQL mutation helpers around a declarative definition:
 * - checkUserErrors: a mutation that Shopify rejects answers HTTP 200 with `userErrors` (or
 *   `orderCancelUserErrors`) in its payload; that is a definite "not applied", so it becomes an invalid_input error
 *   instead of a success with an error list inside.
 * - addIdempotencyKeys: since API 2026-04, `inventoryAdjustQuantities` and `refundCreate` need an
 *   `@idempotent(key:)` directive. The key is a GraphQL variable, not a header, so the layer's
 *   idempotencyKeyHeader cannot send it; this wrapper fills a fresh UUID unless the caller passes one (pass the
 *   same key to retry a call whose outcome is unknown).
 */
import { randomUUID } from "node:crypto";
import { PluginError } from "./shared/graphrt-plugin.mjs";

const USER_ERROR_FIELDS = ["userErrors", "orderCancelUserErrors"];

/**
 * Collects the messages of a mutation payload's user errors.
 *
 * @param payload - Mutation payload, e.g. `{product, userErrors: [{field, message}]}` (object)
 * @returns Messages, empty when the mutation was applied (string[])
 *
 * @example
 * listUserErrors({ userErrors: [{ field: ["title"], message: "Title can't be blank" }] }); // ["title: Title can't be blank"]
 */
export function listUserErrors(payload) {
  if (!payload || typeof payload !== "object") return [];
  return USER_ERROR_FIELDS.flatMap((fieldName) => (Array.isArray(payload[fieldName]) ? payload[fieldName] : [])).map((userError) => {
    const field = Array.isArray(userError?.field) ? userError.field.join(".") : userError?.field;
    return field ? `${field}: ${userError?.message}` : String(userError?.message);
  });
}

/**
 * Returns the definition with user errors of `operationNames` turned into PluginErrors.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationNames - Mutations whose `data` is the mutation payload (string[])
 * @returns A new definition (object)
 */
export function checkUserErrors(pluginDefinition, operationNames) {
  const checked = new Set(operationNames);
  const wrapOperation = (operation) => {
    if (!checked.has(operation.name)) return operation;
    const run = async (context) => {
      const result = await operation.run(context);
      const messages = listUserErrors(result?.data);
      if (messages.length > 0) throw new PluginError(`Shopify rejected ${operation.name} (nothing was changed): ${messages.join("; ")}`, { kind: "invalid_input" });
      return result;
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

/**
 * Returns the definition with `idempotency_key` filled with a fresh UUID on `operationNames` when not given. The key
 * used is returned as `data.idempotency_key` and named in every error, so a call whose outcome is unknown can be
 * retried with the same key.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationNames - Mutations with an `idempotency_key` param (string[])
 * @returns A new definition (object)
 */
export function addIdempotencyKeys(pluginDefinition, operationNames) {
  const keyed = new Set(operationNames);
  const wrapOperation = (operation) => {
    if (!keyed.has(operation.name)) return operation;
    const run = async (context) => {
      const givenKey = typeof context.args?.idempotency_key === "string" ? context.args.idempotency_key.trim() : "";
      const idempotencyKey = givenKey || randomUUID();
      try {
        const result = await operation.run({ ...context, args: { ...context.args, idempotency_key: idempotencyKey } });
        return { ...result, data: { ...(result?.data ?? {}), idempotency_key: idempotencyKey } };
      } catch (runError) {
        throw describeKeyedError(runError, idempotencyKey);
      }
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

function describeKeyedError(runError, idempotencyKey) {
  if (!(runError instanceof PluginError)) return runError;
  const note = ` (idempotency_key ${idempotencyKey}: pass it again to retry this exact change safely)`;
  return new PluginError(`${runError.message}${note}`, { kind: runError.kind, retryable: runError.retryable, retryAfterMs: runError.retryAfterMs });
}

/**
 * Checks inventoryAdjustQuantities changes: every change states `changeFromQuantity` (null allowed: "do not compare"),
 * and states other than "available" need a `ledgerDocumentUri` on every change (Shopify requires it for them).
 *
 * @param args - adjust_inventory arguments (object)
 * @throws PluginError kind `invalid_input` - A change misses one of them
 */
export function assertInventoryChanges(args) {
  const changes = Array.isArray(args.changes) ? args.changes : [];
  if (changes.length === 0) throw new PluginError("`changes` needs at least one change", { kind: "invalid_input" });
  changes.forEach((change, index) => {
    if (!change || typeof change !== "object" || !Object.hasOwn(change, "changeFromQuantity")) {
      throw new PluginError(`changes[${index}] needs changeFromQuantity (the quantity you expect now, or null to skip the check)`, { kind: "invalid_input" });
    }
    const quantityName = args.quantity_name ?? "available";
    if (quantityName !== "available" && !change.ledgerDocumentUri) {
      throw new PluginError(`changes[${index}] needs ledgerDocumentUri when adjusting \`${quantityName}\``, { kind: "invalid_input" });
    }
  });
}

/**
 * Returns the definition with assertInventoryChanges on `adjust_inventory`.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns A new definition (object)
 */
export function checkInventoryChanges(pluginDefinition) {
  const wrapOperation = (operation) => {
    if (operation.name !== "adjust_inventory") return operation;
    return { ...operation, run: (context) => (assertInventoryChanges(context.args ?? {}), operation.run(context)) };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
