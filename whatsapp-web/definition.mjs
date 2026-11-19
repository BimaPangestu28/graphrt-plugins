/**
 * whatsapp-web plugin definition: the user's personal WhatsApp through
 * WhatsApp Web in a headless Chromium (Playwright) with a persistent profile.
 *
 * There is no API token: `resolveAccessToken` returns "local" and
 * `createClient` returns the cached browser driver for the profile directory.
 */
import { createClientFactory } from "./lib/client.mjs";
import { createOperationTracker } from "./lib/operation-tracker.mjs";
import { chatOperations } from "./operations/chats.mjs";
import { sendingOperations } from "./operations/sending.mjs";
import { sessionOperations } from "./operations/session.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - See createClientFactory (object, optional)
 * @returns Plugin definition plus `closeAllClients()` and `waitForRunningOperations(timeoutMs)`
 *   for shutdown (object)
 */
export function createPluginDefinition(dependencies = {}) {
  const { createClient, closeAllClients } = createClientFactory(dependencies);
  const operationTracker = createOperationTracker();
  const trackOperation = (operation) => ({ ...operation, run: (runContext) => operationTracker.track(() => operation.run(runContext)) });
  return {
    name: "whatsapp-web",
    version: "0.2.0",
    description: "Your personal WhatsApp through WhatsApp Web in a headless browser: read chats and messages, send text and files (low volume, rate limited)",
    tokenEnv: "WHATSAPP_WEB_PROFILE_DIR",
    extraEnv: [
      "WHATSAPP_WEB_IDLE_MINUTES",
      "WHATSAPP_WEB_MIN_SEND_INTERVAL_SECONDS",
      "WHATSAPP_WEB_DAILY_SEND_LIMIT",
      "WHATSAPP_WEB_ALLOWED_FILE_DIRS",
    ],
    // One browser page per profile: operations are serialised anyway. Login takes at most 240 s + 8 s settle + browser start.
    limits: { timeout_ms: 300000, max_concurrency: 1 },
    resolveAccessToken: () => "local",
    createClient,
    closeAllClients,
    waitForRunningOperations: (timeoutMs) => operationTracker.waitForIdle(timeoutMs),
    operations: [...sessionOperations, ...chatOperations, ...sendingOperations].map(trackOperation),
  };
}

export const pluginDefinition = createPluginDefinition();
