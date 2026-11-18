/**
 * Account operations: the WABA's phone numbers and a number's business profile.
 */
import { pathSegment } from "../lib/shared/path.mjs";
import { checkMaxLength, paginationProperties, rejectInput, toPage } from "../lib/client.mjs";
import { PHONE_NUMBER_ID_PROPERTY, phoneNumberIdOf } from "./messaging.mjs";
import { BUSINESS_ACCOUNT_ID_PROPERTY, businessAccountIdOf } from "./templates.mjs";

const DEFAULT_PHONE_NUMBER_FIELDS = "id,display_phone_number,verified_name,quality_rating,code_verification_status";
const PROFILE_FIELDS = "about,address,description,email,profile_picture_url,websites,vertical";
const PROFILE_TEXT_LIMITS = { about: 139, address: 256, description: 512, email: 128 };
const MAX_WEBSITES = 2;
const VERTICALS = [
  "ALCOHOL", "APPAREL", "AUTO", "BEAUTY", "EDU", "ENTERTAIN", "EVENT_PLAN", "FINANCE", "GOVT", "GROCERY", "HEALTH",
  "HOTEL", "NONPROFIT", "ONLINE_GAMBLING", "OTC_DRUGS", "OTHER", "PHYSICAL_GAMBLING", "PROF_SERVICES", "RESTAURANT", "RETAIL", "TRAVEL",
];

const businessProfilePath = (args, environment) => `/${pathSegment(phoneNumberIdOf(args, environment))}/whatsapp_business_profile`;

function buildProfileUpdate(args) {
  const profileUpdate = {};
  for (const [fieldName, maxLength] of Object.entries(PROFILE_TEXT_LIMITS)) {
    if (args[fieldName] === undefined) continue;
    checkMaxLength(args[fieldName], maxLength, fieldName);
    profileUpdate[fieldName] = args[fieldName];
  }
  if (args.websites !== undefined) profileUpdate.websites = checkWebsites(args.websites);
  if (args.vertical !== undefined) profileUpdate.vertical = args.vertical;
  if (args.profile_picture_handle !== undefined) profileUpdate.profile_picture_handle = args.profile_picture_handle;
  if (Object.keys(profileUpdate).length === 0) rejectInput("Pass at least one profile field to change");
  return { messaging_product: "whatsapp", ...profileUpdate };
}

function checkWebsites(websites) {
  if (websites.length > MAX_WEBSITES) rejectInput(`\`websites\` can have at most ${MAX_WEBSITES} URLs`);
  websites.forEach((website, index) => {
    if (!/^https?:\/\//i.test(website)) rejectInput(`\`websites[${index}]\` must start with http:// or https://`);
    checkMaxLength(website, 256, `websites[${index}]`);
  });
  return websites;
}

export const accountOperations = [
  {
    name: "list_phone_numbers",
    title: "List WhatsApp phone numbers",
    description: "List the phone numbers on the WhatsApp Business Account with their display number, verified name and quality rating.",
    parameters: {
      type: "object",
      properties: { business_account_id: BUSINESS_ACCOUNT_ID_PROPERTY, fields: { type: "string", default: DEFAULT_PHONE_NUMBER_FIELDS }, ...paginationProperties() },
    },
    run: async ({ client, args, environment, signal }) =>
      toPage(
        await client.request({
          path: `/${pathSegment(businessAccountIdOf(args, environment))}/phone_numbers`,
          query: { fields: args.fields, limit: args.limit, after: args.cursor },
          signal,
        }),
      ),
  },
  {
    name: "get_business_profile",
    title: "Get WhatsApp business profile",
    description: "Read the business profile (about, address, description, email, websites, vertical, picture) of a phone number.",
    parameters: { type: "object", properties: { phone_number_id: PHONE_NUMBER_ID_PROPERTY, fields: { type: "string", default: PROFILE_FIELDS } } },
    run: async ({ client, args, environment, signal }) => {
      const profileResponse = await client.request({ path: businessProfilePath(args, environment), query: { fields: args.fields }, signal });
      return { data: profileResponse?.data?.[0] ?? null };
    },
  },
  {
    name: "update_business_profile",
    title: "Update WhatsApp business profile",
    description: "Change business profile fields of a phone number. Only the fields you pass are changed.",
    parameters: {
      type: "object",
      properties: {
        phone_number_id: PHONE_NUMBER_ID_PROPERTY,
        about: { type: "string", description: "Status text, 1-139 characters" },
        address: { type: "string", description: "Up to 256 characters" },
        description: { type: "string", description: "Up to 512 characters" },
        email: { type: "string", description: "Up to 128 characters" },
        websites: { type: "array", items: { type: "string" }, description: "Up to 2 URLs starting with http:// or https://" },
        vertical: { type: "string", enum: VERTICALS, description: "Business category" },
        profile_picture_handle: { type: "string", description: "Handle from the Resumable Upload API" },
      },
    },
    run: async ({ client, args, environment, signal }) => ({
      data: await client.request({ method: "POST", path: businessProfilePath(args, environment), json: buildProfileUpdate(args), signal }),
    }),
  },
];
