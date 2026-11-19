/**
 * Similarity ranking for the embeddings plugin: embed a query and a list of documents in one call and return the
 * documents ordered by cosine similarity. Agents get scores instead of vectors, so semantic search over a small
 * list fits in a tool result. The texts are sent in provider-sized requests (Gemini: 100 per request); each request
 * is a paid, never-retried call, so a failure names how many requests already went through.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { resolveBatchSize } from "./providers.mjs";

const MAX_DOCUMENTS = 999;
const DEFAULT_TOP_K = 5;

/**
 * Cosine similarity of two vectors.
 *
 * @param leftVector - Numbers (number[])
 * @param rightVector - Numbers of the same length (number[])
 * @returns Similarity in [-1, 1]; 0 when either vector is all zeros (number)
 * @throws PluginError kind `api_error` - When the lengths differ
 *
 * @example
 * cosineSimilarity([1, 0], [1, 1]); // 0.7071...
 */
export function cosineSimilarity(leftVector, rightVector) {
  if (leftVector.length !== rightVector.length) {
    throw new PluginError(`Embedding vectors have different lengths (${leftVector.length} and ${rightVector.length})`, { kind: "api_error" });
  }
  let dotProduct = 0;
  let leftNormSquared = 0;
  let rightNormSquared = 0;
  for (let index = 0; index < leftVector.length; index += 1) {
    dotProduct += leftVector[index] * rightVector[index];
    leftNormSquared += leftVector[index] ** 2;
    rightNormSquared += rightVector[index] ** 2;
  }
  if (leftNormSquared === 0 || rightNormSquared === 0) return 0;
  return dotProduct / Math.sqrt(leftNormSquared * rightNormSquared);
}

/**
 * Orders documents by similarity to the query.
 *
 * @param ranking - Inputs (object)
 * @param ranking.queryVector - Query embedding (number[])
 * @param ranking.documentVectors - One embedding per document (number[][])
 * @param ranking.documents - Document texts (string[])
 * @param ranking.topK - How many matches to keep (number)
 * @returns `[{index, document, score}]`, best first (object[])
 */
export function rankDocuments({ queryVector, documentVectors, documents, topK }) {
  return documentVectors
    .map((documentVector, index) => ({ index, document: documents[index], score: roundScore(cosineSimilarity(queryVector, documentVector)) }))
    .sort((leftMatch, rightMatch) => rightMatch.score - leftMatch.score)
    .slice(0, topK);
}

function roundScore(score) {
  return Math.round(score * 1e6) / 1e6;
}

/**
 * Builds the `rank_by_similarity` operation on top of the embed operation.
 *
 * @param embedOperation - The `embed_texts` operation (with the default model filled in) (object)
 * @returns Operation `{name, title, description, parameters, run}` for operations.mjs (object)
 */
export function createRankOperation(embedOperation) {
  return {
    name: "rank_by_similarity",
    title: "Rank by similarity",
    description: "Semantic search over a short list: embeds the query and documents and returns the top_k most similar documents with cosine scores",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "What to search for" },
        documents: { type: "array", items: { type: "string" }, maxItems: MAX_DOCUMENTS, description: `Texts to rank (at most ${MAX_DOCUMENTS})` },
        top_k: { type: "integer", minimum: 1, maximum: MAX_DOCUMENTS, default: DEFAULT_TOP_K, description: "How many matches to return" },
        model: { type: "string", description: "Embedding model (default: EMBEDDINGS_MODEL, else the provider's default)" },
      },
      required: ["query", "documents"],
    },
    run: (context) => rankBySimilarity(embedOperation, context),
  };
}

async function rankBySimilarity(embedOperation, context) {
  const { query, documents, top_k: topK, model } = context.args;
  if (documents.length === 0) return { data: { model: model ?? null, matches: [] }, next_cursor: null };
  const { vectors, usedModel } = await embedInBatches(embedOperation, context, [query, ...documents]);
  const matches = rankDocuments({ queryVector: vectors[0], documentVectors: vectors.slice(1), documents, topK });
  return { data: { model: usedModel ?? model ?? null, matches }, next_cursor: null };
}

async function embedInBatches(embedOperation, context, texts) {
  const batchSize = resolveBatchSize(context.environment ?? {});
  const vectors = [];
  let usedModel;
  for (let start = 0; start < texts.length; start += batchSize) {
    const batchTexts = texts.slice(start, start + batchSize);
    // Run as a node so the vectors are not truncated for tools; only the scores reach the agent.
    const embedded = await runBatch(embedOperation, context, batchTexts, start / batchSize);
    vectors.push(...readVectorsInInputOrder(embedded.data, batchTexts.length));
    usedModel = embedded.data?.model ?? usedModel;
  }
  return { vectors, usedModel };
}

async function runBatch(embedOperation, context, batchTexts, finishedBatches) {
  try {
    return await embedOperation.run({ ...context, source: "node", args: { input: batchTexts, model: context.args.model } });
  } catch (batchError) {
    if (!(batchError instanceof PluginError) || finishedBatches === 0) throw batchError;
    throw new PluginError(`${batchError.message} (after ${finishedBatches} embeddings request(s) that succeeded and were billed)`, { kind: batchError.kind, retryable: false });
  }
}

function readVectorsInInputOrder(responseBody, expectedCount) {
  const items = Array.isArray(responseBody?.data) ? responseBody.data : [];
  const vectors = new Array(expectedCount);
  items.forEach((item, position) => {
    const index = Number.isInteger(item?.index) ? item.index : position;
    if (Array.isArray(item?.embedding) && index >= 0 && index < expectedCount) vectors[index] = item.embedding;
  });
  if (vectors.filter(Boolean).length !== expectedCount) {
    throw new PluginError(`The provider returned ${items.length} embeddings, expected ${expectedCount} vectors`, { kind: "api_error" });
  }
  return vectors;
}
