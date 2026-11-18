/**
 * Builds the per-process "client" handed to operations: settings, the
 * WhatsApp driver (one browser session per profile directory, reused across
 * runs) and the send guard. The shared runner calls `createClient` for every
 * operation, so clients are cached here for the life of the plugin process.
 */
import { join } from "node:path";
import { createBrowserSession } from "./browser-session.mjs";
import { createSendGuard } from "./send-guard.mjs";
import { resolveSettings } from "./settings.mjs";
import { createWhatsAppDriver } from "./whatsapp-driver.mjs";

/** File in the profile directory that holds the send counters. */
export const SEND_STATE_FILE_NAME = "graphrt-send-state.json";

/**
 * Creates a cached client factory with injectable side effects.
 *
 * @param dependencies - Overrides for tests (object, all optional)
 * @param dependencies.launchPersistentContext - Playwright launcher (function)
 * @param dependencies.createDriver - `(session, settings) => driver`, replaces the real driver (function)
 * @param dependencies.timers - `{setTimeout, clearTimeout}` for the idle shutdown (object)
 * @param dependencies.clock - `{now(), sleep(ms, signal)}` for the send guard (object)
 * @param dependencies.fetchImpl - fetch used to download `send_file` URLs (function)
 * @returns `{createClient({environment}), closeAllClients()}` (object)
 */
export function createClientFactory(dependencies = {}) {
  const clientsByProfile = new Map();
  const buildClient = (settings) => {
    const session = createBrowserSession({
      profileDirectory: settings.profileDirectory,
      idleTimeoutMs: settings.idleTimeoutMs,
      launchPersistentContext: dependencies.launchPersistentContext,
      timers: dependencies.timers,
    });
    const createDriver = dependencies.createDriver ?? createWhatsAppDriver;
    const sendGuard = createSendGuard({
      stateFilePath: join(settings.profileDirectory, SEND_STATE_FILE_NAME),
      minIntervalMs: settings.minSendIntervalMs,
      dailyLimit: settings.dailySendLimit,
      clock: dependencies.clock,
    });
    return { settings, driver: createDriver(session, settings), sendGuard, fetchImpl: dependencies.fetchImpl ?? fetch };
  };
  return {
    createClient({ environment }) {
      const settings = resolveSettings(environment);
      if (!clientsByProfile.has(settings.profileDirectory)) clientsByProfile.set(settings.profileDirectory, buildClient(settings));
      return clientsByProfile.get(settings.profileDirectory);
    },
    /** Closes every browser this process opened (plugin shutdown). */
    async closeAllClients() {
      await Promise.all([...clientsByProfile.values()].map((client) => client.driver.close()));
    },
  };
}
