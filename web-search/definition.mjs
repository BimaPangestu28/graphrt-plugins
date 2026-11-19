/**
 * web-search plugin definition: provider-agnostic web and news search. WEB_SEARCH_PROVIDER picks Tavily, Brave
 * Search or SerpAPI (Google) and WEB_SEARCH_API_KEY holds that provider's key; both come only from the environment.
 *
 * Each provider is a declarative REST definition (lib/search-providers.mjs). The two operations here are
 * hand-written: they validate the neutral arguments, run the provider's operation with the provider's client
 * (auth, redaction, error mapping, no retry of paid calls after an unknown outcome) and return neutral results:
 *   {provider, query, answer, results: [{title, url, snippet, published_at, source}]}
 */
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { validateArguments } from "./lib/shared/params.mjs";
import { braveDefinition, KEY_ENV, PROVIDERS, serpapiDefinition, tavilyDefinition } from "./lib/search-providers.mjs";

export { braveDefinition, serpapiDefinition, tavilyDefinition };

const PROVIDER_ENV = "WEB_SEARCH_PROVIDER";
const MAX_RESULTS = 20;

const searchParameters = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, description: "What to search for" },
    max_results: { type: "integer", minimum: 1, maximum: MAX_RESULTS, default: 10, description: "Maximum results (SerpAPI: at most 10)" },
    country: { type: "string", description: "2-letter country code to localize results, e.g. ID, US (Brave, SerpAPI)" },
    language: { type: "string", description: "Language code, e.g. en, id (Brave, SerpAPI)" },
    freshness: { type: "string", enum: ["day", "week", "month", "year"], description: "Only results from the last day, week, month or year" },
    include_answer: { type: "boolean", default: true, description: "Tavily only: add a short generated answer" },
  },
  required: ["query"],
};

/**
 * Reads WEB_SEARCH_PROVIDER and returns its adapter.
 *
 * @param environment - Environment variables (object)
 * @returns Provider adapter with its name (object)
 * @throws PluginError kind `invalid_input` - When the provider is missing or unknown
 */
export function selectProvider(environment) {
  const providerName = environment?.[PROVIDER_ENV]?.trim().toLowerCase();
  const provider = providerName ? PROVIDERS[providerName] : undefined;
  if (!provider) {
    const choices = Object.keys(PROVIDERS).join(", ");
    throw new PluginError(`Set ${PROVIDER_ENV} to one of ${choices}${providerName ? ` (got ${JSON.stringify(providerName)})` : ""}`, { kind: "invalid_input" });
  }
  return { name: providerName, ...provider };
}

function createSearchOperation({ name, title, description, kind }) {
  const run = async (context) => {
    const provider = selectProvider(context.environment);
    const providerOperation = provider.definition.operations.find((operation) => operation.name === provider.operationFor(kind));
    const maxResults = Math.min(context.args.max_results, provider.maxResults ?? MAX_RESULTS);
    const providerArgs = validateArguments(providerOperation.parameters, stripUndefined(provider.buildArgs(kind, { ...context.args, max_results: maxResults })));
    const { data: body } = await providerOperation.run({ ...context, args: providerArgs });
    const { answer, results } = provider.normalize(body, kind);
    return { data: { provider: provider.name, query: context.args.query, answer, results: results.slice(0, maxResults) }, next_cursor: null };
  };
  return { name, title, description, parameters: searchParameters, run };
}

function stripUndefined(args) {
  return Object.fromEntries(Object.entries(args).filter(([, argumentValue]) => argumentValue !== undefined));
}

export const pluginDefinition = {
  name: "web-search",
  version: "0.1.0",
  description: "Web and news search through Tavily, Brave Search or SerpAPI (provider and key from env; paid per query)",
  tokenEnv: KEY_ENV,
  extraEnv: [PROVIDER_ENV],
  resolveAccessToken: (options) => selectProvider(options.environment).definition.resolveAccessToken(options),
  createClient: (clientOptions) => selectProvider(clientOptions.environment).definition.createClient(clientOptions),
  operations: [
    createSearchOperation({
      name: "search",
      title: "Web search",
      description: "Search the web; returns {provider, query, answer, results: [{title, url, snippet, published_at, source}]} (paid per query)",
      kind: "web",
    }),
    createSearchOperation({
      name: "search_news",
      title: "News search",
      description: "Search recent news articles; same result shape as search (paid per query)",
      kind: "news",
    }),
  ],
};
