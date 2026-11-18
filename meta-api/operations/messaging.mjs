/**
 * Messenger and Instagram Direct operations through the Page.
 *
 * Meta only allows free-form replies within 24 hours of the person's last
 * message; outside it, use messaging_type MESSAGE_TAG with tag HUMAN_AGENT
 * (needs the approved Human Agent permission).
 */
import { pathSegment } from "../lib/shared/path.mjs";
import { paginationProperties, rejectInput, resolveId, toPage } from "../lib/client.mjs";

const PAGE_ID_PROPERTY = { type: "string", description: "Page id (default: META_PAGE_ID)" };
const DEFAULT_CONVERSATION_FIELDS = "id,updated_time,participants,unread_count,message_count,snippet";
const DEFAULT_MESSAGE_FIELDS = "id,created_time,from,to,message,attachments";

const pageIdOf = (args, environment) => resolveId(args.page_id, environment, "META_PAGE_ID", "page_id");

export const messagingOperations = [
  {
    name: "list_conversations",
    title: "List conversations",
    description: "List the Page's Messenger or Instagram Direct conversations, optionally for one person.",
    parameters: {
      type: "object",
      properties: {
        page_id: PAGE_ID_PROPERTY,
        platform: { type: "string", enum: ["messenger", "instagram"], default: "messenger" },
        user_id: { type: "string", description: "Only the conversation with this PSID/IGSID" },
        fields: { type: "string", default: DEFAULT_CONVERSATION_FIELDS },
        ...paginationProperties(),
      },
    },
    run: async ({ client, args, environment, signal }) =>
      toPage(
        await client.request({
          path: `/${pathSegment(pageIdOf(args, environment))}/conversations`,
          query: { platform: args.platform, user_id: args.user_id, fields: args.fields, limit: args.limit, after: args.cursor },
          signal,
        }),
      ),
  },
  {
    name: "list_conversation_messages",
    title: "List conversation messages",
    description: "List messages in a Messenger or Instagram Direct conversation, newest first.",
    parameters: {
      type: "object",
      properties: { conversation_id: { type: "string" }, fields: { type: "string", default: DEFAULT_MESSAGE_FIELDS }, ...paginationProperties(20) },
      required: ["conversation_id"],
    },
    run: async ({ client, args, signal }) =>
      toPage(
        await client.request({
          path: `/${pathSegment(args.conversation_id)}/messages`,
          query: { fields: args.fields, limit: args.limit, after: args.cursor },
          signal,
        }),
      ),
  },
  {
    name: "send_message",
    title: "Send message",
    description:
      "Send a Messenger or Instagram Direct message from the Page to a PSID/IGSID. Free-form only within 24 h of their last message; otherwise use MESSAGE_TAG + HUMAN_AGENT.",
    parameters: {
      type: "object",
      properties: {
        page_id: PAGE_ID_PROPERTY,
        recipient_id: { type: "string", description: "PSID (Messenger) or IGSID (Instagram)" },
        text: { type: "string", description: "Message text" },
        attachment_url: { type: "string", description: "Public URL of an attachment (instead of text)" },
        attachment_type: { type: "string", enum: ["image", "video", "audio", "file"], default: "image" },
        messaging_type: { type: "string", enum: ["RESPONSE", "UPDATE", "MESSAGE_TAG"], default: "RESPONSE" },
        tag: { type: "string", enum: ["HUMAN_AGENT"], description: "Required with MESSAGE_TAG" },
        reply_to_message_id: { type: "string", description: "Quote-reply to this message id" },
      },
      required: ["recipient_id"],
    },
    run: async ({ client, args, environment, signal }) => ({
      data: await client.request({ method: "POST", path: `/${pathSegment(pageIdOf(args, environment))}/messages`, json: buildSendBody(args), signal }),
    }),
  },
];

function buildSendBody(args) {
  if (Boolean(args.text) === Boolean(args.attachment_url)) rejectInput("Pass exactly one of `text` or `attachment_url`");
  if (args.messaging_type === "MESSAGE_TAG" && !args.tag) rejectInput("messaging_type MESSAGE_TAG needs `tag` (HUMAN_AGENT)");
  const message = args.text
    ? { text: args.text }
    : { attachment: { type: args.attachment_type, payload: { url: args.attachment_url, is_reusable: false } } };
  const sendBody = { recipient: { id: args.recipient_id }, messaging_type: args.messaging_type, message };
  if (args.messaging_type === "MESSAGE_TAG") sendBody.tag = args.tag;
  if (args.reply_to_message_id) sendBody.reply_to = { mid: args.reply_to_message_id };
  return sendBody;
}
