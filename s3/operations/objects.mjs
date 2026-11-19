/**
 * Object operations: head, get (to a file in S3_DOWNLOAD_DIR or as capped text), put (from a file in S3_UPLOAD_DIR
 * or from text), copy, delete (node only) and presigned GET URLs (node only: the URL is a bearer credential).
 */
import { extname } from "node:path";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { MAX_PRESIGN_SECONDS, uriEncode } from "../lib/aws-sigv4.mjs";
import { chooseDownloadFileName, readCappedText, readUploadFile, saveStreamToDownloadFile } from "../lib/local-files.mjs";
import { assertBucketName, encodeKey } from "../lib/s3-transport.mjs";
import { childText } from "../lib/xml.mjs";
import { parseS3Xml } from "./listing.mjs";
import { assertToolWriteAllowed, BUCKET_PROPERTY, buildMetadataHeaders, checkHeaderValue, KEY_PROPERTY, METADATA_PROPERTY, readMetadataHeaders, VERSION_ID_PROPERTY } from "./properties.mjs";

const CONTENT_TYPES_BY_EXTENSION = {
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};
const RANGE_PATTERN = /^bytes=\d*-\d*$/;

function summarizeHead(args, headers) {
  const size = Number(headers.get("content-length"));
  return {
    bucket: args.bucket,
    key: args.key,
    size: Number.isFinite(size) ? size : null,
    content_type: headers.get("content-type"),
    etag: headers.get("etag"),
    last_modified: headers.get("last-modified"),
    version_id: headers.get("x-amz-version-id"),
    storage_class: headers.get("x-amz-storage-class"),
    cache_control: headers.get("cache-control"),
    content_encoding: headers.get("content-encoding"),
    content_disposition: headers.get("content-disposition"),
    metadata: readMetadataHeaders(headers),
  };
}

function checkRange(range) {
  if (range !== undefined && !RANGE_PATTERN.test(range)) throw new PluginError("`range` must look like bytes=0-1023 or bytes=-500", { kind: "invalid_input" });
  return range;
}

// A failure while the body is streaming (connection reset, timeout) is a network error; reads are safe to repeat.
async function readBodySafely(readBody, { signal, redact }) {
  try {
    return await readBody();
  } catch (bodyError) {
    if (bodyError instanceof PluginError) throw bodyError;
    if (signal?.aborted) throw new PluginError("S3 download cancelled", { kind: "cancelled" });
    const reason = bodyError?.name === "TimeoutError" ? "download timed out" : String(bodyError?.cause?.code ?? bodyError?.message ?? bodyError);
    throw new PluginError(redact(`Network error while reading the object: ${reason}`), { kind: "network_error", retryable: true });
  }
}

async function getObjectToFile({ client, args, signal }) {
  const { settings, transport } = client;
  const fileName = chooseDownloadFileName(args.key, args.file_name);
  const headers = { range: checkRange(args.range) };
  const response = await transport.request({ method: "GET", bucket: args.bucket, key: args.key, query: { versionId: args.version_id }, headers, stream: true, signal, timeoutMs: settings.transferTimeoutMs });
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > settings.maxDownloadBytes) {
    await response.response.body?.cancel();
    throw new PluginError(`The object is larger than S3_MAX_DOWNLOAD_BYTES (${settings.maxDownloadBytes} bytes); nothing was saved`, { kind: "invalid_input" });
  }
  const target = { downloadDirectory: settings.downloadDirectory, fileName, maxBytes: settings.maxDownloadBytes };
  const saved = await readBodySafely(() => saveStreamToDownloadFile(response.response.body ?? [], target), { signal, redact: transport.redact });
  return { bucket: args.bucket, key: args.key, path: saved.path, bytes: saved.bytes, content_type: response.headers.get("content-type"), etag: response.headers.get("etag") };
}

async function getObjectAsText({ client, args, signal }) {
  const { settings, transport } = client;
  const range = checkRange(args.range) ?? `bytes=0-${settings.maxTextBytes}`;
  const requestOptions = { method: "GET", bucket: args.bucket, key: args.key, query: { versionId: args.version_id }, stream: true, signal, timeoutMs: settings.transferTimeoutMs };
  let response;
  try {
    response = await transport.request({ ...requestOptions, headers: { range } });
  } catch (requestError) {
    // An empty object has no byte 0: S3 answers 416 to our default range, so read it without one.
    if (args.range !== undefined || !/S3 error 416/.test(requestError.message)) throw requestError;
    response = await transport.request(requestOptions);
  }
  const { text, bytesRead, truncated } = await readBodySafely(() => readCappedText(response.response.body ?? [], settings.maxTextBytes), { signal, redact: transport.redact });
  const totalBytes = Number(/\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1] ?? response.headers.get("content-length"));
  return { bucket: args.bucket, key: args.key, text, bytes_read: bytesRead, total_bytes: Number.isFinite(totalBytes) ? totalBytes : null, truncated, content_type: response.headers.get("content-type"), etag: response.headers.get("etag") };
}

async function readPutBody(args, settings) {
  const hasFile = args.file_path !== undefined;
  if (hasFile === (args.text !== undefined)) throw new PluginError("Pass exactly one of `file_path` or `text`", { kind: "invalid_input" });
  if (!hasFile) {
    const bytes = Buffer.from(args.text, "utf8");
    if (bytes.length > settings.maxUploadBytes) throw new PluginError(`\`text\` is larger than S3_MAX_UPLOAD_BYTES (${settings.maxUploadBytes} bytes)`, { kind: "invalid_input" });
    return { bytes, contentType: "text/plain; charset=utf-8" };
  }
  const { bytes, realPath } = await readUploadFile(args.file_path, { uploadDirectory: settings.uploadDirectory, maxBytes: settings.maxUploadBytes });
  return { bytes, contentType: CONTENT_TYPES_BY_EXTENSION[extname(realPath).toLowerCase()] ?? "application/octet-stream" };
}

async function putObject(context) {
  const { client, args, signal } = context;
  assertToolWriteAllowed(context, "put_object");
  const { bytes, contentType } = await readPutBody(args, client.settings);
  const headers = {
    "content-type": checkHeaderValue("content_type", args.content_type) ?? contentType,
    "cache-control": checkHeaderValue("cache_control", args.cache_control),
    "content-disposition": checkHeaderValue("content_disposition", args.content_disposition),
    "x-amz-storage-class": args.storage_class,
    "if-none-match": args.only_if_absent ? "*" : undefined,
    ...buildMetadataHeaders(args.metadata),
  };
  const definedHeaders = Object.fromEntries(Object.entries(headers).filter(([, headerValue]) => headerValue !== undefined));
  // A conditional put that is retried after an unknown outcome would fail with 412 although it succeeded: never retry it.
  const response = await client.transport.request({ method: "PUT", bucket: args.bucket, key: args.key, headers: definedHeaders, body: bytes, signal, timeoutMs: client.settings.transferTimeoutMs, idempotent: !args.only_if_absent });
  return { bucket: args.bucket, key: args.key, bytes: bytes.length, etag: response.headers.get("etag"), version_id: response.headers.get("x-amz-version-id") };
}

async function copyObject(context) {
  const { client, args, signal } = context;
  assertToolWriteAllowed(context, "copy_object");
  assertBucketName(args.source_bucket);
  const versionSuffix = args.source_version_id ? `?versionId=${uriEncode(args.source_version_id, true)}` : "";
  const isReplace = args.metadata_directive === "REPLACE";
  if (!isReplace && (args.metadata !== undefined || args.content_type !== undefined)) {
    throw new PluginError("`metadata` and `content_type` need metadata_directive REPLACE (COPY keeps the source's)", { kind: "invalid_input" });
  }
  const headers = {
    "x-amz-copy-source": `/${uriEncode(args.source_bucket, true)}/${encodeKey(args.source_key)}${versionSuffix}`,
    "x-amz-source-expected-bucket-owner": client.settings.expectedBucketOwner,
    "x-amz-metadata-directive": args.metadata_directive,
    ...(isReplace ? { "content-type": checkHeaderValue("content_type", args.content_type) ?? "application/octet-stream", ...buildMetadataHeaders(args.metadata) } : {}),
  };
  const response = await client.transport.request({ method: "PUT", bucket: args.bucket, key: args.key, headers, signal, timeoutMs: client.settings.transferTimeoutMs });
  const result = parseS3Xml(response.bodyText, "CopyObjectResult");
  return { bucket: args.bucket, key: args.key, etag: childText(result, "ETag") ?? null, last_modified: childText(result, "LastModified") ?? null, version_id: response.headers.get("x-amz-version-id") };
}

export const objectOperations = [
  {
    name: "head_object",
    title: "Get object metadata",
    description: "Read an object's size, content type, ETag, dates and user metadata without downloading it",
    parameters: { type: "object", properties: { bucket: BUCKET_PROPERTY, key: KEY_PROPERTY, version_id: VERSION_ID_PROPERTY }, required: ["bucket", "key"] },
    run: async ({ client, args, signal }) => {
      const response = await client.transport.request({ method: "HEAD", bucket: args.bucket, key: args.key, query: { versionId: args.version_id }, signal });
      return { data: summarizeHead(args, response.headers) };
    },
  },
  {
    name: "get_object",
    title: "Download object",
    description: "Download an object: output \"file\" streams it into S3_DOWNLOAD_DIR (size-capped) and returns the path; output \"text\" returns up to S3_MAX_TEXT_BYTES as UTF-8 text with a truncated flag",
    parameters: {
      type: "object",
      properties: {
        bucket: BUCKET_PROPERTY,
        key: KEY_PROPERTY,
        output: { type: "string", enum: ["file", "text"], default: "file", description: "file (save into S3_DOWNLOAD_DIR) or text (return the content, capped)" },
        file_name: { type: "string", description: "File name inside S3_DOWNLOAD_DIR (default: the key's last segment); never overwrites an existing file" },
        range: { type: "string", description: "Byte range, e.g. bytes=0-1023" },
        version_id: VERSION_ID_PROPERTY,
      },
      required: ["bucket", "key"],
    },
    run: async (context) => ({ data: context.args.output === "text" ? await getObjectAsText(context) : await getObjectToFile(context) }),
  },
  {
    name: "put_object",
    title: "Upload object",
    description: "Upload an object from a file inside S3_UPLOAD_DIR or from text; replaces an existing object unless only_if_absent (as an agent tool only when S3_TOOL_ALLOW_WRITES=1)",
    parameters: {
      type: "object",
      properties: {
        bucket: BUCKET_PROPERTY,
        key: KEY_PROPERTY,
        file_path: { type: "string", description: "Absolute path of a file inside S3_UPLOAD_DIR" },
        text: { type: "string", description: "Text content to upload (UTF-8), instead of file_path" },
        content_type: { type: "string", description: "Content-Type (default: from the file extension, text/plain for text)" },
        cache_control: { type: "string", description: "Cache-Control header to store" },
        content_disposition: { type: "string", description: "Content-Disposition header to store, e.g. attachment; filename=\"report.pdf\"" },
        storage_class: { type: "string", enum: ["STANDARD", "STANDARD_IA", "ONEZONE_IA", "INTELLIGENT_TIERING", "GLACIER_IR", "GLACIER", "DEEP_ARCHIVE", "REDUCED_REDUNDANCY"], description: "Storage class (AWS)" },
        metadata: METADATA_PROPERTY,
        only_if_absent: { type: "boolean", default: false, description: "Fail with 412 instead of replacing an existing object (If-None-Match: *)" },
      },
      required: ["bucket", "key"],
    },
    run: async (context) => ({ data: await putObject(context) }),
  },
  {
    name: "copy_object",
    title: "Copy object",
    description: "Copy an object (up to 5 GB) to another key or bucket on the server side (as an agent tool only when S3_TOOL_ALLOW_WRITES=1)",
    parameters: {
      type: "object",
      properties: {
        source_bucket: BUCKET_PROPERTY,
        source_key: KEY_PROPERTY,
        source_version_id: VERSION_ID_PROPERTY,
        bucket: { ...BUCKET_PROPERTY, description: "Destination bucket" },
        key: { ...KEY_PROPERTY, description: "Destination key" },
        metadata_directive: { type: "string", enum: ["COPY", "REPLACE"], default: "COPY", description: "COPY keeps the source metadata; REPLACE uses metadata and content_type" },
        metadata: METADATA_PROPERTY,
        content_type: { type: "string", description: "Content-Type for the copy (with REPLACE)" },
      },
      required: ["source_bucket", "source_key", "bucket", "key"],
    },
    run: async (context) => ({ data: await copyObject(context) }),
  },
  {
    name: "delete_object",
    title: "Delete object",
    description: "Delete an object (or one version of it); workflow nodes only",
    nodeOnly: true,
    parameters: { type: "object", properties: { bucket: BUCKET_PROPERTY, key: KEY_PROPERTY, version_id: VERSION_ID_PROPERTY }, required: ["bucket", "key"] },
    run: async ({ client, args, signal }) => {
      const response = await client.transport.request({ method: "DELETE", bucket: args.bucket, key: args.key, query: { versionId: args.version_id }, signal });
      return { data: { deleted: true, bucket: args.bucket, key: args.key, version_id: response.headers.get("x-amz-version-id"), delete_marker: response.headers.get("x-amz-delete-marker") === "true" } };
    },
  },
  {
    name: "presign_get_url",
    title: "Presigned download URL",
    description: "Create a presigned GET URL that lets anyone holding it download the object until it expires; workflow nodes only",
    nodeOnly: true,
    parameters: {
      type: "object",
      properties: {
        bucket: BUCKET_PROPERTY,
        key: KEY_PROPERTY,
        version_id: VERSION_ID_PROPERTY,
        expires_in_seconds: { type: "integer", minimum: 1, maximum: MAX_PRESIGN_SECONDS, default: 3600, description: "Lifetime in seconds (at most 7 days; temporary credentials expire sooner)" },
        response_content_disposition: { type: "string", description: "Content-Disposition the download should get, e.g. attachment; filename=\"a.pdf\"" },
        response_content_type: { type: "string", description: "Content-Type the download should get" },
      },
      required: ["bucket", "key"],
    },
    run: async ({ client, args }) => {
      const query = {
        "response-content-disposition": checkHeaderValue("response_content_disposition", args.response_content_disposition),
        "response-content-type": checkHeaderValue("response_content_type", args.response_content_type),
        versionId: args.version_id,
      };
      const url = client.presign({ bucket: args.bucket, key: args.key, query, expiresInSeconds: args.expires_in_seconds });
      return { data: { url, method: "GET", expires_at: new Date(client.now().getTime() + args.expires_in_seconds * 1000).toISOString() } };
    },
  },
];
