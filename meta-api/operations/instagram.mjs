/**
 * Instagram professional account operations (via Facebook Login / Page token):
 * account, media, publishing and comment moderation.
 */
import { paginationProperties, rejectInput, resolveId, toPage } from "../lib/client.mjs";
import { pollUntilDone, resolvePollInterval } from "../lib/shared/polling.mjs";

const IG_USER_ID_PROPERTY = { type: "string", description: "Instagram account id (default: META_IG_USER_ID)" };
const COMMENT_ID_PROPERTY = { type: "string", description: "Instagram comment id" };
const DEFAULT_ACCOUNT_FIELDS = "id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count,website";
const DEFAULT_MEDIA_FIELDS = "id,caption,media_type,media_product_type,media_url,permalink,timestamp,like_count,comments_count";
const DEFAULT_COMMENT_FIELDS = "id,text,timestamp,username,hidden,like_count,parent_id";
const CONTAINER_POLL_INTERVAL_MS = 5000;
const CONTAINER_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_CAROUSEL_ITEMS = 2;
const MAX_CAROUSEL_ITEMS = 10;

const igUserIdOf = (args, environment) => resolveId(args.ig_user_id, environment, "META_IG_USER_ID", "ig_user_id");

export const instagramOperations = [
  {
    name: "get_instagram_account",
    title: "Get Instagram account",
    description: "Read the Instagram professional account (username, followers, media count).",
    parameters: { type: "object", properties: { ig_user_id: IG_USER_ID_PROPERTY, fields: { type: "string", default: DEFAULT_ACCOUNT_FIELDS } } },
    run: async ({ client, args, environment, signal }) => ({
      data: await client.request({ path: `/${igUserIdOf(args, environment)}`, query: { fields: args.fields }, signal }),
    }),
  },
  {
    name: "list_instagram_media",
    title: "List Instagram media",
    description: "List the account's posts, reels and carousels, newest first.",
    parameters: {
      type: "object",
      properties: { ig_user_id: IG_USER_ID_PROPERTY, fields: { type: "string", default: DEFAULT_MEDIA_FIELDS }, ...paginationProperties() },
    },
    run: async ({ client, args, environment, signal }) =>
      toPage(
        await client.request({
          path: `/${igUserIdOf(args, environment)}/media`,
          query: { fields: args.fields, limit: args.limit, after: args.cursor },
          signal,
        }),
      ),
  },
  {
    name: "get_instagram_publishing_limit",
    title: "Get Instagram publishing limit",
    description: "Read how many posts the account published in the last 24 hours and its quota.",
    parameters: { type: "object", properties: { ig_user_id: IG_USER_ID_PROPERTY } },
    run: async ({ client, args, environment, signal }) => ({
      data: await client.request({
        path: `/${igUserIdOf(args, environment)}/content_publishing_limit`,
        query: { fields: "config,quota_usage" },
        signal,
      }),
    }),
  },
  {
    name: "publish_instagram_media",
    title: "Publish to Instagram",
    description:
      "Publish an image, reel (VIDEO is published as REELS), story or carousel from public media URLs. Waits for Instagram to process the media (up to 5 minutes).",
    parameters: {
      type: "object",
      properties: {
        ig_user_id: IG_USER_ID_PROPERTY,
        media_type: { type: "string", enum: ["IMAGE", "VIDEO", "REELS", "STORIES", "CAROUSEL"], default: "IMAGE" },
        image_url: { type: "string", description: "Public JPEG URL (IMAGE, STORIES)" },
        video_url: { type: "string", description: "Public video URL (VIDEO/REELS, STORIES)" },
        caption: { type: "string" },
        alt_text: { type: "string", description: "Alt text for images" },
        share_to_feed: { type: "boolean", description: "REELS: also show in the feed" },
        carousel_items: {
          type: "array",
          maxItems: MAX_CAROUSEL_ITEMS,
          items: { type: "object" },
          description: "CAROUSEL: 2-10 items, each {image_url} or {video_url}",
        },
      },
    },
    run: publishInstagramMedia,
  },
  {
    name: "list_instagram_comments",
    title: "List Instagram comments",
    description: "List comments on an Instagram media item.",
    parameters: {
      type: "object",
      properties: { media_id: { type: "string" }, fields: { type: "string", default: DEFAULT_COMMENT_FIELDS }, ...paginationProperties() },
      required: ["media_id"],
    },
    run: async ({ client, args, signal }) =>
      toPage(await client.request({ path: `/${args.media_id}/comments`, query: { fields: args.fields, limit: args.limit, after: args.cursor }, signal })),
  },
  {
    name: "list_instagram_comment_replies",
    title: "List Instagram comment replies",
    description: "List replies to an Instagram comment.",
    parameters: {
      type: "object",
      properties: { comment_id: COMMENT_ID_PROPERTY, fields: { type: "string", default: DEFAULT_COMMENT_FIELDS }, ...paginationProperties() },
      required: ["comment_id"],
    },
    run: async ({ client, args, signal }) =>
      toPage(await client.request({ path: `/${args.comment_id}/replies`, query: { fields: args.fields, limit: args.limit, after: args.cursor }, signal })),
  },
  {
    name: "reply_to_instagram_comment",
    title: "Reply to Instagram comment",
    description: "Reply to a comment on the account's Instagram media.",
    parameters: { type: "object", properties: { comment_id: COMMENT_ID_PROPERTY, message: { type: "string", minLength: 1 } }, required: ["comment_id", "message"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "POST", path: `/${args.comment_id}/replies`, form: { message: args.message }, signal }),
    }),
  },
  {
    name: "set_instagram_comment_hidden",
    title: "Hide/unhide Instagram comment",
    description: "Hide or unhide a comment on the account's Instagram media.",
    parameters: { type: "object", properties: { comment_id: COMMENT_ID_PROPERTY, hidden: { type: "boolean" } }, required: ["comment_id", "hidden"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "POST", path: `/${args.comment_id}`, form: { hide: args.hidden }, signal }),
    }),
  },
  {
    name: "delete_instagram_comment",
    title: "Delete Instagram comment",
    description: "Delete a comment on the account's Instagram media.",
    parameters: { type: "object", properties: { comment_id: COMMENT_ID_PROPERTY }, required: ["comment_id"] },
    run: async ({ client, args, signal }) => ({ data: await client.request({ method: "DELETE", path: `/${args.comment_id}`, signal }) }),
  },
];

async function publishInstagramMedia({ client, args, environment, signal }) {
  const igUserId = igUserIdOf(args, environment);
  const containerSettings = { client, igUserId, environment, signal };
  const containerForm = buildContainerForm(args);
  if (args.media_type === "CAROUSEL") {
    containerForm.children = (await createCarouselChildren(containerSettings, args.carousel_items)).join(",");
  }
  const containerId = await createReadyContainer(containerSettings, containerForm);
  const published = await client.request({ method: "POST", path: `/${igUserId}/media_publish`, form: { creation_id: containerId }, signal });
  return { data: { id: published.id, container_id: containerId } };
}

function buildContainerForm(args) {
  const commonFields = { caption: args.caption };
  switch (args.media_type) {
    case "IMAGE":
      if (!args.image_url) rejectInput("IMAGE needs `image_url`");
      return { ...commonFields, image_url: args.image_url, alt_text: args.alt_text };
    case "VIDEO":
    case "REELS":
      if (!args.video_url) rejectInput(`${args.media_type} needs \`video_url\``);
      return { ...commonFields, media_type: "REELS", video_url: args.video_url, share_to_feed: args.share_to_feed };
    case "STORIES":
      if (!args.image_url && !args.video_url) rejectInput("STORIES needs `image_url` or `video_url`");
      return { media_type: "STORIES", image_url: args.image_url, video_url: args.video_url };
    case "CAROUSEL":
      validateCarouselItems(args.carousel_items);
      return { ...commonFields, media_type: "CAROUSEL" };
    default:
      return rejectInput(`Unsupported media_type ${args.media_type}`);
  }
}

function validateCarouselItems(carouselItems) {
  if (!Array.isArray(carouselItems) || carouselItems.length < MIN_CAROUSEL_ITEMS) {
    rejectInput(`CAROUSEL needs ${MIN_CAROUSEL_ITEMS}-${MAX_CAROUSEL_ITEMS} \`carousel_items\``);
  }
  carouselItems.forEach((carouselItem, index) => {
    if (!carouselItem?.image_url && !carouselItem?.video_url) rejectInput(`carousel_items[${index}] needs \`image_url\` or \`video_url\``);
  });
}

async function createCarouselChildren(containerSettings, carouselItems) {
  const childIds = [];
  for (const carouselItem of carouselItems) {
    const childForm = carouselItem.video_url
      ? { is_carousel_item: true, media_type: "VIDEO", video_url: carouselItem.video_url }
      : { is_carousel_item: true, image_url: carouselItem.image_url, alt_text: carouselItem.alt_text };
    childIds.push(await createReadyContainer(containerSettings, childForm));
  }
  return childIds;
}

async function createReadyContainer({ client, igUserId, environment, signal }, containerForm) {
  const container = await client.request({ method: "POST", path: `/${igUserId}/media`, form: containerForm, signal });
  await pollUntilDone({
    readStatus: () => client.request({ path: `/${container.id}`, query: { fields: "status_code,status" }, signal }),
    isDone: (statusResult) => statusResult.status_code === "FINISHED",
    isFailed: (statusResult) =>
      ["ERROR", "EXPIRED"].includes(statusResult.status_code) ? `${statusResult.status_code}: ${statusResult.status ?? "no details"}` : false,
    intervalMs: resolvePollInterval(environment, CONTAINER_POLL_INTERVAL_MS),
    timeoutMs: CONTAINER_POLL_TIMEOUT_MS,
    signal,
  });
  return container.id;
}
