/**
 * Apollo shows at most 50,000 records per search: 500 pages of up to 100. Asking for a later page fails or returns
 * nothing, so paged searches refuse a cursor past page 500 and return no next_cursor after it.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const MAX_SEARCH_PAGES = 500;

/**
 * Wraps a paged search operation with the page cap.
 *
 * @param operation - Built operation whose cursor is a page number (object)
 * @returns Operation with the cap (object)
 */
export function capSearchPages(operation) {
  return {
    ...operation,
    run: async (context) => {
      const requestedPage = context.args.cursor === undefined ? 1 : Number(context.args.cursor);
      if (requestedPage > MAX_SEARCH_PAGES) {
        throw new PluginError(`Apollo returns at most ${MAX_SEARCH_PAGES} pages per search; narrow the filters instead of paging further`, { kind: "invalid_input" });
      }
      const result = await operation.run(context);
      const isPastLimit = result?.next_cursor !== null && result?.next_cursor !== undefined && Number(result.next_cursor) > MAX_SEARCH_PAGES;
      return isPastLimit ? { ...result, next_cursor: null } : result;
    },
  };
}
