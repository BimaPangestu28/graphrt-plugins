/**
 * Accounts (Account Management API v1) and locations (Business Information API v1):
 * list accounts, list and get locations, and update a location's description, phones and hours.
 */
import { paginationProperties, rejectInput, toPage, withIdempotentRetry } from "../lib/client.mjs";
import { parseDate, parseTimeOfDay } from "../lib/date-time.mjs";
import { ACCOUNT_ID_PROPERTY, LOCATION_ID_PROPERTY, normalizeResourceId, v1LocationPath } from "../lib/resource-names.mjs";

const LIST_READ_MASK = "name,title,storeCode,phoneNumbers,storefrontAddress,websiteUri,metadata";
const GET_READ_MASK =
  "name,title,storeCode,languageCode,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,specialHours,serviceArea,openInfo,profile,metadata";
const DAYS_OF_WEEK = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const MAX_DESCRIPTION_LENGTH = 750;
const READ_MASK_PROPERTY = { type: "string", description: "Comma-separated Location fields to return (readMask)" };

function buildRegularHours(regularHours) {
  if (regularHours.length === 0) rejectInput("`regular_hours` must contain at least one period");
  const periods = regularHours.map((period, periodIndex) => {
    const argumentPrefix = `regular_hours[${periodIndex}]`;
    if (!period || typeof period !== "object") rejectInput(`\`${argumentPrefix}\` must be an object {open_day, open_time, close_time, close_day?}`);
    const openDay = parseDay(period.open_day, `${argumentPrefix}.open_day`);
    const openTime = parseTimeOfDay(period.open_time, `${argumentPrefix}.open_time`);
    const closeTime = parseTimeOfDay(period.close_time, `${argumentPrefix}.close_time`);
    const closeDay = period.close_day === undefined ? inferCloseDay(openDay, openTime, closeTime) : parseDay(period.close_day, `${argumentPrefix}.close_day`);
    return { openDay, openTime, closeDay, closeTime };
  });
  return { periods };
}

// Without close_day, a close time before the open time (22:00-02:00) means the period ends the next day.
function inferCloseDay(openDay, openTime, closeTime) {
  const isOvernight = closeTime.hours * 60 + closeTime.minutes < openTime.hours * 60 + openTime.minutes;
  if (!isOvernight) return openDay;
  return DAYS_OF_WEEK[(DAYS_OF_WEEK.indexOf(openDay) + 1) % DAYS_OF_WEEK.length];
}

function parseDay(dayText, argumentName) {
  const day = String(dayText ?? "").trim().toUpperCase();
  if (!DAYS_OF_WEEK.includes(day)) rejectInput(`\`${argumentName}\` must be one of ${DAYS_OF_WEEK.join(", ")}`);
  return day;
}

function buildSpecialHours(specialHours) {
  if (specialHours.length === 0) rejectInput("`special_hours` must contain at least one period");
  const specialHourPeriods = specialHours.map((period, periodIndex) => {
    const argumentPrefix = `special_hours[${periodIndex}]`;
    if (!period || typeof period !== "object") rejectInput(`\`${argumentPrefix}\` must be an object {date, closed?, open_time?, close_time?, end_date?}`);
    const startDate = parseDate(period.date, `${argumentPrefix}.date`);
    if (period.closed === true) return { startDate, closed: true };
    if (period.open_time === undefined || period.close_time === undefined) rejectInput(`\`${argumentPrefix}\` needs open_time and close_time unless closed is true`);
    return {
      startDate,
      endDate: period.end_date === undefined ? undefined : parseDate(period.end_date, `${argumentPrefix}.end_date`),
      openTime: parseTimeOfDay(period.open_time, `${argumentPrefix}.open_time`),
      closeTime: parseTimeOfDay(period.close_time, `${argumentPrefix}.close_time`),
    };
  });
  return { specialHourPeriods };
}

/**
 * Builds the Location body and updateMask for update_location from the given fields only.
 *
 * @param args - update_location arguments (object)
 * @returns `{location, updateMask}` (object)
 * @throws PluginError kind `invalid_input` - When nothing is given or a field is malformed
 */
export function buildLocationUpdate(args) {
  const location = {};
  const maskFields = [];
  if (args.description !== undefined) {
    location.profile = { description: args.description };
    maskFields.push("profile.description");
  }
  if (args.primary_phone !== undefined || args.additional_phones !== undefined) {
    location.phoneNumbers = { primaryPhone: args.primary_phone, additionalPhones: args.additional_phones };
    if (args.primary_phone !== undefined) maskFields.push("phoneNumbers.primaryPhone");
    if (args.additional_phones !== undefined) maskFields.push("phoneNumbers.additionalPhones");
  }
  if (args.regular_hours !== undefined) {
    location.regularHours = buildRegularHours(args.regular_hours);
    maskFields.push("regularHours");
  }
  if (args.special_hours !== undefined) {
    location.specialHours = buildSpecialHours(args.special_hours);
    maskFields.push("specialHours");
  }
  if (maskFields.length === 0) rejectInput("Pass at least one of description, primary_phone, additional_phones, regular_hours, special_hours");
  return { location, updateMask: maskFields.join(",") };
}

export const accountLocationOperations = [
  {
    name: "list_accounts",
    title: "List Business Profile accounts",
    description: "List the Business Profile accounts (personal, location groups, organizations) the credentials can access.",
    parameters: {
      type: "object",
      properties: {
        parent_account: { type: "string", description: "Organization or user group account id, to list the accounts under it" },
        type: { type: "string", enum: ["PERSONAL", "LOCATION_GROUP", "USER_GROUP", "ORGANIZATION"], description: "Only accounts of this type" },
        ...paginationProperties(20, 20),
      },
    },
    run: async ({ client, args, signal }) => {
      const query = {
        parentAccount: args.parent_account === undefined ? undefined : `accounts/${normalizeResourceId(args.parent_account, "accounts", "parent_account")}`,
        filter: args.type === undefined ? undefined : `type=${args.type}`,
        pageSize: args.limit,
        pageToken: args.cursor,
      };
      const accountPage = await client.account_management.request({ path: "/accounts", query, signal });
      return toPage(accountPage?.accounts, accountPage?.nextPageToken);
    },
  },
  {
    name: "list_locations",
    title: "List Business Profile locations",
    description: "List an account's locations (businesses) with title, address, phone, website and Maps ids. Location `name` is locations/{id}.",
    parameters: {
      type: "object",
      properties: {
        account_id: ACCOUNT_ID_PROPERTY,
        read_mask: { ...READ_MASK_PROPERTY, default: LIST_READ_MASK },
        filter: { type: "string", description: 'Filter expression, e.g. title="Kopi Kenangan"' },
        order_by: { type: "string", enum: ["title", "title desc", "storeCode", "storeCode desc"] },
        ...paginationProperties(100, 20),
      },
      required: ["account_id"],
    },
    run: async ({ client, args, signal }) => {
      const accountId = normalizeResourceId(args.account_id, "accounts", "account_id");
      const query = { readMask: args.read_mask, filter: args.filter, orderBy: args.order_by, pageSize: args.limit, pageToken: args.cursor };
      const locationPage = await client.business_information.request({ path: `/accounts/${accountId}/locations`, query, signal });
      return toPage(locationPage?.locations, locationPage?.nextPageToken);
    },
  },
  {
    name: "get_location",
    title: "Get Business Profile location",
    description: "Get one location's details: profile description, phones, categories, address, regular and special hours.",
    parameters: {
      type: "object",
      properties: { location_id: LOCATION_ID_PROPERTY, read_mask: { ...READ_MASK_PROPERTY, default: GET_READ_MASK } },
      required: ["location_id"],
    },
    run: async ({ client, args, signal }) => ({
      data: await client.business_information.request({ path: v1LocationPath(args.location_id), query: { readMask: args.read_mask }, signal }),
    }),
  },
  {
    name: "update_location",
    title: "Update Business Profile location",
    description:
      "Update only the given fields of a location: description, primary/additional phones, regular hours (replaces all periods) and special hours (replaces all). Times are HH:MM, dates YYYY-MM-DD. Safe to resend after a failure.",
    parameters: {
      type: "object",
      properties: {
        location_id: LOCATION_ID_PROPERTY,
        description: { type: "string", description: `Business description (max ${MAX_DESCRIPTION_LENGTH} characters)` },
        primary_phone: { type: "string", description: "Primary phone, e.g. +62 21 555 0100" },
        additional_phones: { type: "array", items: { type: "string" }, maxItems: 2, description: "Up to 2 extra phones; [] removes them" },
        regular_hours: {
          type: "array",
          items: { type: "object" },
          maxItems: 50,
          description:
            'Opening periods, e.g. [{"open_day": "MONDAY", "open_time": "09:00", "close_time": "17:00"}]; close_day defaults to open_day, or the next day when close_time is before open_time (overnight)',
        },
        special_hours: {
          type: "array",
          items: { type: "object" },
          maxItems: 200,
          description: 'Holiday hours, e.g. [{"date": "2026-12-25", "closed": true}, {"date": "2026-12-31", "open_time": "10:00", "close_time": "15:00"}]',
        },
        validate_only: { type: "boolean", default: false, description: "Only validate, do not change the location" },
      },
      required: ["location_id"],
    },
    run: async ({ client, args, signal }) => {
      if (args.description !== undefined && args.description.length > MAX_DESCRIPTION_LENGTH) rejectInput(`\`description\` must have at most ${MAX_DESCRIPTION_LENGTH} characters`);
      const { location, updateMask } = buildLocationUpdate(args);
      const query = { updateMask, validateOnly: args.validate_only || undefined };
      const pendingUpdate = client.business_information.request({ method: "PATCH", path: v1LocationPath(args.location_id), query, json: location, signal });
      const updatedLocation = await withIdempotentRetry(pendingUpdate);
      return { data: { update_mask: updateMask, validate_only: args.validate_only, location: updatedLocation } };
    },
  },
];
