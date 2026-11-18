/**
 * Facebook Page operations: page info and posts.
 */
import { paginationProperties, rejectInput, resolveId, toPage } from "../lib/client.mjs";

const PAGE_ID_PROPERTY = { type: "string", description: "Page id (default: META_PAGE_ID)" };
const POST_ID_PROPERTY = { type: "string", description: "Post id, e.g. 1234_5678" };
const DEFAULT_PAGE_FIELDS = "id,name,about,category,followers_count,link,picture,instagram_business_account";
const DEFAULT_POST_FIELDS = "id,message,created_time,permalink_url,status_type,full_picture";

const pageIdOf = (args, environment) => resolveId(args.page_id, environment, "META_PAGE_ID", "page_id");

export const pageOperations = [
  {
    name: "get_page",
    title: "Get Facebook Page",
    description: "Read Facebook Page details (name, category, followers, linked Instagram account).",
    parameters: { type: "object", properties: { page_id: PAGE_ID_PROPERTY, fields: { type: "string", default: DEFAULT_PAGE_FIELDS } } },
    run: async ({ client, args, environment, signal }) => ({
      data: await client.request({ path: `/${pageIdOf(args, environment)}`, query: { fields: args.fields }, signal }),
    }),
  },
  {
    name: "list_page_posts",
    title: "List Page posts",
    description: "List posts on the Facebook Page feed, newest first.",
    parameters: {
      type: "object",
      properties: { page_id: PAGE_ID_PROPERTY, fields: { type: "string", default: DEFAULT_POST_FIELDS }, ...paginationProperties() },
    },
    run: async ({ client, args, environment, signal }) =>
      toPage(
        await client.request({
          path: `/${pageIdOf(args, environment)}/feed`,
          query: { fields: args.fields, limit: args.limit, after: args.cursor },
          signal,
        }),
      ),
  },
  {
    name: "create_page_post",
    title: "Create Page post",
    description: "Publish (or schedule) a text and/or link post on the Facebook Page.",
    parameters: {
      type: "object",
      properties: {
        page_id: PAGE_ID_PROPERTY,
        message: { type: "string", description: "Post text" },
        link: { type: "string", description: "URL to attach" },
        published: { type: "boolean", default: true, description: "false creates an unpublished post" },
        scheduled_publish_time: { type: "integer", description: "Unix time 10 minutes to 30 days ahead; implies published=false" },
      },
    },
    run: async ({ client, args, environment, signal }) => {
      if (!args.message && !args.link) rejectInput("Pass `message`, `link` or both");
      const isScheduled = args.scheduled_publish_time !== undefined;
      const form = {
        message: args.message,
        link: args.link,
        published: isScheduled ? false : args.published,
        scheduled_publish_time: args.scheduled_publish_time,
      };
      return { data: await client.request({ method: "POST", path: `/${pageIdOf(args, environment)}/feed`, form, signal }) };
    },
  },
  {
    name: "create_page_photo_post",
    title: "Create Page photo post",
    description: "Publish a photo post on the Facebook Page from a public image URL.",
    parameters: {
      type: "object",
      properties: {
        page_id: PAGE_ID_PROPERTY,
        image_url: { type: "string", description: "Public image URL" },
        message: { type: "string", description: "Caption" },
        published: { type: "boolean", default: true },
      },
      required: ["image_url"],
    },
    run: async ({ client, args, environment, signal }) => ({
      data: await client.request({
        method: "POST",
        path: `/${pageIdOf(args, environment)}/photos`,
        form: { url: args.image_url, message: args.message, published: args.published },
        signal,
      }),
    }),
  },
  {
    name: "update_page_post",
    title: "Update Page post",
    description: "Edit the text of a Page post this app created.",
    parameters: { type: "object", properties: { post_id: POST_ID_PROPERTY, message: { type: "string" } }, required: ["post_id", "message"] },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ method: "POST", path: `/${args.post_id}`, form: { message: args.message }, signal }),
    }),
  },
  {
    name: "delete_page_post",
    title: "Delete Page post",
    description: "Delete a Page post.",
    parameters: { type: "object", properties: { post_id: POST_ID_PROPERTY }, required: ["post_id"] },
    run: async ({ client, args, signal }) => ({ data: await client.request({ method: "DELETE", path: `/${args.post_id}`, signal }) }),
  },
];
