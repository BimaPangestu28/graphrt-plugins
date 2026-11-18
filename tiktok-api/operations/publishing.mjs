/**
 * Open API Content Posting operations: publish a video or a photo post from
 * public URLs (PULL_FROM_URL) and read the publish status.
 *
 * Direct posts first read creator_info (TikTok requires the privacy level to
 * be one the creator can use), then init the post, then poll the status.
 */
import { rejectInput } from "../lib/client.mjs";
import { pollUntilDone, resolvePollInterval } from "../lib/shared/polling.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { queryCreatorInfo } from "./account.mjs";

const PRIVACY_LEVELS = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];
const MAX_PHOTOS = 35;
const STATUS_POLL_INTERVAL_MS = 5000;
const STATUS_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const FINISHED_STATUSES = new Set(["PUBLISH_COMPLETE", "SEND_TO_USER_INBOX"]);

const PRIVACY_LEVEL_PROPERTY = {
  type: "string",
  enum: PRIVACY_LEVELS,
  description: "Required for direct posts; must be one of creator_info.privacy_level_options. Unaudited apps can only use SELF_ONLY.",
};
const WAIT_PROPERTY = { type: "boolean", default: true, description: "Poll the status every 5 s (up to 5 min) until TikTok finishes" };

export const publishingOperations = [
  {
    name: "publish_video",
    title: "Publish TikTok video",
    description:
      "Post a video from a public URL on a verified domain. mode=direct posts it (needs privacy_level); mode=inbox sends it to the creator's TikTok inbox as a draft to finish in the app.",
    parameters: {
      type: "object",
      properties: {
        video_url: { type: "string", minLength: 1, description: "Public video URL on a domain verified for the app" },
        mode: { type: "string", enum: ["direct", "inbox"], default: "direct" },
        title: { type: "string", description: "Caption with #hashtags and @mentions (direct only)" },
        privacy_level: PRIVACY_LEVEL_PROPERTY,
        disable_comment: { type: "boolean" },
        disable_duet: { type: "boolean" },
        disable_stitch: { type: "boolean" },
        video_cover_timestamp_ms: { type: "integer", minimum: 0, description: "Frame used as the cover" },
        brand_content_toggle: { type: "boolean", description: "Paid partnership promoting a third party" },
        brand_organic_toggle: { type: "boolean", description: "Promotes the creator's own business" },
        is_aigc: { type: "boolean", description: "Label the video as AI-generated" },
        wait: WAIT_PROPERTY,
      },
      required: ["video_url"],
    },
    run: publishVideo,
  },
  {
    name: "publish_photos",
    title: "Publish TikTok photos",
    description:
      "Post 1-35 photos from public URLs on a verified domain. mode=direct posts them (needs privacy_level); mode=upload sends them to the creator's inbox to finish in the app.",
    parameters: {
      type: "object",
      properties: {
        photo_urls: { type: "array", items: { type: "string" }, maxItems: MAX_PHOTOS, description: "1-35 public image URLs" },
        mode: { type: "string", enum: ["direct", "upload"], default: "direct" },
        title: { type: "string" },
        description: { type: "string", description: "Post text with #hashtags and @mentions" },
        privacy_level: PRIVACY_LEVEL_PROPERTY,
        photo_cover_index: { type: "integer", minimum: 0, default: 0, description: "Index of the cover photo in photo_urls" },
        disable_comment: { type: "boolean" },
        auto_add_music: { type: "boolean" },
        wait: WAIT_PROPERTY,
      },
      required: ["photo_urls"],
    },
    run: publishPhotos,
  },
  {
    name: "get_publish_status",
    title: "Get TikTok publish status",
    description: "Read the status of a publish_id (PROCESSING_UPLOAD, PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX, PUBLISH_COMPLETE or FAILED).",
    parameters: { type: "object", properties: { publish_id: { type: "string", minLength: 1 } }, required: ["publish_id"] },
    run: async ({ client, args, signal }) => ({ data: await fetchPublishStatus(client, args.publish_id, signal) }),
  },
];

async function publishVideo({ client, args, environment, signal }) {
  const sourceInfo = { source: "PULL_FROM_URL", video_url: args.video_url };
  if (args.mode === "inbox") {
    const initResult = await initPublish(client, "/v2/post/publish/inbox/video/init/", { source_info: sourceInfo }, signal);
    return finishPublish({ client, environment, signal, wait: args.wait }, initResult.publish_id);
  }
  await assertPrivacyLevelAllowed(client, args.privacy_level, signal);
  const postInfo = pickDefined(args, [
    "title",
    "privacy_level",
    "disable_comment",
    "disable_duet",
    "disable_stitch",
    "video_cover_timestamp_ms",
    "brand_content_toggle",
    "brand_organic_toggle",
    "is_aigc",
  ]);
  const initResult = await initPublish(client, "/v2/post/publish/video/init/", { post_info: postInfo, source_info: sourceInfo }, signal);
  return finishPublish({ client, environment, signal, wait: args.wait }, initResult.publish_id);
}

async function publishPhotos({ client, args, environment, signal }) {
  validatePhotoArguments(args);
  const isDirect = args.mode === "direct";
  if (isDirect) await assertPrivacyLevelAllowed(client, args.privacy_level, signal);
  const postInfoFields = ["title", "description", ...(isDirect ? ["privacy_level"] : []), "disable_comment", "auto_add_music"];
  const requestBody = {
    media_type: "PHOTO",
    post_mode: isDirect ? "DIRECT_POST" : "MEDIA_UPLOAD",
    post_info: pickDefined(args, postInfoFields),
    source_info: { source: "PULL_FROM_URL", photo_images: args.photo_urls, photo_cover_index: args.photo_cover_index },
  };
  const initResult = await initPublish(client, "/v2/post/publish/content/init/", requestBody, signal);
  return finishPublish({ client, environment, signal, wait: args.wait }, initResult.publish_id);
}

function validatePhotoArguments(args) {
  if (args.photo_urls.length === 0) rejectInput(`\`photo_urls\` needs 1-${MAX_PHOTOS} image URLs`);
  if (args.photo_cover_index >= args.photo_urls.length) {
    rejectInput(`\`photo_cover_index\` ${args.photo_cover_index} is out of range for ${args.photo_urls.length} photo(s)`);
  }
}

async function assertPrivacyLevelAllowed(client, privacyLevel, signal) {
  if (!privacyLevel) rejectInput(`Direct posts need \`privacy_level\` (one of ${PRIVACY_LEVELS.join(", ")}); call get_creator_info to see which are allowed`);
  const creatorInfo = await queryCreatorInfo(client, signal);
  const allowedLevels = creatorInfo.privacy_level_options;
  if (Array.isArray(allowedLevels) && !allowedLevels.includes(privacyLevel)) {
    rejectInput(`privacy_level ${privacyLevel} is not allowed for this creator; allowed: ${allowedLevels.join(", ")}`);
  }
}

async function initPublish(client, path, requestBody, signal) {
  const responseBody = await client.open.request({ method: "POST", path, json: requestBody, signal });
  const publishId = responseBody?.data?.publish_id;
  if (!publishId) throw new PluginError(`TikTok returned no publish_id from ${path}`, { kind: "api_error" });
  return { publish_id: publishId };
}

async function finishPublish({ client, environment, signal, wait }, publishId) {
  if (!wait) return { data: describePublish(publishId, {}) };
  try {
    const finalStatus = await pollUntilDone({
      readStatus: () => fetchPublishStatus(client, publishId, signal),
      isDone: (statusResult) => FINISHED_STATUSES.has(statusResult.status),
      isFailed: (statusResult) => (statusResult.status === "FAILED" ? statusResult.fail_reason || "no fail_reason given" : false),
      intervalMs: resolvePollInterval(environment, STATUS_POLL_INTERVAL_MS),
      timeoutMs: STATUS_POLL_TIMEOUT_MS,
      signal,
    });
    return { data: describePublish(publishId, finalStatus) };
  } catch (error) {
    throw withPublishId(error, publishId);
  }
}

// Keep the publish_id in failures so a workflow can check get_publish_status later.
function withPublishId(error, publishId) {
  if (!(error instanceof PluginError)) return error;
  return new PluginError(`${error.message} (publish_id ${publishId})`, { kind: error.kind, retryable: error.retryable, retryAfterMs: error.retryAfterMs });
}

async function fetchPublishStatus(client, publishId, signal) {
  const responseBody = await client.open.request({ method: "POST", path: "/v2/post/publish/status/fetch/", json: { publish_id: publishId }, signal });
  return responseBody?.data ?? {};
}

function describePublish(publishId, statusResult) {
  return {
    publish_id: publishId,
    status: statusResult.status ?? null,
    fail_reason: statusResult.fail_reason || null,
    // TikTok's field name is misspelled ("publicaly") in the API.
    post_ids: statusResult.publicaly_available_post_id ?? [],
  };
}

function pickDefined(source, fieldNames) {
  return Object.fromEntries(fieldNames.filter((fieldName) => source[fieldName] !== undefined).map((fieldName) => [fieldName, source[fieldName]]));
}
