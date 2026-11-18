/**
 * LinkedIn profile, post and image operations (Posts API, Images API, OpenID userinfo).
 */
import { encodeRestliValue, paginationProperties, rejectInput, requireUrn, resolveActorUrn, toPage, toPagingQuery } from "../lib/client.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";

const POST_URN_PROPERTY = { type: "string", description: 'Post URN, e.g. "urn:li:share:123" or "urn:li:ugcPost:123"' };
const AUTHOR_PROPERTY = { type: "string", description: "urn:li:person:... or urn:li:organization:... (default: LINKEDIN_AUTHOR_URN)" };
const TEXT_PROPERTY = { type: "string", minLength: 1, description: "Post text" };
const LITTLE_TEXT_PROPERTY = {
  type: "boolean",
  default: false,
  description: "true sends `text` as raw LinkedIn Little Text Format (mentions, {hashtag|\\#|tag}); false escapes reserved characters",
};
// Characters LinkedIn's Little Text Format reserves; unescaped they truncate or garble the commentary.
const LITTLE_TEXT_RESERVED = /[\\|{}@[\]()<>#*_~]/g;
const DEFAULT_DISTRIBUTION = { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] };

/**
 * Escapes Little Text Format reserved characters unless the caller sends raw Little Text.
 *
 * @param text - Post text (string)
 * @param isLittleTextFormat - Send as-is when true (boolean)
 * @returns Commentary for the Posts API (string)
 */
export function toCommentary(text, isLittleTextFormat) {
  return isLittleTextFormat ? text : text.replace(LITTLE_TEXT_RESERVED, (character) => `\\${character}`);
}

function buildPostContent(args) {
  const hasArticleFields = Boolean(args.article_title || args.article_description || args.article_thumbnail_urn);
  if (hasArticleFields && !args.article_url) rejectInput("Article fields need `article_url`");
  if (args.image_urn && args.article_url) rejectInput("Pass either `image_urn` or `article_url`, not both");
  if (args.image_urn) {
    if (!args.image_urn.startsWith("urn:li:image:")) rejectInput('`image_urn` must look like "urn:li:image:..." (from upload_image)');
    return { media: { id: args.image_urn, altText: args.image_alt_text } };
  }
  if (!args.article_url) return undefined;
  if (!args.article_url.startsWith("https://")) rejectInput("`article_url` must be an https URL");
  return {
    article: { source: args.article_url, title: args.article_title, description: args.article_description, thumbnail: args.article_thumbnail_urn },
  };
}

function buildPostBody(args, environment) {
  return {
    author: resolveActorUrn(args.author, environment, "author"),
    commentary: toCommentary(args.text, args.little_text_format),
    visibility: args.visibility,
    distribution: DEFAULT_DISTRIBUTION,
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: args.disable_reshare,
    content: buildPostContent(args),
  };
}

async function createPost({ client, args, environment, signal }) {
  const postBody = buildPostBody(args, environment);
  const { headers } = await client.requestWithHeaders({ method: "POST", path: "/posts", json: postBody, signal });
  const postUrn = headers.get("x-restli-id");
  if (!postUrn) throw new PluginError("LinkedIn accepted the post but returned no x-restli-id", { kind: "api_error" });
  return { data: { id: postUrn, url: `https://www.linkedin.com/feed/update/${postUrn}/` } };
}

async function uploadImage({ client, args, environment, signal }) {
  const ownerUrn = resolveActorUrn(args.owner_urn, environment, "owner_urn");
  const { imageBytes } = await client.downloadImage(args.image_url, signal);
  const initializeResponse = await client.request({
    method: "POST",
    path: "/images",
    query: { action: "initializeUpload" },
    json: { initializeUploadRequest: { owner: ownerUrn } },
    signal,
  });
  const { uploadUrl, image: imageUrn, uploadUrlExpiresAt } = initializeResponse?.value ?? {};
  if (!uploadUrl || !imageUrn) throw new PluginError("initializeUpload returned no uploadUrl/image", { kind: "api_error" });
  await client.uploadImageBytes(uploadUrl, imageBytes, signal);
  return { data: { image_urn: imageUrn, owner: ownerUrn, upload_url_expires_at: uploadUrlExpiresAt ?? null } };
}

const postPath = (args) => `/posts/${encodeRestliValue(requireUrn(args.post_urn, "post_urn"))}`;

export const postOperations = [
  {
    name: "get_userinfo",
    title: "Get LinkedIn member",
    description: "Read the signed-in member (OpenID userinfo: sub, name, email, picture) and their person_urn.",
    parameters: { type: "object", properties: {} },
    run: async ({ client, signal }) => {
      const userinfo = await client.requestUserinfo(signal);
      return { data: { ...userinfo, person_urn: userinfo?.sub ? `urn:li:person:${userinfo.sub}` : null } };
    },
  },
  {
    name: "create_post",
    title: "Create LinkedIn post",
    description: "Publish a text post as a member or organization, optionally with an uploaded image or an article link. Returns the post URN.",
    parameters: {
      type: "object",
      properties: {
        author: AUTHOR_PROPERTY,
        text: TEXT_PROPERTY,
        little_text_format: LITTLE_TEXT_PROPERTY,
        visibility: { type: "string", enum: ["PUBLIC", "CONNECTIONS", "LOGGED_IN"], default: "PUBLIC" },
        image_urn: { type: "string", description: "urn:li:image:... from upload_image" },
        image_alt_text: { type: "string", description: "Alt text for the image" },
        article_url: { type: "string", description: "https link to share as an article" },
        article_title: { type: "string" },
        article_description: { type: "string" },
        article_thumbnail_urn: { type: "string", description: "urn:li:image:... thumbnail for the article" },
        disable_reshare: { type: "boolean", default: false, description: "Stop others from resharing" },
      },
      required: ["text"],
    },
    run: createPost,
  },
  {
    name: "get_post",
    title: "Get LinkedIn post",
    description: "Read one post by URN (as its author).",
    parameters: { type: "object", properties: { post_urn: POST_URN_PROPERTY }, required: ["post_urn"] },
    run: async ({ client, args, signal }) => ({ data: await client.request({ path: postPath(args), query: { viewContext: "AUTHOR" }, signal }) }),
  },
  {
    name: "list_organization_posts",
    title: "List organization posts",
    description: "List posts by an organization (needs r_organization_social, Community Management API).",
    parameters: {
      type: "object",
      properties: {
        author_urn: { type: "string", description: "urn:li:organization:... (default: LINKEDIN_AUTHOR_URN)" },
        sort_by: { type: "string", enum: ["LAST_MODIFIED", "CREATED"], default: "LAST_MODIFIED" },
        ...paginationProperties(),
      },
    },
    run: async ({ client, args, environment, signal }) => {
      const pagingQuery = toPagingQuery(args);
      const authorUrn = resolveActorUrn(args.author_urn, environment, "author_urn");
      const responseBody = await client.request({
        path: "/posts",
        query: { q: "author", author: authorUrn, sortBy: args.sort_by, ...pagingQuery },
        headers: { "x-restli-method": "FINDER" },
        signal,
      });
      return toPage(responseBody, pagingQuery);
    },
  },
  {
    name: "update_post",
    title: "Update LinkedIn post",
    description: "Edit the text of a post.",
    parameters: {
      type: "object",
      properties: { post_urn: POST_URN_PROPERTY, text: TEXT_PROPERTY, little_text_format: LITTLE_TEXT_PROPERTY },
      required: ["post_urn", "text"],
    },
    run: async ({ client, args, signal }) => {
      const patch = { $set: { commentary: toCommentary(args.text, args.little_text_format) } };
      await client.request({ method: "POST", path: postPath(args), json: { patch }, headers: { "x-restli-method": "PARTIAL_UPDATE" }, signal });
      return { data: { id: args.post_urn, updated: true } };
    },
  },
  {
    name: "delete_post",
    title: "Delete LinkedIn post",
    description: "Delete a post.",
    parameters: { type: "object", properties: { post_urn: POST_URN_PROPERTY }, required: ["post_urn"] },
    run: async ({ client, args, signal }) => {
      await client.request({ method: "DELETE", path: postPath(args), headers: { "x-restli-method": "DELETE" }, signal });
      return { data: { id: args.post_urn, deleted: true } };
    },
  },
  {
    name: "upload_image",
    title: "Upload LinkedIn image",
    description: "Upload an image from a public https URL (image/*, max 10 MB). Returns image_urn for create_post.",
    parameters: {
      type: "object",
      properties: {
        image_url: { type: "string", description: "Public https image URL" },
        owner_urn: { type: "string", description: "Owner of the image, the future post author (default: LINKEDIN_AUTHOR_URN)" },
      },
      required: ["image_url"],
    },
    run: uploadImage,
  },
];
