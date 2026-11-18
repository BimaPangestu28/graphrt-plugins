/**
 * Parameter schemas shared by the state-store operations.
 */
import { DEFAULT_TTL_DAYS, MAX_ID_BYTES, MAX_IDS_PER_CALL, MAX_KEY_LENGTH, MAX_TTL_DAYS, MAX_TTL_SECONDS } from "../lib/limits.mjs";

export const NAMESPACE_PARAMETER = {
  type: "string",
  description: "Namespace (1-64 chars: a-z, 0-9, _ . -; e.g. `instagram-comments`). Each namespace is one file.",
};

export const IDS_PARAMETER = {
  type: "array",
  description: `Item ids (strings, or integers; at most ${MAX_IDS_PER_CALL}, each 1-${MAX_ID_BYTES} bytes as UTF-8). Duplicates are ignored.`,
  maxItems: MAX_IDS_PER_CALL,
};

export const TTL_DAYS_PARAMETER = {
  type: "integer",
  description: `Days an id stays seen after it was last marked (default ${DEFAULT_TTL_DAYS})`,
  minimum: 1,
  maximum: MAX_TTL_DAYS,
  default: DEFAULT_TTL_DAYS,
};

export const KEY_PARAMETER = { type: "string", description: `Key (1-${MAX_KEY_LENGTH} chars)` };

export const TTL_SECONDS_PARAMETER = {
  type: "integer",
  description: "Optional: the key expires this many seconds after it is written",
  minimum: 1,
  maximum: MAX_TTL_SECONDS,
};

export const LIMIT_PARAMETER = { type: "integer", description: "Page size (default 100, max 1000)", minimum: 1, maximum: 1000, default: 100 };
export const CURSOR_PARAMETER = { type: "string", description: "`next_cursor` from the previous page" };

/**
 * Takes one page from a sorted list of names, after the cursor (the last name of the previous page).
 *
 * @param sortedItems - Items sorted by `nameOf` (Array)
 * @param nameOf - `(item) => string` (function)
 * @param options.limit - Page size (number)
 * @param options.cursor - Last name of the previous page (string, optional)
 * @returns `{pageItems, nextCursor}` (object)
 */
export function paginateByName(sortedItems, nameOf, { limit, cursor }) {
  const remainingItems = cursor === undefined ? sortedItems : sortedItems.filter((item) => nameOf(item) > cursor);
  const pageItems = remainingItems.slice(0, limit);
  const nextCursor = remainingItems.length > limit ? nameOf(pageItems.at(-1)) : null;
  return { pageItems, nextCursor };
}
