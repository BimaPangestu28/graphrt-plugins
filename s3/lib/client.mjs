/**
 * The s3 client for one run: validated settings, the signed transport, a clock and presigning.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { createS3Transport } from "./s3-transport.mjs";
import { resolveSettings } from "./settings.mjs";

/**
 * Creates the client the operations receive.
 *
 * @param runnerInputs - `{accessToken, environment, fetchImpl}`; accessToken is the result of resolveCredentials (object)
 * @param dependencies - `{now, retryBaseDelayMs}` overrides, for tests (object, optional)
 * @returns `{settings, transport, now, presign}` (object)
 * @throws PluginError kind `invalid_input` - When a setting is malformed
 */
export function createS3Client({ accessToken: credentials, environment, fetchImpl }, dependencies = {}) {
  const settings = resolveSettings(environment);
  const now = dependencies.now ?? (() => new Date());
  const transport = createS3Transport({ settings, credentials, fetchImpl, now, retryBaseDelayMs: dependencies.retryBaseDelayMs });
  const presign = (presignOptions) => {
    try {
      return transport.presignGet(presignOptions);
    } catch (presignError) {
      if (presignError instanceof PluginError) throw presignError;
      throw new PluginError(transport.redact(presignError.message), { kind: "invalid_input" });
    }
  };
  return { settings, transport, now, presign };
}
