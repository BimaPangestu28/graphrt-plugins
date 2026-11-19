/**
 * Sentry pagination fix: Sentry's Link header always has rel="next", and marks the end with results="false" on it.
 * The declarative layer follows rel="next" only, so a listing would never end. Ending the listing on an empty page
 * costs at most one extra (empty) call and needs no access to the response headers.
 */

/**
 * Returns the definition with next_cursor set to null whenever a paginated operation returns an empty page.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @returns A new definition; restSpec and unpaginated operations are unchanged (object)
 *
 * @example
 * export const pluginDefinition = endPaginationOnEmptyPage(defineRestPlugin({...}));
 */
export function endPaginationOnEmptyPage(pluginDefinition) {
  const paginatedNames = new Set(pluginDefinition.restSpec.operations.filter((operation) => operation.pagination).map((operation) => operation.name));
  const wrapOperation = (operation) => {
    if (!paginatedNames.has(operation.name)) return operation;
    return { ...operation, run: async (context) => clearCursorOnEmptyPage(await operation.run(context)) };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

function clearCursorOnEmptyPage(result) {
  const pageIsEmpty = Array.isArray(result?.data) && result.data.length === 0;
  return pageIsEmpty ? { ...result, next_cursor: null } : result;
}
