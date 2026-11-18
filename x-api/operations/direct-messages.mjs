/**
 * Direct message operations: read DM events and send one-to-one or group DMs.
 */
import { rejectInput, toPage } from "../lib/client.mjs";
import { mergeQueryParams, numericIdProperty, paginationProperties, QUERY_PARAMS_PROPERTY, requireExactlyOne } from "../lib/parameters.mjs";

// One-to-one conversation ids look like "<user id>-<user id>"; group ids are numeric.
const CONVERSATION_ID_PROPERTY = { type: "string", pattern: "^[0-9]{1,19}(-[0-9]{1,19})?$", description: "DM conversation id" };
const PARTICIPANT_ID_PROPERTY = numericIdProperty("User id of the other participant (one-to-one conversation)");
const EVENT_TYPES_PROPERTY = {
  type: "string",
  enum: ["MessageCreate", "ParticipantsJoin", "ParticipantsLeave"],
  description: "Only return this event type",
};
const MESSAGE_PROPERTIES = {
  text: { type: "string", description: "Message text" },
  media_id: numericIdProperty("Media id from upload_media (media_category dm_image)"),
};

function buildMessage(args) {
  if (!args.text && !args.media_id) rejectInput("Pass `text`, `media_id` or both");
  return { text: args.text, attachments: args.media_id ? [{ media_id: args.media_id }] : undefined };
}

function dmEventsQuery(args) {
  return mergeQueryParams(args.query_params, { max_results: args.limit, pagination_token: args.cursor, event_types: args.event_types });
}

function conversationPath(args) {
  return args.conversation_id ? `/2/dm_conversations/${args.conversation_id}` : `/2/dm_conversations/with/${args.participant_id}`;
}

export const directMessageOperations = [
  {
    name: "list_dm_events",
    title: "List X DM events",
    description: "List recent direct message events across all of the authenticated user's conversations.",
    parameters: {
      type: "object",
      properties: { event_types: EVENT_TYPES_PROPERTY, query_params: QUERY_PARAMS_PROPERTY, ...paginationProperties({ minimum: 1 }) },
    },
    run: async ({ client, args, signal }) => toPage(await client.request({ path: "/2/dm_events", query: dmEventsQuery(args), signal })),
  },
  {
    name: "list_dm_conversation_events",
    title: "List X DM conversation",
    description: "List direct message events in one conversation, by conversation_id or by the other participant's user id.",
    parameters: {
      type: "object",
      properties: {
        conversation_id: CONVERSATION_ID_PROPERTY,
        participant_id: PARTICIPANT_ID_PROPERTY,
        event_types: EVENT_TYPES_PROPERTY,
        query_params: QUERY_PARAMS_PROPERTY,
        ...paginationProperties({ minimum: 1 }),
      },
    },
    run: async ({ client, args, signal }) => {
      requireExactlyOne(args, "conversation_id", "participant_id");
      return toPage(await client.request({ path: `${conversationPath(args)}/dm_events`, query: dmEventsQuery(args), signal }));
    },
  },
  {
    name: "send_dm",
    title: "Send X DM",
    description: "Send a direct message to a user (participant_id) or into an existing conversation (conversation_id).",
    parameters: {
      type: "object",
      properties: { participant_id: PARTICIPANT_ID_PROPERTY, conversation_id: CONVERSATION_ID_PROPERTY, ...MESSAGE_PROPERTIES },
    },
    run: async ({ client, args, signal }) => {
      requireExactlyOne(args, "participant_id", "conversation_id");
      const message = buildMessage(args);
      return { data: await client.request({ method: "POST", path: `${conversationPath(args)}/messages`, json: message, signal }) };
    },
  },
  {
    name: "create_group_dm",
    title: "Create X group DM",
    description: "Start a group DM conversation with 2-49 other users and send the first message.",
    parameters: {
      type: "object",
      properties: {
        participant_ids: { type: "array", items: { type: "string", pattern: "^[0-9]{1,19}$" }, maxItems: 49, description: "User ids of the other members (2-49)" },
        ...MESSAGE_PROPERTIES,
      },
      required: ["participant_ids"],
    },
    run: async ({ client, args, signal }) => {
      if (args.participant_ids.length < 2) rejectInput("`participant_ids` needs at least 2 users");
      const json = { conversation_type: "Group", participant_ids: args.participant_ids, message: buildMessage(args) };
      return { data: await client.request({ method: "POST", path: "/2/dm_conversations", json, signal }) };
    },
  },
];
