/**
 * rss-reader plugin definition: fetch and normalise RSS, Atom and JSON feeds.
 *
 * Public API, no token (`noCredentials`). Feeds are fetched with the shared
 * public-https-fetch (https only, every redirect hop checked, loopback,
 * private and link-local hosts refused, streaming size cap) and parsed with
 * a strict XML parser that never processes a DTD or expands entities.
 */
import { readRssReaderSettings, CALL_TIMEOUT_MS, MAX_FEED_BYTES_VARIABLE, TIMEOUT_VARIABLE } from "./lib/settings.mjs";
import { feedOperations } from "./operations/feeds.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{resolveHostAddresses}` DNS override (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "rss-reader",
    version: "0.1.0",
    description: "RSS 2.0, RSS 1.0, Atom and JSON Feed: fetch from public https URLs (size-capped) or parse given text into normalised items, with since and item limits; no DTDs or entity expansion",
    extraEnv: [MAX_FEED_BYTES_VARIABLE, TIMEOUT_VARIABLE],
    noCredentials: true,
    limits: { timeout_ms: CALL_TIMEOUT_MS, max_concurrency: 8 },
    createClient: ({ environment, fetchImpl, resolveHostAddresses }) => ({
      settings: readRssReaderSettings(environment),
      fetchImpl: fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments)),
      resolveHostAddresses: resolveHostAddresses ?? dependencies.resolveHostAddresses,
    }),
    operations: feedOperations,
  };
}

export const pluginDefinition = createPluginDefinition();
