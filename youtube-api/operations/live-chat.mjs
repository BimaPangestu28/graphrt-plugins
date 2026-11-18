/**
 * Live chat operations for the authenticated channel's broadcasts.
 */
import { rejectInput, rejectNotFound, requireFirstItem } from "../lib/client.mjs";

const LIVE_CHAT_TARGET_PROPERTIES = {
  live_chat_id: { type: "string", description: "Live chat id (or pass video_id)" },
  video_id: { type: "string", description: "Live video id; its active chat is looked up (1 extra quota unit)" },
};

async function resolveLiveChatId(client, args, signal) {
  if (Boolean(args.live_chat_id) === Boolean(args.video_id)) rejectInput("Pass exactly one of `live_chat_id` or `video_id`");
  if (args.live_chat_id) return args.live_chat_id;
  const videoResponse = await client.request({ path: "/videos", query: { part: "liveStreamingDetails", id: args.video_id }, signal });
  const video = requireFirstItem(videoResponse, `Video ${args.video_id} was not found`);
  const liveChatId = video.liveStreamingDetails?.activeLiveChatId;
  if (!liveChatId) rejectNotFound(`Video ${args.video_id} has no active live chat`);
  return liveChatId;
}

export const liveChatOperations = [
  {
    name: "list_live_chat_messages",
    title: "List YouTube live chat messages",
    description:
      "Read live chat messages. Pass next_cursor back to get only newer messages, waiting polling_interval_ms between calls. Costs 5 quota units per call.",
    parameters: {
      type: "object",
      properties: {
        ...LIVE_CHAT_TARGET_PROPERTIES,
        part: { type: "string", default: "id,snippet,authorDetails" },
        limit: { type: "integer", minimum: 200, maximum: 2000, default: 500, description: "Page size (200–2000)" },
        cursor: { type: "string", description: "next_cursor from a previous call" },
      },
    },
    run: async ({ client, args, signal }) => {
      const liveChatId = await resolveLiveChatId(client, args, signal);
      const query = { part: args.part, liveChatId, maxResults: args.limit, pageToken: args.cursor };
      const chatResponse = await client.request({ path: "/liveChat/messages", query, signal });
      const data = { messages: chatResponse?.items ?? [], polling_interval_ms: chatResponse?.pollingIntervalMillis ?? null, offline_at: chatResponse?.offlineAt ?? null };
      return { data, next_cursor: chatResponse?.nextPageToken ?? null };
    },
  },
  {
    name: "send_live_chat_message",
    title: "Send YouTube live chat message",
    description: "Post a text message to a live chat as the authenticated channel.",
    parameters: {
      type: "object",
      properties: { ...LIVE_CHAT_TARGET_PROPERTIES, text: { type: "string", minLength: 1, description: "Message text (max 200 characters)" } },
      required: ["text"],
    },
    run: async ({ client, args, signal }) => {
      const liveChatId = await resolveLiveChatId(client, args, signal);
      const snippet = { liveChatId, type: "textMessageEvent", textMessageDetails: { messageText: args.text } };
      return { data: await client.request({ method: "POST", path: "/liveChat/messages", query: { part: "snippet" }, json: { snippet }, signal }) };
    },
  },
];
