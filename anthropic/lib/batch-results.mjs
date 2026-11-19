/**
 * Message Batch results for the anthropic plugin.
 *
 * `GET /v1/messages/batches/{id}/results` answers with JSON Lines (one result per line, in any order) and can be
 * large (up to 100,000 results). This hand-written operation streams the body through the plugin's own client (same
 * credential, retries and error mapping), parses it line by line under a byte cap, keeps only the results that match
 * `result_type` / `custom_ids` after `offset`, and redacts the credential from every kept result.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { pathSegment } from "./shared/path.mjs";
import { truncateForTool } from "./shared/rest-response.mjs";

const RESULT_TYPES = ["succeeded", "errored", "canceled", "expired"];
const RESULTS_TIMEOUT_MS = 280000;
export const MAX_RESULTS_BYTES = 100 * 1024 * 1024;
const TOOL_OUTPUT = { maxItems: 100, maxChars: 100000 };
const MAX_CUSTOM_IDS = 1000;

/**
 * Parses JSON Lines text: one JSON value per non-empty line.
 *
 * @param jsonLinesText - JSONL text (string)
 * @returns Parsed values in file order (any[])
 * @throws PluginError kind `api_error` - When a line is not JSON (the line number is named)
 *
 * @example
 * parseJsonLines('{"a":1}\n{"a":2}\n'); // [{a: 1}, {a: 2}]
 */
export function parseJsonLines(jsonLinesText) {
  return jsonLinesText.split(/\r?\n/).flatMap((line, index) => {
    const parsedLine = parseLine(line, index + 1);
    return parsedLine === undefined ? [] : [parsedLine];
  });
}

function parseLine(line, lineNumber) {
  if (line.trim() === "") return undefined;
  try {
    return JSON.parse(line);
  } catch {
    throw new PluginError(`Batch results line ${lineNumber} is not JSON`, { kind: "api_error", retryable: false });
  }
}

/**
 * Reads a JSON Lines byte stream line by line, calling `onValue` for each parsed line.
 *
 * @param byteStream - Response body (ReadableStream<Uint8Array>)
 * @param options - `{maxBytes, onValue}`: the byte cap and `(value) => void` (object)
 * @returns Nothing once the stream ends (Promise<void>)
 * @throws PluginError kind `api_error` - A line is not JSON, or the body is larger than maxBytes
 */
export async function readJsonLinesStream(byteStream, { maxBytes, onValue }) {
  const decoder = new TextDecoder();
  let pendingText = "";
  let byteCount = 0;
  let lineNumber = 0;
  for await (const chunk of byteStream) {
    byteCount += chunk.byteLength;
    if (byteCount > maxBytes) throw tooLarge(maxBytes);
    const lines = (pendingText + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
    pendingText = lines.pop();
    for (const line of lines) emitLine(line, (lineNumber += 1), onValue);
  }
  emitLine(pendingText + decoder.decode(), lineNumber + 1, onValue);
}

function emitLine(line, lineNumber, onValue) {
  const parsedLine = parseLine(line, lineNumber);
  if (parsedLine !== undefined) onValue(parsedLine);
}

function tooLarge(maxBytes) {
  return new PluginError(`Batch results are larger than ${maxBytes} bytes; filter them with custom_ids or result_type, or split the batch`, { kind: "api_error", retryable: false });
}

/**
 * Builds the `get_message_batch_results` operation.
 *
 * @returns Operation `{name, title, description, parameters, run}` for operations.mjs (object)
 */
export function createBatchResultsOperation() {
  return {
    name: "get_message_batch_results",
    title: "Get message batch results",
    description:
      "Results of an ended message batch as a list of {custom_id, result: {type: succeeded|errored|canceled|expired, message|error}} in any order; filter with custom_ids or result_type and page with offset (agents see 100 at a time)",
    parameters: {
      type: "object",
      properties: {
        batch_id: { type: "string", description: "Message batch id (msgbatch_...); processing_status must be ended" },
        result_type: { type: "string", enum: RESULT_TYPES, description: "Only results of this type" },
        custom_ids: { type: "array", items: { type: "string" }, maxItems: MAX_CUSTOM_IDS, description: "Only results with these custom_ids" },
        offset: { type: "integer", minimum: 0, default: 0, description: "Skip this many matching results (file order), e.g. 100 for the second page" },
      },
      required: ["batch_id"],
    },
    run: fetchBatchResults,
  };
}

async function fetchBatchResults({ client, args, signal, source }) {
  const response = await client.requestWithHeaders({
    method: "GET",
    path: `/v1/messages/batches/${pathSegment(args.batch_id)}/results`,
    signal,
    rawResponse: true,
    redactResponse: true,
    timeoutMs: RESULTS_TIMEOUT_MS,
  });
  const results = await collectMatchingResults(response, args);
  return { data: source === "tool" ? truncateForTool(results, TOOL_OUTPUT) : results, next_cursor: null };
}

async function collectMatchingResults(response, args) {
  const isWanted = buildResultFilter(args);
  const results = [];
  let skippedCount = 0;
  await readJsonLinesStream(response.response.body ?? new Response("").body, {
    maxBytes: MAX_RESULTS_BYTES,
    onValue: (batchResult) => {
      if (!isWanted(batchResult)) return;
      if (skippedCount < args.offset) return void (skippedCount += 1);
      results.push(response.redact(batchResult));
    },
  });
  return results;
}

function buildResultFilter({ result_type: resultType, custom_ids: customIds }) {
  const wantedIds = customIds?.length ? new Set(customIds) : undefined;
  return (batchResult) => (!resultType || batchResult?.result?.type === resultType) && (!wantedIds || wantedIds.has(batchResult?.custom_id));
}
