/**
 * Holiday operations built on one cached request per year (the declarative `list_holidays`, GET /api?year=YYYY):
 * `list_holidays` (filtered locally by month and kind), and the hand-written `check_date`, `next_holidays` and
 * `count_working_days`, which the upstream API does not offer (its /api/today only covers today and tomorrow).
 *
 * Every year list goes through the TTL cache (LIBUR_NASIONAL_CACHE_TTL_SECONDS, default 6 hours, 0 = off), keyed by
 * base URL and year. The upstream request runs as a node call (complete data, cached once); agent tool results are
 * truncated afterwards with the layer's truncateForTool.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";
import { countWorkingDays, describeDate, isCutiBersamaKnown, jakartaToday, parseIsoDate, pickUpcoming, sanitizeHolidayRecords } from "./holiday-calendar.mjs";

export const CACHE_TTL_ENV = "LIBUR_NASIONAL_CACHE_TTL_SECONDS";
const DEFAULT_CACHE_TTL_SECONDS = 6 * 3600;
const MAX_WORKING_DAY_SPAN_YEARS = 3;
const KINDS = ["all", "libur_nasional", "cuti_bersama"];

/**
 * Reads the cache TTL from the environment.
 *
 * @param environment - Environment variables (object)
 * @returns TTL in milliseconds; 0 disables the cache (number)
 * @throws PluginError kind `invalid_input` - The env value is not a non-negative integer
 */
export function resolveCacheTtlMs(environment) {
  const rawValue = environment?.[CACHE_TTL_ENV];
  if (rawValue === undefined || rawValue === "") return DEFAULT_CACHE_TTL_SECONDS * 1000;
  if (!/^\d+$/.test(String(rawValue).trim())) {
    throw new PluginError(`${CACHE_TTL_ENV} must be a whole number of seconds (0 turns the cache off); got ${JSON.stringify(rawValue)}`, { kind: "invalid_input" });
  }
  return Number(rawValue) * 1000;
}

function createYearLoader(fetchYearOperation, cache) {
  return (context, year) =>
    cache.getOrLoad(`${context.client.baseUrl}\n${year}`, resolveCacheTtlMs(context.environment), async () => {
      const result = await fetchYearOperation.run({ ...context, source: "node", args: { year } });
      if (!Array.isArray(result.data)) throw createNoDataError(`Holiday source: expected a list of holidays for ${year}`);
      const holidays = sanitizeHolidayRecords(result.data, year);
      // A throw here keeps the bad list out of the cache (failed loads are not cached).
      if (holidays.length === 0) throw createNoDataError(`Holiday source: no valid holidays (date YYYY-MM-DD, name, is_national_holiday) for ${year}`);
      return holidays;
    });
}

// An api_error marked as "the source has nothing usable for this year", which a following year may tolerate.
function createNoDataError(message) {
  const noDataError = new PluginError(message, { kind: "api_error" });
  noDataError.noHolidayData = true;
  return noDataError;
}

// A year outside the source's range (422 -> invalid_input), a 404, or an empty/invalid list: no data, not a failure.
function isMissingYearError(loadError) {
  return loadError?.noHolidayData === true || loadError?.kind === "invalid_input" || loadError?.kind === "not_found";
}

// Unknown when the year lists no cuti bersama or is after the current Jakarta year.
function findUnknownCutiBersamaYears(holidaysByYear, now) {
  const currentYear = currentJakartaYear(now);
  return [...holidaysByYear].filter(([year, holidays]) => !isCutiBersamaKnown(year, holidays, currentYear)).map(([year]) => year);
}

function shapeForCaller(context, data) {
  return { data: context.source === "tool" ? truncateForTool(data, DEFAULT_TOOL_OUTPUT) : data, next_cursor: null };
}

function currentJakartaYear(now) {
  return Number(jakartaToday(now()).slice(0, 4));
}

function buildListHolidays(fetchYearOperation, loadYear, now) {
  const properties = {
    ...fetchYearOperation.parameters.properties,
    month: { type: "integer", minimum: 1, maximum: 12, description: "Only this month (1-12)" },
    kind: { type: "string", enum: KINDS, default: "all", description: "all, libur_nasional (national holidays) or cuti_bersama (collective leave)" },
  };
  return {
    ...fetchYearOperation,
    parameters: { ...fetchYearOperation.parameters, properties },
    run: async (context) => {
      const year = context.args.year ?? currentJakartaYear(now);
      const holidays = await loadYear(context, year);
      const monthPrefix = context.args.month ? `${year}-${String(context.args.month).padStart(2, "0")}-` : `${year}-`;
      const kind = context.args.kind ?? "all";
      return shapeForCaller(context, holidays.filter((holiday) => holiday.date.startsWith(monthPrefix) && (kind === "all" || holiday.kind === kind)));
    },
  };
}

function buildCheckDate(loadYear, now) {
  return {
    name: "check_date",
    title: "Check a date",
    description: "Whether a date (default: today in Asia/Jakarta) is a national holiday, cuti bersama, weekend or working day, with the holiday names",
    parameters: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD (default: today in Asia/Jakarta)" } }, required: [] },
    run: async (context) => {
      const { year, text } = parseIsoDate(context.args.date ?? jakartaToday(now()), "date");
      const holidays = await loadYear(context, year);
      const cutiBersamaKnown = isCutiBersamaKnown(year, holidays, currentJakartaYear(now));
      return shapeForCaller(context, describeDate(text, holidays, { cutiBersamaKnown }));
    },
  };
}

// The source publishes up to next year; a later year that is out of range, empty or invalid is "no data yet" (an
// empty list plus a note), never an error. Network, rate-limit and server errors still fail the call.
async function loadFollowingYear(context, loadYear, year) {
  try {
    return { holidays: await loadYear(context, year) };
  } catch (loadError) {
    if (!isMissingYearError(loadError)) throw loadError;
    return { holidays: [], coverageNote: `No data for ${year} yet (${loadError.message})`, missing: true };
  }
}

// Years up to the current Jakarta year must load; later ones may have no data yet (see loadFollowingYear).
async function loadRangeYears(context, loadYear, { startYear, endYear, currentYear }) {
  const holidaysByYear = new Map();
  const noDataYears = [];
  for (let year = startYear; year <= endYear; year += 1) {
    if (year <= currentYear) {
      holidaysByYear.set(year, await loadYear(context, year));
      continue;
    }
    const following = await loadFollowingYear(context, loadYear, year);
    holidaysByYear.set(year, following.holidays);
    if (following.missing) noDataYears.push(year);
  }
  return { holidaysByYear, noDataYears };
}

function buildNextHolidays(loadYear, now) {
  const properties = {
    from_date: { type: "string", description: "YYYY-MM-DD to start from, included (default: today in Asia/Jakarta)" },
    count: { type: "integer", minimum: 1, maximum: 50, default: 5, description: "How many holidays" },
    include_cuti_bersama: { type: "boolean", default: true, description: "Also list cuti bersama (collective leave) days" },
  };
  return {
    name: "next_holidays",
    title: "Upcoming holidays",
    description: "The next national holidays (and cuti bersama) from a date, across the year boundary, with how many days away each is",
    parameters: { type: "object", properties, required: [] },
    run: async (context) => {
      const { year, text } = parseIsoDate(context.args.from_date ?? jakartaToday(now()), "from_date");
      const currentYearHolidays = await loadYear(context, year);
      const following = await loadFollowingYear(context, loadYear, year + 1);
      const holidays = [...currentYearHolidays, ...following.holidays];
      const upcoming = pickUpcoming(holidays, text, { count: context.args.count, includeCutiBersama: context.args.include_cuti_bersama });
      const fromMs = Date.parse(`${text}T00:00:00Z`);
      const withDistance = upcoming.map((holiday) => ({ ...holiday, days_away: Math.round((Date.parse(`${holiday.date}T00:00:00Z`) - fromMs) / 86400000) }));
      return shapeForCaller(context, { from_date: text, holidays: withDistance, ...(following.coverageNote ? { coverage_note: following.coverageNote } : {}) });
    },
  };
}

function buildCountWorkingDays(loadYear, now) {
  const properties = {
    start_date: { type: "string", description: "First day, YYYY-MM-DD (included)" },
    end_date: { type: "string", description: "Last day, YYYY-MM-DD (included)" },
    cuti_bersama_is_day_off: { type: "boolean", default: true, description: "Count cuti bersama as days off (true for civil servants; many private employers follow it)" },
  };
  return {
    name: "count_working_days",
    title: "Count working days",
    description: `Working days (Monday-Friday minus national holidays and, by default, cuti bersama) between two dates, both included; at most ${MAX_WORKING_DAY_SPAN_YEARS} calendar years`,
    parameters: { type: "object", properties, required: ["start_date", "end_date"] },
    run: async (context) => {
      const start = parseIsoDate(context.args.start_date, "start_date");
      const end = parseIsoDate(context.args.end_date, "end_date");
      if (end.text < start.text) throw new PluginError("`end_date` must not be before `start_date`", { kind: "invalid_input" });
      if (end.year - start.year >= MAX_WORKING_DAY_SPAN_YEARS) {
        throw new PluginError(`The range may span at most ${MAX_WORKING_DAY_SPAN_YEARS} calendar years`, { kind: "invalid_input" });
      }
      const range = { startYear: start.year, endYear: end.year, currentYear: currentJakartaYear(now) };
      const { holidaysByYear, noDataYears } = await loadRangeYears(context, loadYear, range);
      const counted = countWorkingDays(start.text, end.text, [...holidaysByYear.values()].flat(), {
        cutiBersamaIsDayOff: context.args.cuti_bersama_is_day_off,
        unknownCutiBersamaYears: findUnknownCutiBersamaYears(holidaysByYear, now),
        noDataYears,
      });
      return shapeForCaller(context, counted);
    },
  };
}

/**
 * Replaces the declarative `list_holidays` with its cached, filtered form and adds the date operations.
 *
 * @param restDefinition - Definition from defineRestPlugin with a `list_holidays` operation (object)
 * @param options - `{cache, now}`: a createTtlCache() instance and a millisecond clock (object)
 * @returns A new definition (object)
 * @throws Error - The definition has no list_holidays operation
 */
export function addHolidayOperations(restDefinition, { cache, now = Date.now }) {
  const fetchYearOperation = restDefinition.operations.find((operation) => operation.name === "list_holidays");
  if (!fetchYearOperation) throw new Error(`${restDefinition.name}: addHolidayOperations needs a list_holidays operation`);
  const loadYear = createYearLoader(fetchYearOperation, cache);
  const otherOperations = restDefinition.operations.filter((operation) => operation !== fetchYearOperation);
  const holidayOperations = [buildListHolidays(fetchYearOperation, loadYear, now), buildCheckDate(loadYear, now), buildNextHolidays(loadYear, now), buildCountWorkingDays(loadYear, now)];
  return { ...restDefinition, operations: [...holidayOperations, ...otherOperations] };
}
