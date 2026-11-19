/**
 * Qdrant can embed query inputs server-side ("inference"): a Document `{text, model}`, an Image `{image, model}` or an
 * InferenceObject `{object, model}` anywhere in `query` or `prefetch`, or as the vector of an upserted point. On Qdrant Cloud (and with external providers)
 * that inference is billed per request, so such a query must not be retried after a timeout or 5xx, while a plain
 * vector query is a free read and should be.
 *
 * The declarative layer fixes the write class per operation, so each query operation has an "unsafe" twin with the
 * same request. `routeInferenceQueries` makes the public operation send the call through the twin when the arguments
 * contain an inference input, and removes the twin from the plugin's operations (and from restSpec, so the contract
 * suite only sees public operations).
 */

const INFERENCE_INPUT_KEYS = ["text", "image", "object"];
const MAX_SCAN_DEPTH = 32;

/**
 * Tells whether a value contains a Qdrant inference input (an object with `model` and `text`, `image` or `object`).
 *
 * @param value - Query arguments, e.g. `{query, prefetch}` (unknown)
 * @returns Whether server-side inference would run (boolean)
 *
 * @example
 * containsInferenceInput({ query: { nearest: { text: "shoes", model: "qdrant/bm25" } } }); // true
 * containsInferenceInput({ query: { nearest: [0.1, 0.2] } }); // false
 */
export function containsInferenceInput(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > MAX_SCAN_DEPTH) return false;
  if (Array.isArray(value)) return value.some((item) => containsInferenceInput(item, depth + 1));
  if ("model" in value && INFERENCE_INPUT_KEYS.some((key) => key in value)) return true;
  return Object.values(value).some((item) => containsInferenceInput(item, depth + 1));
}

// Where inference inputs can appear: a query and its prefetches, and the vectors of upserted points. Payloads are
// left out on purpose: a payload with `text` and `model` fields is plain data, not an embedding request.
function listInferenceCandidates(args) {
  const pointVectors = Array.isArray(args?.points) ? args.points.map((point) => point?.vector) : undefined;
  return [args?.query, args?.prefetch, pointVectors];
}

/**
 * Routes calls with inference inputs to an unsafe twin operation, and hides the twins.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @param routes - `{publicName: twinName}` (object)
 * @returns A new definition (object)
 * @throws Error - When an operation of a route is missing
 */
export function routeInferenceQueries(pluginDefinition, routes) {
  const byName = new Map(pluginDefinition.operations.map((operation) => [operation.name, operation]));
  for (const [publicName, twinName] of Object.entries(routes)) {
    if (!byName.has(publicName) || !byName.has(twinName)) throw new Error(`${pluginDefinition.name}: routeInferenceQueries needs ${publicName} and ${twinName}`);
  }
  const twinNames = new Set(Object.values(routes));
  const operations = pluginDefinition.operations
    .filter((operation) => !twinNames.has(operation.name))
    .map((operation) => {
      const twin = byName.get(routes[operation.name]);
      if (!twin) return operation;
      const run = (context) => (containsInferenceInput(listInferenceCandidates(context.args)) ? twin.run(context) : operation.run(context));
      return { ...operation, run };
    });
  const restSpec = { ...pluginDefinition.restSpec, operations: pluginDefinition.restSpec.operations.filter((operation) => !twinNames.has(operation.name)) };
  return { ...pluginDefinition, operations, restSpec };
}
