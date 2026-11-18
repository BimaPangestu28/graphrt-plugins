/**
 * Page operations: search, read, create, update properties, move to and out of the trash.
 *
 * `create_page` is a POST and is never retried after an unknown outcome. Property updates and trash/restore
 * set absolute values, so they are marked idempotent and may be retried.
 */
import { assertPeopleWritesAllowed } from "../lib/people-guard.mjs";
import { buildPropertyValues, readPropertyTypes } from "../lib/property-values.mjs";
import { buildParagraphBlocks } from "../lib/rich-text.mjs";
import { extractNotionId, notionIdSegment, rejectInput, toCursorResult, withWriteOutcomeHint } from "../lib/client.mjs";
import {
  buildPagination,
  CURSOR_PROPERTY,
  DATA_SOURCE_ID_PROPERTY,
  DATABASE_ID_PROPERTY,
  LIMIT_PROPERTY,
  PAGE_ID_PROPERTY,
  RAW_PROPERTIES_PROPERTY,
  VALUES_PROPERTY,
} from "./common.mjs";
import { fetchDataSource, resolveDataSourceId } from "./databases.mjs";

const MAX_CHILD_BLOCKS = 100;
const PAGE_PARENT_PROPERTY_TYPES = { title: "title" };
const PARAGRAPHS_PROPERTY = { type: "array", items: { type: "string" }, maxItems: MAX_CHILD_BLOCKS, description: "Plain-text paragraphs for the page body (at most 100)" };

function fetchPage({ client, signal }, pageId) {
  return client.request({ path: `/pages/${notionIdSegment(pageId)}`, signal });
}

function hasEntries(objectValue) {
  return Boolean(objectValue) && Object.keys(objectValue).length > 0;
}

/**
 * Builds the `parent` of a new page and the property types its `values` are mapped with.
 *
 * @param context - `{client, args, signal}` (object)
 * @returns `{parent, loadPropertyTypes}`; loadPropertyTypes fetches the schema only when needed (Promise<object>)
 * @throws PluginError kind `invalid_input` - Not exactly one parent given
 */
async function resolveNewPageParent(context) {
  const { args } = context;
  const parentCount = [args.parent_page_id, args.data_source_id, args.database_id].filter(Boolean).length;
  if (parentCount !== 1) rejectInput("Pass exactly one of `parent_page_id`, `data_source_id` or `database_id`");
  if (args.parent_page_id) {
    return { parent: { type: "page_id", page_id: extractNotionId(args.parent_page_id) }, loadPropertyTypes: async () => PAGE_PARENT_PROPERTY_TYPES };
  }
  const dataSourceId = await resolveDataSourceId(context);
  const loadPropertyTypes = async () => readPropertyTypes(await fetchDataSource(context, dataSourceId));
  return { parent: { type: "data_source_id", data_source_id: dataSourceId }, loadPropertyTypes };
}

async function mergeProperties(context, loadPropertyTypes) {
  const { args } = context;
  assertPeopleWritesAllowed(context, args.properties);
  if (!hasEntries(args.values)) return { ...args.properties };
  const propertyTypes = await loadPropertyTypes();
  assertPeopleWritesAllowed(context, args.values, propertyTypes);
  return { ...buildPropertyValues(args.values, propertyTypes), ...args.properties };
}

async function createPage(context) {
  const { client, args, signal } = context;
  const { parent, loadPropertyTypes } = await resolveNewPageParent(context);
  const json = {
    parent,
    properties: await mergeProperties(context, loadPropertyTypes),
    children: args.paragraphs ? buildParagraphBlocks(args.paragraphs) : undefined,
    icon: args.icon_emoji ? { type: "emoji", emoji: args.icon_emoji } : undefined,
  };
  const checkHint = "search for the page (search or query_database) before creating it again";
  return { data: await withWriteOutcomeHint(client.request({ method: "POST", path: "/pages", json, signal }), checkHint) };
}

async function updatePageProperties(context) {
  const { client, args, signal } = context;
  if (!hasEntries(args.values) && !hasEntries(args.properties)) rejectInput("Pass `values` and/or `properties` to update");
  const properties = await mergeProperties(context, async () => readPropertyTypes(await fetchPage(context, args.page_id)));
  const path = `/pages/${notionIdSegment(args.page_id)}`;
  return { data: await client.request({ method: "PATCH", path, json: { properties }, signal, idempotent: true }) };
}

function setPageTrashed({ client, args, signal }, inTrash) {
  const path = `/pages/${notionIdSegment(args.page_id)}`;
  return client.request({ method: "PATCH", path, json: { in_trash: inTrash }, signal, idempotent: true });
}

async function resolvePropertyId(context) {
  const { args } = context;
  if (Boolean(args.property_id) === Boolean(args.property_name)) rejectInput("Pass exactly one of `property_id` or `property_name`");
  if (args.property_id) return decodePropertyId(args.property_id);
  const page = await fetchPage(context, args.page_id);
  const property = page?.properties?.[args.property_name];
  if (!property) rejectInput(`Unknown property ${JSON.stringify(args.property_name)}; properties are: ${Object.keys(page?.properties ?? {}).join(", ")}`);
  return decodePropertyId(property.id);
}

// Notion returns property ids already URL-encoded (e.g. "a%3Db"); decode so pathSegment encodes them once.
function decodePropertyId(propertyId) {
  try {
    return decodeURIComponent(propertyId);
  } catch {
    return propertyId;
  }
}

export const pageOperations = [
  {
    name: "search",
    title: "Search",
    description: "Search the pages and data sources shared with the integration by title, newest edits first by default.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to find in titles; omit to list everything shared with the integration" },
        object_type: { type: "string", enum: ["page", "data_source"], description: "Only pages or only data sources (database tables)" },
        sort_direction: { type: "string", enum: ["descending", "ascending"], default: "descending", description: "Order by last edited time" },
        limit: LIMIT_PROPERTY,
        cursor: CURSOR_PROPERTY,
      },
    },
    run: async ({ client, args, signal }) => {
      const json = {
        query: args.query,
        filter: args.object_type ? { property: "object", value: args.object_type } : undefined,
        sort: { timestamp: "last_edited_time", direction: args.sort_direction },
        ...buildPagination(args),
      };
      return toCursorResult(await client.request({ method: "POST", path: "/search", json, signal, idempotent: true }));
    },
  },
  {
    name: "get_page",
    title: "Get page",
    description: "Get a Notion page's properties, parent, URL and trash status (not its content; use get_block_children for that).",
    parameters: { type: "object", properties: { page_id: PAGE_ID_PROPERTY }, required: ["page_id"] },
    run: async (context) => ({ data: await fetchPage(context, context.args.page_id) }),
  },
  {
    name: "get_page_property",
    title: "Get page property",
    description: "Get one property of a page in full, paginated for long titles/rich text, relations and people (get_page truncates them at 25 items).",
    parameters: {
      type: "object",
      properties: {
        page_id: PAGE_ID_PROPERTY,
        property_id: { type: "string", description: "Property id from get_page (`properties.<name>.id`)" },
        property_name: { type: "string", description: "Property name, instead of property_id (costs one extra request)" },
        limit: LIMIT_PROPERTY,
        cursor: CURSOR_PROPERTY,
      },
      required: ["page_id"],
    },
    run: async (context) => {
      const { client, args, signal } = context;
      const propertyId = await resolvePropertyId(context);
      const path = `/pages/${notionIdSegment(args.page_id)}/properties/${notionIdSegment(propertyId)}`;
      return toCursorResult(await client.request({ path, query: buildPagination(args), signal }));
    },
  },
  {
    name: "create_page",
    title: "Create page",
    description:
      "Create a page in a database (data source) or under a page, with properties as a simple {name: value} map and/or Notion JSON, and optional plain-text paragraphs. Never retried after an unknown outcome.",
    parameters: {
      type: "object",
      properties: {
        data_source_id: DATA_SOURCE_ID_PROPERTY,
        database_id: DATABASE_ID_PROPERTY,
        parent_page_id: { type: "string", description: 'Parent page id or URL; such a page only has a title: values {"title": "..."}' },
        values: VALUES_PROPERTY,
        properties: RAW_PROPERTIES_PROPERTY,
        paragraphs: PARAGRAPHS_PROPERTY,
        icon_emoji: { type: "string", description: "Emoji icon, e.g. 📞" },
      },
    },
    run: createPage,
  },
  {
    name: "update_page_properties",
    title: "Update page properties",
    description: "Update some properties of a page; others are left unchanged. Takes a simple {name: value} map and/or Notion JSON.",
    parameters: {
      type: "object",
      properties: { page_id: PAGE_ID_PROPERTY, values: VALUES_PROPERTY, properties: RAW_PROPERTIES_PROPERTY },
      required: ["page_id"],
    },
    run: updatePageProperties,
  },
  {
    name: "archive_page",
    title: "Archive page",
    description: "Move a page to the Notion trash (in_trash). Reversible with restore_page.",
    parameters: { type: "object", properties: { page_id: PAGE_ID_PROPERTY }, required: ["page_id"] },
    run: async (context) => ({ data: await setPageTrashed(context, true) }),
  },
  {
    name: "restore_page",
    title: "Restore page",
    description: "Restore a page from the Notion trash.",
    parameters: { type: "object", properties: { page_id: PAGE_ID_PROPERTY }, required: ["page_id"] },
    run: async (context) => ({ data: await setPageTrashed(context, false) }),
  },
];
