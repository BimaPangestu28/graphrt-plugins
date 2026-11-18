/**
 * Channel and video operations: the authenticated channel, its uploads, video
 * details, metadata edits and deletion.
 */
import { paginationProperties, rejectInput, rejectNotFound, requireFirstItem, toPage } from "../lib/client.mjs";

const VIDEO_ID_PROPERTY = { type: "string", description: "Video id, e.g. dQw4w9WgXcQ" };
const DEFAULT_CHANNEL_PARTS = "snippet,contentDetails,statistics";
const DEFAULT_VIDEO_PARTS = "snippet,status,statistics,contentDetails";
const DEFAULT_PLAYLIST_ITEM_PARTS = "snippet,contentDetails";
// `localized` is a read-only translation of title/description; sending the old copy back is pointless.
const READ_ONLY_SNIPPET_FIELDS = ["localized"];

async function readUploadsPlaylistId(client, signal) {
  const channelResponse = await client.request({ path: "/channels", query: { part: "contentDetails", mine: true }, signal });
  const uploadsPlaylistId = channelResponse?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) rejectNotFound("The authenticated account has no YouTube channel with an uploads playlist");
  return uploadsPlaylistId;
}

function mergeSnippet(existingSnippet, args) {
  const mergedSnippet = { ...existingSnippet };
  for (const fieldName of READ_ONLY_SNIPPET_FIELDS) delete mergedSnippet[fieldName];
  if (args.title !== undefined) mergedSnippet.title = args.title;
  if (args.description !== undefined) mergedSnippet.description = args.description;
  if (args.tags !== undefined) mergedSnippet.tags = args.tags;
  if (args.category_id !== undefined) mergedSnippet.categoryId = args.category_id;
  if (!mergedSnippet.categoryId) rejectInput("The video has no categoryId; pass `category_id` (YouTube requires it on update)");
  return mergedSnippet;
}

async function updateVideoMetadata({ client, args, signal }) {
  const hasChange = ["title", "description", "tags", "category_id"].some((fieldName) => args[fieldName] !== undefined);
  if (!hasChange) rejectInput("Pass at least one of `title`, `description`, `tags` or `category_id`");
  const currentResponse = await client.request({ path: "/videos", query: { part: "snippet", id: args.video_id }, signal });
  const currentVideo = requireFirstItem(currentResponse, `Video ${args.video_id} was not found or is not visible to this account`);
  const snippet = mergeSnippet(currentVideo.snippet ?? {}, args);
  const updatedVideo = await client.request({ method: "PUT", path: "/videos", query: { part: "snippet" }, json: { id: args.video_id, snippet }, signal });
  return { data: updatedVideo };
}

export const videoOperations = [
  {
    name: "get_my_channel",
    title: "Get my YouTube channel",
    description: "Read the authenticated user's channel (title, statistics, uploads playlist id).",
    parameters: { type: "object", properties: { part: { type: "string", default: DEFAULT_CHANNEL_PARTS, description: "Comma-separated resource parts" } } },
    run: async ({ client, args, signal }) => {
      const channelResponse = await client.request({ path: "/channels", query: { part: args.part, mine: true }, signal });
      return { data: requireFirstItem(channelResponse, "The authenticated account has no YouTube channel") };
    },
  },
  {
    name: "list_my_videos",
    title: "List my YouTube videos",
    description: "List the authenticated channel's uploads, newest first. Pass `uploads_playlist_id` (returned in data) to skip the channel lookup.",
    parameters: {
      type: "object",
      properties: {
        uploads_playlist_id: { type: "string", description: "Uploads playlist id (UU...); looked up from the channel when empty" },
        part: { type: "string", default: DEFAULT_PLAYLIST_ITEM_PARTS },
        ...paginationProperties(50),
      },
    },
    run: async ({ client, args, signal }) => {
      const uploadsPlaylistId = args.uploads_playlist_id ?? (await readUploadsPlaylistId(client, signal));
      const query = { part: args.part, playlistId: uploadsPlaylistId, maxResults: args.limit, pageToken: args.cursor };
      const videoPage = toPage(await client.request({ path: "/playlistItems", query, signal }));
      return { data: { uploads_playlist_id: uploadsPlaylistId, videos: videoPage.data }, next_cursor: videoPage.next_cursor };
    },
  },
  {
    name: "get_videos",
    title: "Get YouTube videos",
    description: "Read details of up to 50 videos by id (snippet, status, statistics, duration).",
    parameters: {
      type: "object",
      properties: {
        video_ids: { type: "array", items: { type: "string" }, maxItems: 50, description: "Video ids" },
        part: { type: "string", default: DEFAULT_VIDEO_PARTS },
      },
      required: ["video_ids"],
    },
    run: async ({ client, args, signal }) => {
      if (args.video_ids.length === 0) rejectInput("`video_ids` must contain at least one id");
      return { data: (await client.request({ path: "/videos", query: { part: args.part, id: args.video_ids }, signal }))?.items ?? [] };
    },
  },
  {
    name: "update_video_metadata",
    title: "Update YouTube video metadata",
    description: "Change a video's title, description, tags or category. Reads the current snippet first, so fields you omit keep their values.",
    parameters: {
      type: "object",
      properties: {
        video_id: VIDEO_ID_PROPERTY,
        title: { type: "string", minLength: 1, description: "New title (max 100 characters)" },
        description: { type: "string", description: "New description" },
        tags: { type: "array", items: { type: "string" }, description: "Replaces the tag list" },
        category_id: { type: "string", description: "Video category id, e.g. 22 (People & Blogs)" },
      },
      required: ["video_id"],
    },
    run: updateVideoMetadata,
  },
  {
    name: "delete_video",
    title: "Delete YouTube video",
    description: "Permanently delete one of the authenticated channel's videos.",
    parameters: { type: "object", properties: { video_id: VIDEO_ID_PROPERTY }, required: ["video_id"] },
    run: async ({ client, args, signal }) => {
      await client.request({ method: "DELETE", path: "/videos", query: { id: args.video_id }, signal });
      return { data: { deleted: true, video_id: args.video_id } };
    },
  },
];
