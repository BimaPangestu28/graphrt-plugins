/**
 * embeddings plugin definition: one provider-agnostic embeddings plugin over the OpenAI-compatible `POST /embeddings`
 * endpoint that OpenAI, Mistral, Gemini, Voyage AI, Ollama and many hosts serve. The provider (and so the host and
 * the key) is chosen by the operator in EMBEDDINGS_PROVIDER, never by tool arguments.
 *
 * Why a separate plugin when openai, mistral, gemini and ollama already embed: workflows that do retrieval or
 * deduplication should not be rewritten when the provider changes, and an agent gets `rank_by_similarity`, which
 * returns scores instead of thousands of floats. Provider-specific features stay in the provider plugins.
 *
 * `embed_texts` is declarative; lib/providers.mjs fills in the default model, and lib/similarity.mjs adds the
 * hand-written ranking operation on top of it.
 *
 * Retries: embeddings are paid, so `embed_texts` (and every request of `rank_by_similarity`) is "unsafe": a 5xx or
 * timeout is when the provider may already have billed it, so it is never retried and its error says how to check.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { PROVIDER_ENV, resolveEmbeddingsBaseUrl, withDefaultModel } from "./lib/providers.mjs";
import { createRankOperation } from "./lib/similarity.mjs";

const embedTexts = {
  name: "embed_texts",
  title: "Embed texts",
  description: "Embed texts with the configured provider; data[] holds {index, embedding} with index pointing into input",
  method: "POST",
  path: "/embeddings",
  write: "unsafe",
  checkHint: "the call may have been billed; check usage with the provider before retrying",
  toolOutput: { maxChars: 20000 },
  params: {
    input: { in: "body", type: "array", items: { type: "string" }, required: true, maxItems: 1000, description: "Texts to embed" },
    model: { in: "body", type: "string", description: "Embedding model (default: EMBEDDINGS_MODEL, else the provider's default)" },
    dimensions: { in: "body", type: "integer", min: 1, description: "Shorter vectors: OpenAI, Gemini and Ollama name it dimensions" },
    output_dimension: { in: "body", type: "integer", min: 1, description: "Shorter vectors: Voyage and Mistral name it output_dimension" },
    input_type: { in: "body", type: "string", enum: ["query", "document"], description: "Voyage only: embed as a search query or a document" },
  },
};

const restDefinition = defineRestPlugin({
  name: "embeddings",
  version: "0.1.0",
  description: "Provider-agnostic text embeddings (OpenAI, Mistral, Gemini, Voyage, Ollama or any OpenAI-compatible host) and similarity ranking",
  apiName: "embeddings provider API",
  extraEnv: PROVIDER_ENV,
  baseUrl: resolveEmbeddingsBaseUrl,
  auth: { type: "bearer", env: "EMBEDDINGS_API_KEY" },
  // OpenAI-style hosts answer {"error": {"message"}}, Voyage {"detail"}, Mistral {"message"}, Ollama {"error"}.
  errors: { messagePath: ["error.message", "detail", "message", "error"] },
  apiRequest: false,
  operations: [embedTexts],
});

const embedOperation = withDefaultModel(restDefinition.operations.find((operation) => operation.name === "embed_texts"));

export const pluginDefinition = {
  ...restDefinition,
  operations: [embedOperation, createRankOperation(embedOperation)],
};
