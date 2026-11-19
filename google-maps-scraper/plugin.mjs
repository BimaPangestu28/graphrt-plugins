// graphrt plugin `google-maps-scraper`: search Google Maps and extract business phone numbers.
//
// Run it in a workflow with:  graphrt run example.yaml --plugins <parent dir>
// Never console.log (stdout carries the plugin protocol); use console.error.
import { Plugin } from "./graphrt-plugin.mjs";
import { createDeadlineSignal } from "./lib/cancellation.mjs";
import { buildFrameName, resolveLiveViewDirectory } from "./lib/live-view.mjs";
import { collectPhones, validateSearchConfig } from "./lib/parse.mjs";
import { searchPlaces } from "./lib/scraper.mjs";

// Set by a host app that shows the browser live (graphrt desktop); unset = no frames.
const LIVE_VIEW_DIRECTORY = resolveLiveViewDirectory(process.env);

// Slightly under the manifest's `timeout_ms` (300000) so the browser closes first.
const TOOL_DEADLINE_MS = 290000;

const SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "What to search on Google Maps, e.g. \"bengkel motor Bandung\"" },
    max_results: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Maximum places to return" },
    language: { type: "string", default: "id", description: "Google Maps interface language code" },
    headless: { type: "boolean", default: true, description: "Run the browser without a window" },
  },
  required: ["query"],
};

/**
 * Validates config, runs the Maps search and shapes the shared output.
 *
 * @param config - Raw node config or tool arguments (object)
 * @param hooks - `{signal, onProgress, liveView}` forwarded to searchPlaces
 * @returns `{results, phones, count}` (Promise<object>)
 * @throws PluginError - From validation or the scraper
 */
async function runSearch(config, hooks) {
  const searchOptions = validateSearchConfig(config);
  const results = await searchPlaces(searchOptions, hooks);
  return { results, phones: collectPhones(results), count: results.length };
}

new Plugin("google-maps-scraper")
  .node("google-maps-scraper.search", async (ctx, req) => {
    const searchOutput = await runSearch(req.config, {
      signal: ctx.signal,
      onProgress: (progressInfo) => ctx.progress("place", progressInfo),
      liveView: { directory: LIVE_VIEW_DIRECTORY, frameName: buildFrameName(req.nodeId) },
    });
    return { outputs: searchOutput };
  })
  .tool(
    {
      name: "search_places",
      description: "Search Google Maps and return matching places with phone, address, website and rating",
      parameters: SEARCH_PARAMETERS,
    },
    async (toolArguments) => {
      // The SDK gives tools no cancel signal, so stop before the host's 300 s timeout.
      const searchOutput = await runSearch(toolArguments, {
        signal: createDeadlineSignal(TOOL_DEADLINE_MS),
        liveView: { directory: LIVE_VIEW_DIRECTORY, frameName: buildFrameName(null) },
      });
      return { text: JSON.stringify(searchOutput.results), data: searchOutput };
    },
  )
  .run();
