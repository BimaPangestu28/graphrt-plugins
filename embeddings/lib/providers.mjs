/**
 * Embedding providers for the embeddings plugin: the OpenAI-compatible base URL and default model of each one.
 *
 * The provider comes from EMBEDDINGS_PROVIDER (operator configuration), so an agent can never send the key to a
 * host of its choosing. EMBEDDINGS_BASE_URL overrides the URL (required for `custom`); the declarative layer then
 * checks it is https (http only on localhost).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const PROVIDER_ENV = ["EMBEDDINGS_PROVIDER", "EMBEDDINGS_BASE_URL", "EMBEDDINGS_MODEL", "EMBEDDINGS_BATCH_SIZE"];
// batchSize: texts per request. Gemini allows 100; Voyage 1000; OpenAI 2048 (capped at the plugin's 1000). Mistral's
// limit is by tokens, so 100 is a conservative choice there and for unknown hosts.
const PROVIDERS = {
  openai: { baseUrl: "https://api.openai.com/v1", defaultModel: "text-embedding-3-small", batchSize: 1000 },
  mistral: { baseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-embed", batchSize: 100 },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-embedding-001", batchSize: 100 },
  voyage: { baseUrl: "https://api.voyageai.com/v1", defaultModel: "voyage-4", batchSize: 1000 },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "nomic-embed-text", batchSize: 1000 },
  custom: { baseUrl: undefined, defaultModel: undefined, batchSize: 100 },
};
const MAX_BATCH_SIZE = 1000;

function readProvider(environment) {
  const providerName = (environment.EMBEDDINGS_PROVIDER?.trim() || "openai").toLowerCase();
  if (!Object.hasOwn(PROVIDERS, providerName)) throw new Error(`EMBEDDINGS_PROVIDER must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  return PROVIDERS[providerName];
}

/**
 * Resolves the base URL: EMBEDDINGS_BASE_URL, else the provider's.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL without a trailing slash (string)
 * @throws Error - Unknown provider, or `custom` without EMBEDDINGS_BASE_URL
 *
 * @example
 * resolveEmbeddingsBaseUrl({ EMBEDDINGS_PROVIDER: "voyage" }); // "https://api.voyageai.com/v1"
 */
export function resolveEmbeddingsBaseUrl(environment) {
  const provider = readProvider(environment);
  const baseUrl = environment.EMBEDDINGS_BASE_URL?.trim() || provider.baseUrl;
  if (!baseUrl) throw new Error("EMBEDDINGS_PROVIDER=custom needs EMBEDDINGS_BASE_URL, e.g. https://host/v1");
  return baseUrl.replace(/\/+$/, "");
}

/**
 * The model used when a call names none: EMBEDDINGS_MODEL, else the provider's default.
 *
 * @param environment - Environment variables (object)
 * @returns Model id, or undefined for `custom` without EMBEDDINGS_MODEL (string | undefined)
 */
export function resolveDefaultModel(environment) {
  return environment.EMBEDDINGS_MODEL?.trim() || readProvider(environment).defaultModel;
}

/**
 * Texts per embeddings request for rank_by_similarity: EMBEDDINGS_BATCH_SIZE (1..1000), else the provider's.
 *
 * @param environment - Environment variables (object)
 * @returns Batch size (number)
 */
export function resolveBatchSize(environment) {
  const configuredSize = Number(environment.EMBEDDINGS_BATCH_SIZE);
  if (Number.isInteger(configuredSize) && configuredSize >= 1 && configuredSize <= MAX_BATCH_SIZE) return configuredSize;
  return readProvider(environment).batchSize;
}

/**
 * Wraps the declarative embed operation so a missing `model` is filled in before the request is built.
 *
 * @param embedOperation - Operation from defineRestPlugin (object)
 * @returns Operation with the same schema and a run that adds the default model (object)
 * @throws PluginError kind `invalid_input` - (from run) no model and no default
 */
export function withDefaultModel(embedOperation) {
  return {
    ...embedOperation,
    run: (context) => {
      const model = context.args.model ?? resolveModelOrFail(context.environment ?? {});
      return embedOperation.run({ ...context, args: { ...context.args, model } });
    },
  };
}

function resolveModelOrFail(environment) {
  let model;
  try {
    model = resolveDefaultModel(environment);
  } catch (configurationError) {
    throw new PluginError(configurationError.message, { kind: "invalid_input" });
  }
  if (!model) throw new PluginError("No embedding model: pass `model` or set EMBEDDINGS_MODEL", { kind: "invalid_input" });
  return model;
}
