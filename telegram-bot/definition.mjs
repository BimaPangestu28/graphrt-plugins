/**
 * telegram-bot plugin definition: a Telegram bot through the official Bot API
 * (https://core.telegram.org/bots/api). Updates are read by long polling (get_updates);
 * webhook management is node-only.
 */
import { createTelegramClient } from "./lib/client.mjs";
import { apiRequestOperation } from "./operations/api-request.mjs";
import { editingOperations } from "./operations/editing.mjs";
import { infoOperations } from "./operations/info.mjs";
import { sendingOperations } from "./operations/sending.mjs";
import { updateOperations } from "./operations/updates.mjs";
import { webhookOperations } from "./operations/webhook.mjs";

export const pluginDefinition = {
  name: "telegram-bot",
  version: "0.1.0",
  description: "Telegram Bot API: read updates, send messages, photos and documents, edit and delete messages, answer button presses, manage the webhook",
  tokenEnv: "TELEGRAM_BOT_TOKEN",
  extraEnv: ["TELEGRAM_WEBHOOK_SECRET"],
  createClient: createTelegramClient,
  operations: [...updateOperations, ...sendingOperations, ...editingOperations, ...infoOperations, ...webhookOperations, apiRequestOperation],
};
