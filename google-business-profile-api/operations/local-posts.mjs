/**
 * Local posts (My Business API v4): list, create (STANDARD / EVENT / OFFER) and delete
 * the updates shown on a location's Business Profile.
 */
import { paginationProperties, rejectInput, withWriteOutcomeHint } from "../lib/client.mjs";
import { parseDateWithOptionalTime } from "../lib/date-time.mjs";
import { ACCOUNT_ID_PROPERTY, LOCATION_ID_PROPERTY, normalizeResourceId, v4LocationPath } from "../lib/resource-names.mjs";

const CALL_TO_ACTION_TYPES = ["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"];
const MAX_SUMMARY_LENGTH = 1500;
const LOCATION_PARAMETERS = { account_id: ACCOUNT_ID_PROPERTY, location_id: LOCATION_ID_PROPERTY };
const OFFER_ARGUMENTS = ["offer_coupon_code", "offer_redeem_url", "offer_terms"];

function requireWebUrl(urlText, argumentName) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlText);
  } catch {
    rejectInput(`\`${argumentName}\` must be an http(s) URL`);
  }
  if (!["https:", "http:"].includes(parsedUrl.protocol)) rejectInput(`\`${argumentName}\` must be an http(s) URL`);
  return urlText;
}

function buildCallToAction(args) {
  if (args.call_to_action_type === undefined) {
    if (args.call_to_action_url !== undefined) rejectInput("`call_to_action_url` needs `call_to_action_type`");
    return undefined;
  }
  if (args.call_to_action_type === "CALL") {
    if (args.call_to_action_url !== undefined) rejectInput("A CALL button uses the location's phone: leave `call_to_action_url` unset");
    return { actionType: "CALL" };
  }
  if (args.call_to_action_url === undefined) rejectInput(`A ${args.call_to_action_type} button needs \`call_to_action_url\``);
  return { actionType: args.call_to_action_type, url: requireWebUrl(args.call_to_action_url, "call_to_action_url") };
}

function buildEvent(args) {
  const hasEventFields = [args.event_title, args.event_start, args.event_end].some((eventValue) => eventValue !== undefined);
  if (args.topic_type === "STANDARD") {
    if (hasEventFields) rejectInput("event_title, event_start and event_end are only for EVENT and OFFER posts");
    return undefined;
  }
  if (!args.event_title || !args.event_start || !args.event_end) rejectInput(`A ${args.topic_type} post needs event_title, event_start and event_end`);
  const start = parseDateWithOptionalTime(args.event_start, "event_start");
  const end = parseDateWithOptionalTime(args.event_end, "event_end");
  validateEventOrder(start, end);
  const schedule = { startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time };
  return { title: args.event_title, schedule };
}

// Both ends carry a time or neither does; a timed event must end after it starts, a date-only one not before.
function validateEventOrder(start, end) {
  if ((start.time === undefined) !== (end.time === undefined)) rejectInput("Give a time on both event_start and event_end, or on neither");
  const toSortKey = ({ date, time }) => [date.year, date.month, date.day, time?.hours ?? 0, time?.minutes ?? 0].map((part) => String(part).padStart(4, "0")).join("");
  const startKey = toSortKey(start);
  const endKey = toSortKey(end);
  const isTimed = start.time !== undefined;
  if (isTimed ? startKey >= endKey : startKey > endKey) rejectInput(`\`event_end\` must be after \`event_start\``);
}

function buildOffer(args) {
  const hasOfferFields = OFFER_ARGUMENTS.some((argumentName) => args[argumentName] !== undefined);
  if (args.topic_type !== "OFFER") {
    if (hasOfferFields) rejectInput(`${OFFER_ARGUMENTS.join(", ")} are only for OFFER posts`);
    return undefined;
  }
  if (!hasOfferFields) return undefined;
  const redeemOnlineUrl = args.offer_redeem_url === undefined ? undefined : requireWebUrl(args.offer_redeem_url, "offer_redeem_url");
  return { couponCode: args.offer_coupon_code, redeemOnlineUrl, termsConditions: args.offer_terms };
}

/**
 * Builds the LocalPost body for create_local_post.
 *
 * @param args - create_local_post arguments (object)
 * @returns LocalPost (object)
 * @throws PluginError kind `invalid_input` - When fields do not fit the topic type
 */
export function buildLocalPost(args) {
  if (args.topic_type === "STANDARD" && !args.summary) rejectInput("A STANDARD post needs `summary`");
  if (args.summary !== undefined && args.summary.length > MAX_SUMMARY_LENGTH) rejectInput(`\`summary\` must have at most ${MAX_SUMMARY_LENGTH} characters`);
  return {
    languageCode: args.language_code,
    summary: args.summary,
    topicType: args.topic_type,
    callToAction: buildCallToAction(args),
    event: buildEvent(args),
    offer: buildOffer(args),
    media: args.media_url === undefined ? undefined : [{ mediaFormat: args.media_format, sourceUrl: requireWebUrl(args.media_url, "media_url") }],
  };
}

export const localPostOperations = [
  {
    name: "list_local_posts",
    title: "List Google Business Profile posts",
    description: "List a location's posts (updates, events, offers), newest first.",
    parameters: { type: "object", properties: { ...LOCATION_PARAMETERS, ...paginationProperties(100, 20) }, required: ["account_id", "location_id"] },
    run: async ({ client, args, signal }) => {
      const postPage = await client.my_business_v4.request({ path: `${v4LocationPath(args)}/localPosts`, query: { pageSize: args.limit, pageToken: args.cursor }, signal });
      return { data: postPage?.localPosts ?? [], next_cursor: postPage?.nextPageToken || null };
    },
  },
  {
    name: "create_local_post",
    title: "Create Google Business Profile post",
    description:
      "Publish a post on a location's Business Profile: STANDARD (update), EVENT or OFFER, with an optional button and photo URL. Never retried after an unknown outcome: check list_local_posts first.",
    parameters: {
      type: "object",
      properties: {
        ...LOCATION_PARAMETERS,
        topic_type: { type: "string", enum: ["STANDARD", "EVENT", "OFFER"], default: "STANDARD" },
        summary: { type: "string", description: `Post text (max ${MAX_SUMMARY_LENGTH} characters); required for STANDARD` },
        language_code: { type: "string", description: "Language of the post, e.g. id or en" },
        call_to_action_type: { type: "string", enum: CALL_TO_ACTION_TYPES, description: "Button; CALL uses the location's phone" },
        call_to_action_url: { type: "string", description: "Button link (not for CALL)" },
        media_url: { type: "string", description: "Public http(s) URL of a photo (or video) Google fetches" },
        media_format: { type: "string", enum: ["PHOTO", "VIDEO"], default: "PHOTO" },
        event_title: { type: "string", description: "EVENT/OFFER: title" },
        event_start: { type: "string", description: "EVENT/OFFER: start, YYYY-MM-DD or YYYY-MM-DDTHH:MM (location's time)" },
        event_end: { type: "string", description: "EVENT/OFFER: end, YYYY-MM-DD or YYYY-MM-DDTHH:MM" },
        offer_coupon_code: { type: "string", description: "OFFER: coupon code" },
        offer_redeem_url: { type: "string", description: "OFFER: link to redeem online" },
        offer_terms: { type: "string", description: "OFFER: terms and conditions" },
      },
      required: ["account_id", "location_id"],
    },
    run: async ({ client, args, signal }) => {
      const localPost = buildLocalPost(args);
      const pendingCreate = client.my_business_v4.request({ method: "POST", path: `${v4LocationPath(args)}/localPosts`, json: localPost, signal });
      return { data: await withWriteOutcomeHint(pendingCreate, "call list_local_posts and look for the post before creating it again") };
    },
  },
  {
    name: "delete_local_post",
    title: "Delete Google Business Profile post",
    description: "Delete a post from a location's Business Profile.",
    parameters: {
      type: "object",
      properties: { ...LOCATION_PARAMETERS, local_post_id: { type: "string", description: "Post id: the last part of the post's name" } },
      required: ["account_id", "location_id", "local_post_id"],
    },
    run: async ({ client, args, signal }) => {
      const localPostId = normalizeResourceId(args.local_post_id, "localPosts", "local_post_id");
      const { alreadyAbsent } = await client.deleteResource("my_business_v4", { path: `${v4LocationPath(args)}/localPosts/${localPostId}`, signal });
      return { data: { deleted: true, ...(alreadyAbsent ? { already_absent: true } : {}), local_post_id: localPostId } };
    },
  },
];
