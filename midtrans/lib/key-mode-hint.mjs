/**
 * A clearer auth_error when the server key does not belong to MIDTRANS_ENV: sandbox server keys start with "SB-",
 * production keys do not, and each only works on its own hosts. The hint never shows the key.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Describes a key/host mismatch, or returns null when the key prefix fits the mode.
 *
 * @param environment - Environment variables (object)
 * @returns Hint text or null (string | null)
 *
 * @example
 * describeKeyModeMismatch({ MIDTRANS_ENV: "production", MIDTRANS_SERVER_KEY: "SB-Mid-server-x" });
 * // "MIDTRANS_SERVER_KEY looks like a sandbox key (SB-...) but MIDTRANS_ENV is production"
 */
export function describeKeyModeMismatch(environment) {
  const serverKey = String(environment?.MIDTRANS_SERVER_KEY ?? "").trim();
  if (!serverKey) return null;
  const mode = String(environment?.MIDTRANS_ENV ?? "sandbox").trim().toLowerCase() || "sandbox";
  const isSandboxKey = serverKey.startsWith("SB-");
  if (mode === "production" && isSandboxKey) return "MIDTRANS_SERVER_KEY looks like a sandbox key (SB-...) but MIDTRANS_ENV is production";
  if (mode === "sandbox" && !isSandboxKey) return "MIDTRANS_SERVER_KEY looks like a production key (no SB- prefix) but MIDTRANS_ENV is sandbox (the default); set MIDTRANS_ENV=production";
  return null;
}

/**
 * Returns the definition with the mismatch hint appended to auth_error messages.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns A new definition (object)
 */
export function addKeyModeHint(pluginDefinition) {
  const wrapOperation = (operation) => ({
    ...operation,
    run: async (context) => {
      try {
        return await operation.run(context);
      } catch (runError) {
        const hint = runError instanceof PluginError && runError.kind === "auth_error" ? describeKeyModeMismatch(context.environment) : null;
        if (!hint) throw runError;
        throw new PluginError(`${runError.message} (${hint})`, { kind: runError.kind, retryable: runError.retryable, retryAfterMs: runError.retryAfterMs });
      }
    },
  });
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
