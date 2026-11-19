/**
 * BMKG-specific result shaping on top of the declarative operations:
 * - argument checks the schema cannot express (adm4 village codes, nowcast alert codes), before any request;
 * - shaping: shakemap URLs for earthquakes, a flat forecast list, parsed RSS/CAP XML for nowcast warnings.
 *
 * The wrapped operation is run as a node (untruncated) so XML bodies are parsed whole; agent tool results are
 * truncated afterwards with the layer's own truncateForTool. Workflow nodes get everything, as with every operation.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";

/** BMKG serves shakemap images next to the earthquake JSON files. */
export const SHAKEMAP_BASE_URL = "https://data.bmkg.go.id/DataMKG/TEWS/";
/** Kemendagri village (adm4) code: province.regency.district.village, e.g. 31.71.03.1001. */
export const ADM4_PATTERN = /^\d{2}\.\d{2}\.\d{2}\.\d{4}$/;
/** Nowcast alert code from the RSS links, e.g. CNB20261119002. */
export const ALERT_CODE_PATTERN = /^[A-Za-z0-9]+$/;
/** BMKG bodies are 10-20 KB (a CAP alert with polygons stays well under 1 MB); anything over this is refused unparsed. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PAYLOAD_TOO_LARGE = 413;

function buildTooLargeResponse(maxBytes) {
  const body = JSON.stringify({ error: `BMKG response is larger than ${maxBytes} bytes; refused without parsing` });
  return new Response(body, { status: PAYLOAD_TOO_LARGE, headers: { "content-type": "application/json" } });
}

async function readCappedBody(body, maxBytes) {
  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, totalBytes);
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
}

/**
 * Wraps fetch so a response body is read at most up to `maxBytes`. A larger body (by Content-Length or while
 * streaming) is cancelled and replaced by a 413 `{error}` response, which the client reports as a non-retryable
 * api_error, so XML and JSON are never parsed from an unbounded buffer.
 *
 * @param fetchImpl - The fetch to wrap (function)
 * @param maxBytes - Maximum body size in bytes (number)
 * @returns A fetch-compatible function (function)
 *
 * @example
 * const cappedFetch = createCappedFetch(globalThis.fetch, MAX_RESPONSE_BYTES);
 */
export function createCappedFetch(fetchImpl, maxBytes) {
  return async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!response.body) return response;
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body.cancel();
      return buildTooLargeResponse(maxBytes);
    }
    const bodyBytes = await readCappedBody(response.body, maxBytes);
    if (!bodyBytes) return buildTooLargeResponse(maxBytes);
    const responseInit = { status: response.status, statusText: response.statusText, headers: response.headers };
    return new Response(bodyBytes.byteLength === 0 ? null : bodyBytes, responseInit);
  };
}

/**
 * Returns the definition with every request's response body capped (see createCappedFetch).
 *
 * @param pluginDefinition - Plugin definition with createClient (object)
 * @param maxBytes - Maximum body size in bytes (number, default MAX_RESPONSE_BYTES)
 * @returns A new definition (object)
 */
export function capResponseBodies(pluginDefinition, maxBytes = MAX_RESPONSE_BYTES) {
  const createClient = (clientOptions) => {
    const baseFetch = clientOptions.fetchImpl ?? ((...fetchArguments) => globalThis.fetch(...fetchArguments));
    return pluginDefinition.createClient({ ...clientOptions, fetchImpl: createCappedFetch(baseFetch, maxBytes) });
  };
  return { ...pluginDefinition, createClient };
}

/**
 * Checks an argument against a pattern and throws a clear invalid_input error.
 *
 * @param argumentName - Parameter name, for the message (string)
 * @param argumentValue - The value (string)
 * @param pattern - Pattern it must match (RegExp)
 * @param example - Example of a valid value, for the message (string)
 * @returns Nothing
 * @throws PluginError kind `invalid_input` - The value does not match
 */
export function assertArgumentPattern(argumentName, argumentValue, pattern, example) {
  if (typeof argumentValue === "string" && pattern.test(argumentValue)) return;
  throw new PluginError(`\`${argumentName}\` must look like ${example}; got ${JSON.stringify(argumentValue)}`, { kind: "invalid_input" });
}

/**
 * Adds `shakemap_url` to an earthquake record that names a shakemap file.
 *
 * @param earthquake - BMKG earthquake record (object)
 * @returns The record, with `shakemap_url` when `Shakemap` is a plain file name (object)
 */
export function addShakemapUrl(earthquake) {
  const shakemapFile = earthquake?.Shakemap;
  if (typeof shakemapFile !== "string" || !/^[\w.-]+\.(jpg|png)$/i.test(shakemapFile)) return earthquake;
  return { ...earthquake, shakemap_url: `${SHAKEMAP_BASE_URL}${shakemapFile}` };
}

/**
 * Flattens BMKG's village forecast `{lokasi, data: [{lokasi, cuaca: [[...], [...]]}]}` into one list.
 *
 * @param forecastBody - Response of /publik/prakiraan-cuaca (object)
 * @returns `{location, forecasts}` with forecasts in time order, or the body unchanged when it has another shape (object)
 */
export function flattenForecast(forecastBody) {
  const [firstLocation] = Array.isArray(forecastBody?.data) ? forecastBody.data : [];
  if (!firstLocation || !Array.isArray(firstLocation.cuaca)) return forecastBody;
  return { location: forecastBody.lokasi ?? firstLocation.lokasi ?? null, forecasts: firstLocation.cuaca.flat() };
}

/**
 * Returns the definition with the named operations' arguments checked and their `data` shaped.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @param shapers - `{operationName: {extraParameters?, checkArgs?(args), shapeData?(data, args)}}`; extraParameters are
 *   JSON-schema properties added to the operation that only steer shaping and are never sent (object)
 * @returns A new definition; other operations are unchanged (object)
 */
export function shapeOperationResults(pluginDefinition, shapers) {
  const wrapOperation = (operation) => {
    const shaper = shapers[operation.name];
    if (!shaper) return operation;
    const run = async (context) => {
      shaper.checkArgs?.(context.args);
      const result = await operation.run({ ...context, source: "node" });
      const data = shaper.shapeData ? shaper.shapeData(result.data, context.args) : result.data;
      const toolData = context.source === "tool" ? truncateForTool(data, DEFAULT_TOOL_OUTPUT) : data;
      return { ...result, data: toolData };
    };
    const parameters = { ...operation.parameters, properties: { ...operation.parameters.properties, ...shaper.extraParameters } };
    return { ...operation, parameters, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
