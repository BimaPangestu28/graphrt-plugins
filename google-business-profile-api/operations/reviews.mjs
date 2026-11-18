/**
 * Reviews (My Business API v4, still the official reviews API): list, get, reply (create or edit), delete reply.
 */
import { paginationProperties, rejectInput } from "../lib/client.mjs";
import { ACCOUNT_ID_PROPERTY, LOCATION_ID_PROPERTY, normalizeResourceId, v4LocationPath } from "../lib/resource-names.mjs";

const REVIEW_ID_PROPERTY = { type: "string", description: "Review id (reviewId from list_reviews)" };
const MAX_REPLY_LENGTH = 4096;
const LOCATION_PARAMETERS = { account_id: ACCOUNT_ID_PROPERTY, location_id: LOCATION_ID_PROPERTY };

function reviewPath(args) {
  return `${v4LocationPath(args)}/reviews/${normalizeResourceId(args.review_id, "reviews", "review_id")}`;
}

export const reviewOperations = [
  {
    name: "list_reviews",
    title: "List Google Business Profile reviews",
    description: "List a verified location's reviews, newest first by default, with the average rating and total count.",
    parameters: {
      type: "object",
      properties: {
        ...LOCATION_PARAMETERS,
        order_by: { type: "string", enum: ["updateTime desc", "rating", "rating desc"], default: "updateTime desc" },
        ...paginationProperties(50, 50),
      },
      required: ["account_id", "location_id"],
    },
    run: async ({ client, args, signal }) => {
      const query = { orderBy: args.order_by, pageSize: args.limit, pageToken: args.cursor };
      const reviewPage = await client.my_business_v4.request({ path: `${v4LocationPath(args)}/reviews`, query, signal });
      return {
        data: { reviews: reviewPage?.reviews ?? [], average_rating: reviewPage?.averageRating ?? null, total_review_count: reviewPage?.totalReviewCount ?? 0 },
        next_cursor: reviewPage?.nextPageToken || null,
      };
    },
  },
  {
    name: "get_review",
    title: "Get Google Business Profile review",
    description: "Get one review with its star rating, comment and the owner's reply.",
    parameters: { type: "object", properties: { ...LOCATION_PARAMETERS, review_id: REVIEW_ID_PROPERTY }, required: ["account_id", "location_id", "review_id"] },
    run: async ({ client, args, signal }) => ({ data: await client.my_business_v4.request({ path: reviewPath(args), signal }) }),
  },
  {
    name: "reply_to_review",
    title: "Reply to Google Business Profile review",
    description: "Post the owner's public reply to a review, or replace the existing reply.",
    parameters: {
      type: "object",
      properties: { ...LOCATION_PARAMETERS, review_id: REVIEW_ID_PROPERTY, comment: { type: "string", minLength: 1, description: `Reply text (max ${MAX_REPLY_LENGTH} bytes)` } },
      required: ["account_id", "location_id", "review_id", "comment"],
    },
    run: async ({ client, args, signal }) => {
      if (Buffer.byteLength(args.comment, "utf8") > MAX_REPLY_LENGTH) rejectInput(`\`comment\` must be at most ${MAX_REPLY_LENGTH} bytes`);
      return { data: await client.my_business_v4.request({ method: "PUT", path: `${reviewPath(args)}/reply`, json: { comment: args.comment }, signal }) };
    },
  },
  {
    name: "delete_review_reply",
    title: "Delete Google Business Profile review reply",
    description: "Delete the owner's reply to a review.",
    parameters: { type: "object", properties: { ...LOCATION_PARAMETERS, review_id: REVIEW_ID_PROPERTY }, required: ["account_id", "location_id", "review_id"] },
    run: async ({ client, args, signal }) => {
      const { alreadyAbsent } = await client.deleteResource("my_business_v4", { path: `${reviewPath(args)}/reply`, signal });
      return { data: { deleted: true, ...(alreadyAbsent ? { already_absent: true } : {}), review_id: args.review_id } };
    },
  },
];
