/**
 * Twilio list pagination (https://www.twilio.com/docs/usage/twilios-response#response-formats-list-paging).
 * List responses carry `next_page_uri`, a path relative to api.twilio.com with `Page` and `PageToken` in its
 * query. The declarative layer only follows absolute next URLs, so the list operations declare hidden `page` and
 * `page_token` params and this wrapper turns them into one opaque `cursor` ("<Page>:<PageToken>") and returns the
 * list items as `data`.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";

const CURSOR_PATTERN = /^(\d{1,9}):([A-Za-z0-9_-]{1,200})$/;
const TWILIO_ORIGIN = "https://api.twilio.com";

/**
 * Reads the next cursor from a Twilio list response.
 *
 * @param nextPageUri - `next_page_uri` (string | null)
 * @returns "<Page>:<PageToken>", or null on the last page (string | null)
 *
 * @example
 * encodeTwilioCursor("/2010-04-01/Accounts/AC1/Messages.json?PageSize=50&Page=1&PageToken=PAabc"); // "1:PAabc"
 */
export function encodeTwilioCursor(nextPageUri) {
  if (typeof nextPageUri !== "string" || nextPageUri === "") return null;
  const nextUrl = new URL(nextPageUri, TWILIO_ORIGIN);
  const page = nextUrl.searchParams.get("Page");
  const pageToken = nextUrl.searchParams.get("PageToken");
  const cursor = `${page}:${pageToken}`;
  return page !== null && pageToken !== null && CURSOR_PATTERN.test(cursor) ? cursor : null;
}

/**
 * Turns a cursor back into the `page` and `page_token` arguments.
 *
 * @param cursor - From encodeTwilioCursor (string)
 * @returns `{page, page_token}` (object)
 * @throws PluginError kind `invalid_input` - Not a cursor from an earlier call
 */
export function decodeTwilioCursor(cursor) {
  const cursorMatch = CURSOR_PATTERN.exec(String(cursor));
  if (!cursorMatch) throw new PluginError("`cursor` must be the next_cursor returned by an earlier call", { kind: "invalid_input" });
  return { page: Number(cursorMatch[1]), page_token: cursorMatch[2] };
}

/**
 * Wraps a Twilio list operation (declared with `page`/`page_token` params and `toolOutput: false`).
 *
 * @param operation - Generated list operation (object)
 * @param listKey - Key of the items in the response, e.g. "messages" (string)
 * @returns Operation with `cursor` instead of page/page_token, returning the items and next_cursor (object)
 */
export function withTwilioPaging(operation, listKey) {
  const { page, page_token: pageToken, ...visibleProperties } = operation.parameters.properties;
  const cursorProperty = { type: "string", description: "next_cursor from the previous call, to get the next page" };
  return {
    ...operation,
    parameters: { ...operation.parameters, properties: { ...visibleProperties, cursor: cursorProperty } },
    run: async (context) => {
      // page/page_token are never taken from callers: only a validated cursor sets them.
      const { cursor, page: ignoredPage, page_token: ignoredPageToken, ...listArgs } = context.args;
      const pageArgs = cursor === undefined ? {} : decodeTwilioCursor(cursor);
      const result = await operation.run({ ...context, args: { ...listArgs, ...pageArgs } });
      const items = result.data?.[listKey] ?? [];
      return { data: context.source === "tool" ? truncateForTool(items, DEFAULT_TOOL_OUTPUT) : items, next_cursor: encodeTwilioCursor(result.data?.next_page_uri) };
    },
  };
}
