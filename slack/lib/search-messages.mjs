/**
 * `search_messages`: Slack's search.messages only accepts a user token (xoxp-, scope `search:read`), while every
 * other operation uses the bot token, so this one operation is written by hand with its own client bound to
 * SLACK_USER_TOKEN (https://docs.slack.dev/reference/methods/search.messages).
 *
 * The same error mapping and redaction apply as for the declarative operations; tool results are truncated the
 * same way.
 */
import { createApiClient } from "./shared/api-client.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { createBodyErrorDetector, createErrorParser } from "./shared/rest-errors.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";
import { SLACK_ERRORS } from "./slack-errors.mjs";

export const USER_TOKEN_ENV = "SLACK_USER_TOKEN";
const SLACK_API_URL = "https://slack.com/api";

export const searchMessagesOperation = {
  name: "search_messages",
  title: "Search messages",
  description: `Search messages the user can see with Slack search syntax (in:#channel from:@user before:2026-01-01); needs a user token in ${USER_TOKEN_ENV}`,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, description: "Search query, e.g. \"deploy in:#ops after:2026-11-01\"" },
      sort: { type: "string", enum: ["score", "timestamp"], description: "Default score" },
      sort_dir: { type: "string", enum: ["asc", "desc"], description: "Default desc" },
      highlight: { type: "boolean", description: "Mark matches in the text" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Matches per page (sent as `count`)" },
      cursor: { type: "string", description: "next_cursor from the previous call, to get the next page" },
    },
    required: ["query"],
  },
  run: (context) => searchMessages(context),
};

// With SLACK_TOOL_TOKEN_SOURCE=context the end user's token (a user token) is used and SLACK_USER_TOKEN is hidden.
async function searchMessages({ client, args, environment, signal, source, contextAccessToken }) {
  const userToken = contextAccessToken ?? environment?.[USER_TOKEN_ENV]?.trim();
  if (!userToken) throw new PluginError(`search_messages needs a Slack user token: set ${USER_TOKEN_ENV} (xoxp-..., scope search:read) and allow it in permissions.env`, { kind: "auth_error" });
  const page = parsePage(args.cursor);
  const searchClient = createApiClient({
    baseUrl: SLACK_API_URL,
    authorize: ({ headers }) => {
      headers.authorization = `Bearer ${userToken}`;
      return [userToken];
    },
    parseError: createErrorParser(SLACK_ERRORS),
    detectBodyError: createBodyErrorDetector(SLACK_ERRORS),
    fetchImpl: client.fetchImpl,
  });
  const query = { query: args.query, count: args.limit, page, sort: args.sort, sort_dir: args.sort_dir, highlight: args.highlight };
  const body = await searchClient.request({ path: "/search.messages", query, signal, redactResponse: true });
  const result = { data: body.messages?.matches ?? [], next_cursor: findNextPage(body.messages?.paging, page) };
  return source === "tool" ? { ...result, data: truncateForTool(result.data, DEFAULT_TOOL_OUTPUT) } : result;
}

function parsePage(cursor) {
  if (cursor === undefined || cursor === "") return 1;
  const page = Number(cursor);
  if (!Number.isInteger(page) || page < 1) throw new PluginError("`cursor` must be a next_cursor value from an earlier call", { kind: "invalid_input" });
  return page;
}

function findNextPage(paging, page) {
  const totalPages = Number(paging?.pages);
  return Number.isFinite(totalPages) && page < totalPages ? String(page + 1) : null;
}
