/**
 * Ad account ids: the Marketing API addresses an ad account as `act_<id>`, but Ads Manager and `account_id` fields
 * show the bare number. Operations with an `ad_account_id` param accept both; a bare number gets the `act_` prefix.
 * Anything else is passed on unchanged (the layer encodes it as one path segment).
 */
const BARE_ACCOUNT_ID = /^\d+$/;

/**
 * Adds `act_` to a bare numeric ad account id.
 *
 * @param adAccountId - "act_123", "123" or anything else (any)
 * @returns "act_123" for "123", otherwise the value unchanged (any)
 *
 * @example
 * normalizeAdAccountId("1234567890"); // "act_1234567890"
 */
export function normalizeAdAccountId(adAccountId) {
  const trimmedId = typeof adAccountId === "string" ? adAccountId.trim() : adAccountId;
  return typeof trimmedId === "string" && BARE_ACCOUNT_ID.test(trimmedId) ? `act_${trimmedId}` : adAccountId;
}

/**
 * Returns the definition with `ad_account_id` arguments normalized before every operation runs.
 *
 * @param pluginDefinition - Definition (object)
 * @returns A new definition (object)
 */
export function normalizeAdAccountIds(pluginDefinition) {
  const wrapOperation = (operation) => {
    if (!operation.parameters?.properties?.ad_account_id) return operation;
    const run = (context) => {
      const args = context.args ?? {};
      if (args.ad_account_id === undefined) return operation.run(context);
      return operation.run({ ...context, args: { ...args, ad_account_id: normalizeAdAccountId(args.ad_account_id) } });
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
