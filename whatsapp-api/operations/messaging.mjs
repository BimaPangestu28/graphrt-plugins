/**
 * Message sending operations: POST /{phone-number-id}/messages.
 *
 * WhatsApp rules: the first message to a person (and any message more than
 * 24 h after their last message) must be an approved template; free-form
 * messages are only allowed inside that 24 h window. Recipients must have
 * opted in. Sends are POSTs, so the shared client never retries them after
 * an unknown outcome.
 */
import { pathSegment } from "../lib/shared/path.mjs";
import { checkMaxLength, rejectInput, resolveId } from "../lib/client.mjs";
import { buildButtonsInteractive, buildListInteractive } from "../lib/interactive.mjs";
import { normalizePhoneNumber } from "../lib/phone-number.mjs";

const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"];
const CAPTIONED_MEDIA_TYPES = new Set(["image", "video", "document"]);
const TEXT_BODY_LIMIT = 4096;

export const PHONE_NUMBER_ID_PROPERTY = { type: "string", description: "Sending phone number id (default: WHATSAPP_PHONE_NUMBER_ID)" };
const TO_PROPERTY = { type: "string", description: 'Recipient in international E.164 format, e.g. "6281234567890" or "+62 812-3456-7890"' };
const REPLY_TO_PROPERTY = { type: "string", description: "Quote-reply to this message id (wamid...)" };

/**
 * Resolves the sending phone number id from the arguments or WHATSAPP_PHONE_NUMBER_ID.
 *
 * @param args - Operation arguments (object)
 * @param environment - Environment variables (object)
 * @returns Phone number id (string)
 */
export const phoneNumberIdOf = (args, environment) => resolveId(args.phone_number_id, environment, "WHATSAPP_PHONE_NUMBER_ID", "phone_number_id");

function buildEnvelope(args, messageType, messageContent) {
  const envelope = { messaging_product: "whatsapp", recipient_type: "individual", to: normalizePhoneNumber(args.to, "to"), type: messageType };
  if (args.reply_to_message_id) envelope.context = { message_id: args.reply_to_message_id };
  return { ...envelope, [messageType]: messageContent };
}

function sendMessageRequest(buildMessage) {
  return async ({ client, args, environment, signal }) => {
    const messageBody = buildMessage(args);
    const path = `/${pathSegment(phoneNumberIdOf(args, environment))}/messages`;
    return { data: await client.request({ method: "POST", path, json: messageBody, signal }) };
  };
}

function sendOperation({ name, title, description, properties, required, buildMessage }) {
  return {
    name,
    title,
    description,
    parameters: { type: "object", properties: { to: TO_PROPERTY, ...properties, phone_number_id: PHONE_NUMBER_ID_PROPERTY }, required: ["to", ...required] },
    run: sendMessageRequest(buildMessage),
  };
}

function buildTextMessage(args) {
  checkMaxLength(args.body, TEXT_BODY_LIMIT, "body");
  return buildEnvelope(args, "text", { body: args.body, preview_url: args.preview_url });
}

function buildTemplateMessage(args) {
  const template = { name: args.name, language: { code: args.language } };
  if (args.components?.length) template.components = args.components;
  return buildEnvelope(args, "template", template);
}

function buildMediaMessage(args) {
  if (Boolean(args.link) === Boolean(args.media_id)) rejectInput("Pass exactly one of `link` or `media_id`");
  if (args.link && !/^https:\/\//i.test(args.link)) rejectInput("`link` must be an https URL");
  if (args.caption && !CAPTIONED_MEDIA_TYPES.has(args.media_type)) rejectInput(`\`caption\` is only allowed for image, video and document, not ${args.media_type}`);
  if (args.filename && args.media_type !== "document") rejectInput("`filename` is only allowed for documents");
  const mediaObject = args.media_id ? { id: args.media_id } : { link: args.link };
  if (args.caption) mediaObject.caption = args.caption;
  if (args.filename) mediaObject.filename = args.filename;
  return buildEnvelope(args, args.media_type, mediaObject);
}

function buildLocationMessage(args) {
  if (args.latitude < -90 || args.latitude > 90) rejectInput("`latitude` must be between -90 and 90");
  if (args.longitude < -180 || args.longitude > 180) rejectInput("`longitude` must be between -180 and 180");
  const location = { latitude: args.latitude, longitude: args.longitude };
  if (args.name) location.name = args.name;
  if (args.address) location.address = args.address;
  return buildEnvelope(args, "location", location);
}

function buildReactionMessage(args) {
  if (!args.emoji && !args.remove) rejectInput("Pass `emoji`, or `remove: true` to remove your reaction");
  return buildEnvelope({ to: args.to }, "reaction", { message_id: args.message_id, emoji: args.remove ? "" : args.emoji });
}

export const messagingOperations = [
  sendOperation({
    name: "send_text",
    title: "Send WhatsApp text",
    description: "Send a text message. Only allowed within 24 h of the recipient's last message; otherwise use send_template.",
    properties: {
      body: { type: "string", description: `Message text (up to ${TEXT_BODY_LIMIT} characters)` },
      preview_url: { type: "boolean", default: false, description: "Render a link preview for the first URL" },
      reply_to_message_id: REPLY_TO_PROPERTY,
    },
    required: ["body"],
    buildMessage: buildTextMessage,
  }),
  sendOperation({
    name: "send_template",
    title: "Send WhatsApp template",
    description: "Send an approved message template. Required for the first message and outside the 24 h window.",
    properties: {
      name: { type: "string", description: "Template name" },
      language: { type: "string", default: "en_US", description: "Template language code, e.g. en_US, id" },
      components: { type: "array", items: { type: "object" }, description: 'Template parameters, e.g. [{"type":"body","parameters":[{"type":"text","text":"A1"}]}]' },
    },
    required: ["name"],
    buildMessage: buildTemplateMessage,
  }),
  sendOperation({
    name: "send_media",
    title: "Send WhatsApp media",
    description: "Send an image, video, audio, document or sticker by public https link or uploaded media_id. 24 h window rules apply.",
    properties: {
      media_type: { type: "string", enum: MEDIA_TYPES, description: "Kind of media (sent as the message `type`)" },
      link: { type: "string", description: "Public https URL of the file (instead of media_id)" },
      media_id: { type: "string", description: "Id from upload_media (instead of link)" },
      caption: { type: "string", description: "Caption (image, video, document only)" },
      filename: { type: "string", description: "File name shown to the recipient (document only)" },
      reply_to_message_id: REPLY_TO_PROPERTY,
    },
    required: ["media_type"],
    buildMessage: buildMediaMessage,
  }),
  sendOperation({
    name: "send_location",
    title: "Send WhatsApp location",
    description: "Send a location pin. 24 h window rules apply.",
    properties: {
      latitude: { type: "number" },
      longitude: { type: "number" },
      name: { type: "string", description: "Place name" },
      address: { type: "string", description: "Address" },
      reply_to_message_id: REPLY_TO_PROPERTY,
    },
    required: ["latitude", "longitude"],
    buildMessage: buildLocationMessage,
  }),
  sendOperation({
    name: "send_interactive_buttons",
    title: "Send WhatsApp reply buttons",
    description: "Send a message with up to 3 quick-reply buttons (title up to 20 characters). 24 h window rules apply.",
    properties: {
      body: { type: "string", description: "Message text (up to 1024 characters)" },
      buttons: { type: "array", maxItems: 3, description: 'Button titles, or objects {"id","title"}; the id comes back in the reply webhook' },
      header_text: { type: "string", description: "Optional header (up to 60 characters)" },
      footer: { type: "string", description: "Optional footer (up to 60 characters)" },
      reply_to_message_id: REPLY_TO_PROPERTY,
    },
    required: ["body", "buttons"],
    buildMessage: (args) => buildEnvelope(args, "interactive", buildButtonsInteractive(args)),
  }),
  sendOperation({
    name: "send_interactive_list",
    title: "Send WhatsApp list",
    description: "Send a list message: a button that opens up to 10 rows grouped in sections. 24 h window rules apply.",
    properties: {
      body: { type: "string", description: "Message text (up to 4096 characters)" },
      button_text: { type: "string", description: "Label of the button that opens the list (up to 20 characters)" },
      sections: { type: "array", items: { type: "object" }, description: 'Sections [{"title","rows":[{"id","title","description"}]}]; 10 rows in total' },
      header_text: { type: "string", description: "Optional header (up to 60 characters)" },
      footer: { type: "string", description: "Optional footer (up to 60 characters)" },
      reply_to_message_id: REPLY_TO_PROPERTY,
    },
    required: ["body", "button_text", "sections"],
    buildMessage: (args) => buildEnvelope(args, "interactive", buildListInteractive(args)),
  }),
  sendOperation({
    name: "send_reaction",
    title: "Send WhatsApp reaction",
    description: "React to a message with an emoji, or remove your reaction.",
    properties: {
      message_id: { type: "string", description: "Message id (wamid...) to react to" },
      emoji: { type: "string", description: "Emoji, e.g. 👍" },
      remove: { type: "boolean", default: false, description: "Remove your reaction instead" },
    },
    required: ["message_id"],
    buildMessage: buildReactionMessage,
  }),
  {
    name: "mark_as_read",
    title: "Mark WhatsApp message as read",
    description: "Mark a received message (and earlier ones) as read, optionally showing a typing indicator.",
    parameters: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Received message id (wamid...)" },
        show_typing_indicator: { type: "boolean", default: false, description: "Show a typing indicator until you reply (max 25 s)" },
        phone_number_id: PHONE_NUMBER_ID_PROPERTY,
      },
      required: ["message_id"],
    },
    run: sendMessageRequest((args) => {
      const readBody = { messaging_product: "whatsapp", status: "read", message_id: args.message_id };
      return args.show_typing_indicator ? { ...readBody, typing_indicator: { type: "text" } } : readBody;
    }),
  },
];
