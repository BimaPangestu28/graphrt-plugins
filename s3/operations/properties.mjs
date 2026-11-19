/**
 * Parameter schemas and checks shared by the s3 operations.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { TOOL_WRITES_VARIABLE } from "../lib/settings.mjs";

export const BUCKET_PROPERTY = { type: "string", minLength: 1, description: "Bucket name" };
export const KEY_PROPERTY = { type: "string", minLength: 1, description: "Object key, e.g. reports/2026/q3.pdf" };
export const VERSION_ID_PROPERTY = { type: "string", description: "Object version id (versioned buckets)" };
export const METADATA_PROPERTY = {
  type: "object",
  description: "User metadata stored with the object as x-amz-meta-<name> headers, e.g. {\"source\": \"graphrt\"}",
};
const METADATA_NAME_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const MAX_METADATA_BYTES = 2048;

/**
 * Refuses a write from an agent tool unless S3_TOOL_ALLOW_WRITES=1.
 *
 * @param context - Operation context `{source, client}` (object)
 * @param operationName - For the message (string)
 * @throws PluginError kind `permission_denied`
 */
export function assertToolWriteAllowed({ source, client }, operationName) {
  if (source !== "tool" || client.settings.allowToolWrites) return;
  throw new PluginError(`\`${operationName}\` is disabled for agent tools; set ${TOOL_WRITES_VARIABLE}=1 to allow it, or use a workflow node`, { kind: "permission_denied" });
}

/**
 * Refuses an agent tool call on a bucket outside S3_ALLOWED_BUCKETS (when it is set): the bucket and, for copies,
 * the source bucket, so an agent can neither read nor copy data into or out of other buckets.
 *
 * @param context - Operation context `{source, client, args}` (object)
 * @throws PluginError kind `permission_denied`
 */
export function assertToolBucketsAllowed({ source, client, args }) {
  const allowedBuckets = client.settings.allowedBuckets;
  if (source !== "tool" || !allowedBuckets) return;
  const refusedBucket = [args.bucket, args.source_bucket].find((bucket) => bucket !== undefined && !allowedBuckets.has(bucket));
  if (refusedBucket === undefined) return;
  throw new PluginError(`Bucket ${JSON.stringify(refusedBucket)} is not in S3_ALLOWED_BUCKETS for agent tools; use a workflow node or add it`, { kind: "permission_denied" });
}

/**
 * Checks a header value: printable ASCII without CR/LF (S3 metadata and content headers must be ASCII).
 *
 * @param name - Argument name, for the message (string)
 * @param value - Header value (string | undefined)
 * @returns The value (string | undefined)
 * @throws PluginError kind `invalid_input`
 */
export function checkHeaderValue(name, value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[\x20-\x7e]*$/.test(value)) {
    throw new PluginError(`\`${name}\` must be printable ASCII text without line breaks`, { kind: "invalid_input" });
  }
  return value;
}

/**
 * Turns `{name: value}` metadata into x-amz-meta-* headers.
 *
 * @param metadata - User metadata (object, optional)
 * @returns Headers (object)
 * @throws PluginError kind `invalid_input` - Bad names, non-string values, or more than 2 KB in total
 */
export function buildMetadataHeaders(metadata) {
  const headers = {};
  let totalBytes = 0;
  for (const [metadataName, metadataValue] of Object.entries(metadata ?? {})) {
    if (!METADATA_NAME_PATTERN.test(metadataName)) throw new PluginError(`Metadata name ${JSON.stringify(metadataName)} must use letters, digits and "-" only`, { kind: "invalid_input" });
    if (typeof metadataValue !== "string") throw new PluginError(`Metadata ${JSON.stringify(metadataName)} must be a string`, { kind: "invalid_input" });
    headers[`x-amz-meta-${metadataName.toLowerCase()}`] = checkHeaderValue(`metadata.${metadataName}`, metadataValue);
    totalBytes += metadataName.length + metadataValue.length;
  }
  if (totalBytes > MAX_METADATA_BYTES) throw new PluginError("User metadata is larger than S3's 2 KB limit", { kind: "invalid_input" });
  return headers;
}

/**
 * Reads x-amz-meta-* response headers back into an object.
 *
 * @param headers - Response headers (Headers)
 * @returns `{name: value}` (object)
 */
export function readMetadataHeaders(headers) {
  const metadata = {};
  for (const [headerName, headerValue] of headers) {
    if (headerName.startsWith("x-amz-meta-")) metadata[headerName.slice("x-amz-meta-".length)] = headerValue;
  }
  return metadata;
}
