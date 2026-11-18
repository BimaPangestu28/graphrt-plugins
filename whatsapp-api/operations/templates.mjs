/**
 * Message template operations on the WhatsApp Business Account (WABA):
 * /{waba-id}/message_templates.
 */
import { pathSegment } from "../lib/shared/path.mjs";
import { paginationProperties, rejectInput, resolveId, toPage } from "../lib/client.mjs";

const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
const DEFAULT_TEMPLATE_FIELDS = "id,name,status,category,language,components";
const TEMPLATE_CATEGORIES = ["UTILITY", "MARKETING", "AUTHENTICATION"];
const BUSINESS_ACCOUNT_ID_PROPERTY = { type: "string", description: "WhatsApp Business Account id (default: WHATSAPP_BUSINESS_ACCOUNT_ID)" };

/**
 * Resolves the WABA id from the arguments or WHATSAPP_BUSINESS_ACCOUNT_ID.
 *
 * @param args - Operation arguments (object)
 * @param environment - Environment variables (object)
 * @returns WABA id (string)
 */
export const businessAccountIdOf = (args, environment) =>
  resolveId(args.business_account_id, environment, "WHATSAPP_BUSINESS_ACCOUNT_ID", "business_account_id");

export { BUSINESS_ACCOUNT_ID_PROPERTY };

function buildCreateTemplateBody(args) {
  if (!TEMPLATE_NAME_PATTERN.test(args.name)) rejectInput("`name` must be lowercase letters, digits and underscores only (max 512), e.g. order_update");
  const templateBody = { name: args.name, category: args.category, language: args.language, components: args.components };
  if (args.parameter_format) templateBody.parameter_format = args.parameter_format;
  if (args.allow_category_change !== undefined) templateBody.allow_category_change = args.allow_category_change;
  return templateBody;
}

export const templateOperations = [
  {
    name: "list_templates",
    title: "List WhatsApp templates",
    description: "List the WABA's message templates, optionally filtered by status, name, category or language.",
    parameters: {
      type: "object",
      properties: {
        business_account_id: BUSINESS_ACCOUNT_ID_PROPERTY,
        status: { type: "string", description: "e.g. APPROVED, PENDING, REJECTED, PAUSED, DISABLED" },
        name: { type: "string", description: "Name filter" },
        category: { type: "string", enum: TEMPLATE_CATEGORIES },
        language: { type: "string", description: "Language code, e.g. en_US" },
        fields: { type: "string", default: DEFAULT_TEMPLATE_FIELDS },
        ...paginationProperties(),
      },
    },
    run: async ({ client, args, environment, signal }) => {
      const { status, name, category, language, fields, limit, cursor } = args;
      const query = { status, name, category, language, fields, limit, after: cursor };
      return toPage(await client.request({ path: `/${pathSegment(businessAccountIdOf(args, environment))}/message_templates`, query, signal }));
    },
  },
  {
    name: "get_template",
    title: "Get WhatsApp template",
    description: "Read one message template by id (status, category, components).",
    parameters: {
      type: "object",
      properties: { template_id: { type: "string" }, fields: { type: "string", default: DEFAULT_TEMPLATE_FIELDS } },
      required: ["template_id"],
    },
    run: async ({ client, args, signal }) => ({
      data: await client.request({ path: `/${pathSegment(args.template_id)}`, query: { fields: args.fields }, signal }),
    }),
  },
  {
    name: "create_template",
    title: "Create WhatsApp template",
    description: "Submit a new message template for review. Components with parameters need example values.",
    parameters: {
      type: "object",
      properties: {
        business_account_id: BUSINESS_ACCOUNT_ID_PROPERTY,
        name: { type: "string", description: "Lowercase letters, digits and underscores" },
        category: { type: "string", enum: TEMPLATE_CATEGORIES },
        language: { type: "string", description: "Language code, e.g. en_US, id" },
        components: { type: "array", items: { type: "object" }, description: 'e.g. [{"type":"BODY","text":"Your order {{1}} shipped","example":{"body_text":[["A1"]]}}]' },
        parameter_format: { type: "string", enum: ["positional", "named"], description: "Parameter style (API default: positional)" },
        allow_category_change: { type: "boolean", description: "Let Meta change the category instead of rejecting" },
      },
      required: ["name", "category", "language", "components"],
    },
    run: async ({ client, args, environment, signal }) => ({
      data: await client.request({
        method: "POST",
        path: `/${pathSegment(businessAccountIdOf(args, environment))}/message_templates`,
        json: buildCreateTemplateBody(args),
        signal,
      }),
    }),
  },
  {
    name: "delete_template",
    title: "Delete WhatsApp template",
    description: "Delete a template by name (all languages), or only one language version by name plus template_id.",
    parameters: {
      type: "object",
      properties: {
        business_account_id: BUSINESS_ACCOUNT_ID_PROPERTY,
        name: { type: "string", description: "Template name" },
        template_id: { type: "string", description: "Template id (hsm_id) to delete just that version" },
      },
      required: ["name"],
    },
    run: async ({ client, args, environment, signal }) => ({
      data: await client.request({
        method: "DELETE",
        path: `/${pathSegment(businessAccountIdOf(args, environment))}/message_templates`,
        query: { name: args.name, hsm_id: args.template_id },
        signal,
      }),
    }),
  },
];
