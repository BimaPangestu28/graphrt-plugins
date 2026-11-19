/**
 * macos-notifications plugin definition: local notifications on this Mac via
 * /usr/bin/osascript, with a constant script and the text passed as separate
 * arguments (see lib/notification-script.mjs). No network, no secrets
 * (`localOnly`). Agent calls are rate limited per minute.
 */
import { createProcessRunner } from "./lib/process-runner.mjs";
import { readInteger } from "./lib/environment-readers.mjs";
import { createRateLimiter } from "./lib/rate-limiter.mjs";
import { notifyOperation } from "./operations/notify.mjs";

export const RATE_LIMIT_VARIABLE = "MACOS_NOTIFICATIONS_TOOL_RATE_LIMIT";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{runProcess, platform, now}` overrides (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  const runProcess = dependencies.runProcess ?? createProcessRunner();
  const rateLimiter = createRateLimiter(dependencies.now ?? Date.now);
  return {
    name: "macos-notifications",
    version: "0.1.0",
    description: "Local macOS notifications (title, subtitle, message, system sound) via osascript with a constant script and the text as separate arguments; agent calls rate limited",
    extraEnv: [RATE_LIMIT_VARIABLE],
    localOnly: true,
    noCredentials: true,
    limits: { timeout_ms: 30000, max_concurrency: 2 },
    createClient: ({ environment }) => ({
      settings: { toolRateLimit: readInteger(environment, RATE_LIMIT_VARIABLE, 6, { minimum: 1, maximum: 120 }) },
      runProcess,
      rateLimiter,
      platform: dependencies.platform ?? process.platform,
    }),
    operations: [notifyOperation],
  };
}

export const pluginDefinition = createPluginDefinition();
