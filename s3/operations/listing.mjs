/**
 * Listing operations: buckets (ListBuckets) and objects (ListObjectsV2 with continuation tokens).
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { childText, findChild, findChildren, parseXml } from "../lib/xml.mjs";
import { BUCKET_PROPERTY } from "./properties.mjs";

const MAX_LIST_KEYS = 1000;

/**
 * Parses an XML response body, mapping parse failures to api_error.
 *
 * @param bodyText - Response body (string)
 * @param expectedRoot - Expected root element name (string)
 * @returns Root element (object)
 * @throws PluginError kind `api_error` - When the body is not the expected XML document
 */
export function parseS3Xml(bodyText, expectedRoot) {
  let root;
  try {
    root = parseXml(bodyText);
  } catch (parseError) {
    throw new PluginError(`S3 returned an unreadable response: ${parseError.message}`, { kind: "api_error" });
  }
  if (root.name !== expectedRoot) throw new PluginError(`S3 returned <${root.name}> where <${expectedRoot}> was expected`, { kind: "api_error" });
  return root;
}

// With encoding-type=url, S3 percent-encodes keys and prefixes (spaces as "+"), so any key survives XML.
function decodeUrlEncoded(value) {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function summarizeObject(contents, isUrlEncoded) {
  const size = Number(childText(contents, "Size"));
  return {
    key: isUrlEncoded ? decodeUrlEncoded(childText(contents, "Key")) : childText(contents, "Key"),
    size: Number.isFinite(size) ? size : null,
    last_modified: childText(contents, "LastModified") ?? null,
    etag: childText(contents, "ETag") ?? null,
    storage_class: childText(contents, "StorageClass") ?? null,
  };
}

function summarizeListing(root) {
  const isUrlEncoded = childText(root, "EncodingType") === "url";
  const isTruncated = childText(root, "IsTruncated") === "true";
  const nextToken = childText(root, "NextContinuationToken");
  return {
    data: {
      bucket: childText(root, "Name") ?? null,
      prefix: decodeUrlEncoded(childText(root, "Prefix")) ?? "",
      objects: findChildren(root, "Contents").map((contents) => summarizeObject(contents, isUrlEncoded)),
      common_prefixes: findChildren(root, "CommonPrefixes").map((commonPrefix) => (isUrlEncoded ? decodeUrlEncoded(childText(commonPrefix, "Prefix")) : childText(commonPrefix, "Prefix"))),
      key_count: Number(childText(root, "KeyCount") ?? 0),
      is_truncated: isTruncated,
    },
    next_cursor: isTruncated && nextToken ? nextToken : null,
  };
}

function summarizeBuckets(root) {
  const buckets = findChildren(findChild(root, "Buckets"), "Bucket").map((bucket) => ({
    name: childText(bucket, "Name") ?? null,
    created_at: childText(bucket, "CreationDate") ?? null,
    region: childText(bucket, "BucketRegion") ?? null,
  }));
  return { data: { buckets, owner: childText(findChild(root, "Owner"), "DisplayName") ?? null }, next_cursor: childText(root, "ContinuationToken") ?? null };
}

export const listingOperations = [
  {
    name: "list_buckets",
    title: "List buckets",
    description: "List the buckets the credentials can see (name, creation date, region)",
    parameters: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Only buckets whose name starts with this" },
        limit: { type: "integer", minimum: 1, maximum: 10000, description: "Maximum buckets per page (AWS only; other stores return all)" },
        cursor: { type: "string", description: "next_cursor from the previous call" },
      },
    },
    run: async ({ client, args, signal, source }) => {
      const query = { prefix: args.prefix, "max-buckets": args.limit, "continuation-token": args.cursor };
      const response = await client.transport.request({ method: "GET", query, signal });
      const listing = summarizeBuckets(parseS3Xml(response.bodyText, "ListAllMyBucketsResult"));
      const allowedBuckets = client.settings.allowedBuckets;
      if (source !== "tool" || !allowedBuckets) return listing;
      return { ...listing, data: { ...listing.data, buckets: listing.data.buckets.filter((bucket) => allowedBuckets.has(bucket.name)) } };
    },
  },
  {
    name: "list_objects",
    title: "List objects",
    description: "List objects in a bucket (ListObjectsV2): keys, sizes, dates; prefix and delimiter for folders; paginated with next_cursor",
    parameters: {
      type: "object",
      properties: {
        bucket: BUCKET_PROPERTY,
        prefix: { type: "string", description: "Only keys that start with this, e.g. reports/2026/" },
        delimiter: { type: "string", description: "Group keys by this character into common_prefixes, usually /" },
        start_after: { type: "string", description: "Start listing after this key" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_KEYS, default: 100, description: "Maximum keys per page (1 to 1000)" },
        cursor: { type: "string", description: "next_cursor from the previous call" },
      },
      required: ["bucket"],
    },
    run: async ({ client, args, signal }) => {
      const query = {
        "list-type": "2",
        "encoding-type": "url",
        prefix: args.prefix,
        delimiter: args.delimiter,
        "start-after": args.start_after,
        "max-keys": args.limit,
        "continuation-token": args.cursor,
      };
      const response = await client.transport.request({ method: "GET", bucket: args.bucket, query, signal });
      return summarizeListing(parseS3Xml(response.bodyText, "ListBucketResult"));
    },
  },
];
