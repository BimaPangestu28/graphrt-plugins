/**
 * currency-rates plugin definition: exchange rates from Frankfurter v2 (https://frankfurter.dev), a free, keyless
 * API that publishes reference rates of the ECB and other central banks. Built with the declarative REST layer
 * (docs/declarative-plugins.md).
 *
 * Frankfurter has no conversion endpoint (its docs say to fetch the rate and multiply), so `convert` is a small
 * hand-written operation on top of `get_pair_rate`.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";

const RESULT_DECIMALS = 6;
const currencyParam = (location, description) => ({ in: location, type: "string", minLength: 3, description });
const dateParam = (description, required = false) => ({ in: "query", type: "string", ...(required ? { required: true } : {}), description });
const quotesParam = { in: "query", type: "array", items: { type: "string" }, maxItems: 200, description: "Target currencies, e.g. [IDR, EUR] (default: all)" };
const providersParam = {
  in: "query",
  type: "array",
  items: { type: "string" },
  maxItems: 20,
  description: "Only rates of these providers, e.g. [ECB] (see list_providers; default: Frankfurter's blend)",
};
const baseParam = currencyParam("query", "Base currency, e.g. USD (default EUR)");
const rateRowsNote = "rows of {date, base, quote, rate}";

const getLatestRates = {
  name: "get_latest_rates",
  title: "Latest exchange rates",
  description: `Latest reference rates for a base currency: ${rateRowsNote}`,
  path: "/v2/rates",
  params: { base: baseParam, quotes: quotesParam, providers: providersParam },
};

const getHistoricalRates = {
  name: "get_historical_rates",
  title: "Historical exchange rates",
  description: `Reference rates on a past date (the last published day on or before it): ${rateRowsNote}`,
  path: "/v2/rates",
  params: { date: dateParam("Date, YYYY-MM-DD (data back to 1999 for ECB)", true), base: baseParam, quotes: quotesParam, providers: providersParam },
};

const getRateTimeSeries = {
  name: "get_rate_time_series",
  title: "Exchange rate time series",
  description: `Rates for every published day in a date range, optionally one row per week or month: ${rateRowsNote}`,
  path: "/v2/rates",
  params: {
    from: dateParam("Start date, YYYY-MM-DD", true),
    to: dateParam("End date, YYYY-MM-DD (default today)"),
    base: baseParam,
    quotes: quotesParam,
    group: { in: "query", type: "string", enum: ["week", "month"], description: "One row per week or month instead of per day" },
    providers: providersParam,
  },
};

const getPairRate = {
  name: "get_pair_rate",
  title: "Exchange rate for a pair",
  description: "One rate {date, base, quote, rate}: 1 base = rate quote, latest or on a date",
  path: "/v2/rate/{base}/{quote}",
  params: {
    base: currencyParam("path", "Base currency, e.g. USD"),
    quote: currencyParam("path", "Quote currency, e.g. IDR"),
    date: dateParam("Date, YYYY-MM-DD (default: latest)"),
  },
};
getPairRate.params.base.required = true;
getPairRate.params.quote.required = true;

const listCurrencies = {
  name: "list_currencies",
  title: "List currencies",
  description: "Currencies with rates: iso_code, name, symbol, type (currency or crypto), start_date and end_date",
  path: "/v2/currencies",
  params: {
    scope: { in: "query", type: "string", enum: ["all"], description: "all: also list legacy currencies that are no longer published" },
  },
};

const getCurrency = {
  name: "get_currency",
  title: "Get currency",
  description: "One currency: name, symbol, ISO numeric code, date range and the providers that publish it",
  path: "/v2/currency/{code}",
  params: { code: { in: "path", type: "string", required: true, minLength: 3, description: "Currency code, e.g. IDR" } },
};

const listProviders = {
  name: "list_providers",
  title: "List rate providers",
  description: "Central banks and other sources Frankfurter publishes: key, name, country, rate type, pivot currency, date range",
  path: "/v2/providers",
};

export const restDefinition = defineRestPlugin({
  name: "currency-rates",
  version: "0.1.0",
  description: "Exchange rates from Frankfurter (ECB and other central banks, no API key): latest, historical, time series, pair rates and conversion",
  apiName: "Frankfurter API",
  baseUrl: "https://api.frankfurter.dev",
  auth: { type: "none" },
  // Errors are {"status": 422, "message": "invalid currency: ABC"}.
  errors: { messagePath: "message" },
  apiRequest: { examplePath: "/v2/rates" },
  operations: [getLatestRates, getHistoricalRates, getRateTimeSeries, getPairRate, listCurrencies, getCurrency, listProviders],
});

const convertParameters = {
  type: "object",
  properties: {
    amount: { type: "number", minimum: 0, description: "Amount in the `from` currency" },
    from: { type: "string", minLength: 3, description: "Currency of the amount, e.g. USD" },
    to: { type: "string", minLength: 3, description: "Currency to convert into, e.g. IDR" },
    date: { type: "string", description: "Use the rate of this date, YYYY-MM-DD (default: latest)" },
  },
  required: ["amount", "from", "to"],
};

/**
 * Builds the `convert` operation: reads the pair rate through `get_pair_rate` and multiplies.
 *
 * @param pairRateOperation - The declarative get_pair_rate operation (object)
 * @returns Operation `{name, title, description, parameters, run}` (object)
 */
export function createConvertOperation(pairRateOperation) {
  const run = async (context) => {
    const { amount, from, to, date } = context.args;
    const pairArgs = { base: from, quote: to, ...(date ? { date } : {}) };
    const { data: pairRate } = await pairRateOperation.run({ ...context, args: pairArgs });
    return { data: describeConversion(amount, pairRate), next_cursor: null };
  };
  return {
    name: "convert",
    title: "Convert an amount",
    description: "Convert an amount between currencies with the latest (or a dated) reference rate: {amount, from, to, date, rate, result}",
    parameters: convertParameters,
    run,
  };
}

function describeConversion(amount, pairRate) {
  if (typeof pairRate?.rate !== "number") {
    throw new PluginError("Frankfurter returned no rate for this pair", { kind: "api_error" });
  }
  const result = Number((amount * pairRate.rate).toFixed(RESULT_DECIMALS));
  return { amount, from: String(pairRate.base).toUpperCase(), to: String(pairRate.quote).toUpperCase(), date: pairRate.date, rate: pairRate.rate, result };
}

const pairRateOperation = restDefinition.operations.find((operation) => operation.name === "get_pair_rate");

export const pluginDefinition = { ...restDefinition, operations: [...restDefinition.operations, createConvertOperation(pairRateOperation)] };
