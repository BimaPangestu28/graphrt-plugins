/**
 * Business Profile resource names. Ids are accepted bare ("123"), with their
 * collection prefix ("accounts/123", "locations/456") or as a full resource name
 * ("accounts/1/locations/2/reviews/X"), and are checked against a strict
 * character set, so they can never add path segments or queries.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Normalizes an id: a bare id is kept; in a resource name made of `<collection>/<id>` pairs, the id that follows
 * the last `<collection>` segment is used.
 *
 * @param rawId - Id from the arguments (string)
 * @param collection - "accounts", "locations", "reviews" or "localPosts" (string)
 * @param argumentName - Argument name for error messages (string)
 * @returns The bare id (string)
 * @throws PluginError kind `invalid_input` - When the id has other characters
 *
 * @example
 * normalizeResourceId("accounts/123", "accounts", "account_id"); // "123"
 * normalizeResourceId("accounts/1/locations/2/reviews/X", "reviews", "review_id"); // "X"
 */
export function normalizeResourceId(rawId, collection, argumentName) {
  const bareId = extractIdFromResourceName(String(rawId ?? "").trim(), collection);
  if (bareId === null || !RESOURCE_ID_PATTERN.test(bareId)) {
    throw new PluginError(`\`${argumentName}\` must be an id like "123", "${collection}/123" or a full resource name, got ${JSON.stringify(rawId)}`, {
      kind: "invalid_input",
    });
  }
  return bareId;
}

function extractIdFromResourceName(trimmedId, collection) {
  const segments = trimmedId.split("/");
  if (segments.length === 1) return trimmedId;
  if (segments.length % 2 !== 0) return null;
  const collectionIndex = segments.findLastIndex((segment, segmentIndex) => segmentIndex % 2 === 0 && segment === collection);
  return collectionIndex === -1 ? null : segments[collectionIndex + 1];
}

/**
 * Builds the v4 location path `/accounts/{account}/locations/{location}`.
 *
 * @param args - Operation arguments with `account_id` and `location_id` (object)
 * @returns API path (string)
 */
export function v4LocationPath(args) {
  return `/accounts/${normalizeResourceId(args.account_id, "accounts", "account_id")}/locations/${normalizeResourceId(args.location_id, "locations", "location_id")}`;
}

/**
 * Builds `/locations/{location}` for the v1 APIs.
 *
 * @param rawLocationId - Location id (string)
 * @returns API path (string)
 */
export function v1LocationPath(rawLocationId) {
  return `/locations/${normalizeResourceId(rawLocationId, "locations", "location_id")}`;
}

export const ACCOUNT_ID_PROPERTY = { type: "string", description: 'Account id from list_accounts, e.g. "123", "accounts/123" or a full resource name' };
export const LOCATION_ID_PROPERTY = { type: "string", description: 'Location id from list_locations, e.g. "456", "locations/456" or "accounts/1/locations/456"' };
