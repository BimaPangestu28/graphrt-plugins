/**
 * bps plugin definition: official statistics of Badan Pusat Statistik (Statistics Indonesia) through the BPS Web
 * API (https://webapi.bps.go.id/documentation/, OpenAPI 3.1 "BPS Statistical Data API"). Built with the declarative
 * REST layer (docs/declarative-plugins.md).
 *
 * The documented URLs carry every parameter as `/name/value` path segments, the key last (`.../key/<key>`). The
 * server reads the same parameters from the query string too, so the key is sent as `?key=` (the layer's query
 * auth, redacted everywhere) and never becomes part of a path template. Every endpoint is a read: all operations
 * are agent tools.
 *
 * List responses are `{status, "data-availability", data: [pageInfo, items]}`: dataPath `data.1`, page numbers
 * from `data.0.pages`.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const domainParam = {
  in: "path",
  type: "string",
  required: true,
  minLength: 4,
  description: '4-digit BPS domain id from list_domains: "0000" national, "3100" DKI Jakarta, "3273" Kota Bandung',
};
const langQuery = { in: "query", type: "string", enum: ["ind", "eng"], description: "Response language (default ind)" };
const langPath = { in: "path", type: "string", required: true, enum: ["ind", "eng"], description: "Response language: ind or eng" };
const variableQuery = { in: "query", type: "integer", min: 1, wireName: "var", description: "Variable id (var_id from list_variables), e.g. 145" };
const contentFilters = {
  lang: langQuery,
  month: { in: "query", type: "integer", min: 1, max: 12, description: "Month 1-12" },
  year: { in: "query", type: "integer", min: 1900, max: 2100, description: "Four-digit year" },
  keyword: { in: "query", type: "string", description: "Search words (use + between words, e.g. inflasi+bulanan)" },
};
const pagedList = (extra = {}) => ({ dataPath: "data.1", pagePagination: { pageParam: "page", totalPagesPath: "data.0.pages", ...extra } });
const listPath = (model) => `/v1/api/list/model/${model}/domain/{domain}`;
const viewPath = (model) => `/v1/api/view/domain/{domain}/model/${model}/lang/{lang}/id/{item_id}`;

const domainOperations = [
  {
    name: "list_domains",
    title: "List BPS domains",
    description: "BPS domains (national, provinces, regencies/cities) with their 4-digit domain_id, needed by every other operation",
    path: "/v1/api/domain/type/{domain_type}",
    params: {
      domain_type: { in: "path", type: "string", required: true, enum: ["all", "prov", "kab", "kabbyprov"], description: "all, prov (provinces), kab (regencies/cities), kabbyprov (regencies of one province: set province)" },
      province: { in: "query", type: "string", minLength: 4, wireName: "prov", description: "4-digit province domain id for kabbyprov, e.g. 3200" },
    },
    response: { dataPath: "data.1" },
  },
  {
    name: "list_subject_categories",
    title: "List subject categories",
    description: "Top-level subject categories of a domain (e.g. Sosial dan Kependudukan, Ekonomi dan Perdagangan)",
    path: listPath("subcat"),
    params: { domain: domainParam, lang: langQuery },
    response: pagedList(),
  },
  {
    name: "list_subjects",
    title: "List subjects",
    description: "Subjects of a domain (sub_id, title, category); filter by subject category",
    path: listPath("subject"),
    params: { domain: domainParam, lang: langQuery, subject_category: { in: "query", type: "integer", min: 1, wireName: "subcat", description: "subcat_id from list_subject_categories" } },
    response: pagedList(),
  },
];

const dynamicDataOperations = [
  {
    name: "list_variables",
    title: "List variables",
    description: "Variables (dynamic tables) of a domain with unit and subject; use var_id with get_dynamic_data",
    path: listPath("var"),
    params: {
      domain: domainParam,
      lang: langQuery,
      subject: { in: "query", type: "integer", min: 1, description: "sub_id from list_subjects" },
      year: { in: "query", type: "integer", min: 1900, max: 2100, description: "Only variables with data for this year" },
      own_domain_only: { in: "query", type: "integer", enum: [0, 1], wireName: "area", description: "1 = only variables that exist in this domain" },
      vertical_variable: { in: "query", type: "integer", wireName: "vervar", description: "Only variables using this vertical variable id" },
    },
    response: pagedList(),
  },
  {
    name: "list_vertical_variables",
    title: "List vertical variables",
    description: "Row breakdowns (vervar, e.g. provinces or age groups) of a domain or of one variable",
    path: listPath("vervar"),
    params: { domain: domainParam, lang: langQuery, variable: variableQuery },
    response: pagedList(),
  },
  {
    name: "list_derived_variables",
    title: "List derived variables",
    description: "Column breakdowns (turvar) of a domain or of one variable",
    path: listPath("turvar"),
    params: { domain: domainParam, lang: langQuery, variable: variableQuery, group: { in: "query", type: "integer", min: 0, description: "Group id of the vertical variable" } },
    response: pagedList(),
  },
  {
    name: "list_periods",
    title: "List periods",
    description: "Periods (th_id and year label) available for a variable; th_id goes into get_dynamic_data",
    path: listPath("th"),
    params: { domain: domainParam, lang: langQuery, variable: variableQuery },
    response: pagedList(),
  },
  {
    name: "list_derived_periods",
    title: "List derived periods",
    description: "Sub-periods (turth: annual, months, quarters) of a variable",
    path: listPath("turth"),
    params: { domain: domainParam, lang: langQuery, variable: variableQuery },
    response: pagedList(),
  },
  {
    name: "list_units",
    title: "List units",
    description: "Measurement units used by variables of a domain",
    path: listPath("unit"),
    params: { domain: domainParam, lang: langQuery },
    response: pagedList(),
  },
  {
    name: "get_dynamic_data",
    title: "Get dynamic data",
    description:
      "Values of one variable with labels: datacontent keys concatenate vervar + var + turvar + th + turth ids; read labels from vervar, turvar, tahun, turtahun",
    path: "/v1/api/list/model/data/domain/{domain}/var/{variable}/th/{periods}",
    params: {
      domain: domainParam,
      variable: { in: "path", type: "integer", required: true, min: 1, description: "var_id from list_variables" },
      periods: { in: "path", type: "string", required: true, description: 'th_id(s) from list_periods: one ("124"), a list ("123;124") or a range ("120:124")' },
      lang: langQuery,
      derived_variable: { in: "query", type: "integer", wireName: "turvar", description: "turvar_id from list_derived_variables" },
      vertical_variable: { in: "query", type: "integer", wireName: "vervar", description: "Row id (item_ver_id), e.g. 9999 for INDONESIA" },
      derived_periods: { in: "query", type: "string", wireName: "turth", description: 'turth_id(s): "0", "1;2" or "1:12"' },
    },
  },
];

const tableOperations = [
  {
    name: "list_static_tables",
    title: "List static tables",
    description: "Published static tables of a domain (table_id, title, subject, update date, Excel link)",
    path: listPath("statictable"),
    params: { domain: domainParam, ...contentFilters },
    response: pagedList(),
  },
  {
    name: "get_static_table",
    title: "Get static table",
    description: "One static table; its HTML table is in `table`",
    path: viewPath("statictable"),
    params: { domain: domainParam, lang: langPath, item_id: { in: "path", type: "integer", required: true, min: 1, description: "table_id from list_static_tables" } },
    response: { dataPath: "data" },
  },
  {
    name: "list_strategic_indicators",
    title: "List strategic indicators",
    description: "Headline indicators (inflation, unemployment, growth, ...) with their latest value; national and province domains only",
    path: listPath("indicators"),
    params: { domain: domainParam, lang: langQuery, variable: variableQuery },
    response: pagedList(),
  },
  {
    name: "get_foreign_trade",
    title: "Get export/import data",
    description: "Export or import value (USD) and net weight (kg) by HS code, port and country for a year",
    path: "/v1/api/dataexim/sumber/{trade_flow}/periode/{period_type}/kodehs/{hs_codes}/jenishs/{hs_code_type}/tahun/{year}",
    params: {
      trade_flow: { in: "path", type: "integer", required: true, enum: [1, 2], description: "1 export, 2 import" },
      period_type: { in: "path", type: "integer", required: true, enum: [1, 2], description: "1 monthly, 2 annual" },
      hs_codes: { in: "path", type: "string", required: true, description: 'HS code(s) separated by ";", e.g. "03;04"' },
      hs_code_type: { in: "path", type: "integer", required: true, enum: [1, 2], description: "1 two-digit HS chapters, 2 full HS codes" },
      year: { in: "path", type: "integer", required: true, min: 1990, max: 2100, description: "Year of the data" },
    },
    response: { dataPath: "data" },
  },
];

const contentOperations = [
  {
    name: "list_press_releases",
    title: "List press releases",
    description: "Official statistical news releases (BRS) of a domain",
    path: listPath("pressrelease"),
    params: { domain: domainParam, ...contentFilters },
    response: pagedList(),
  },
  {
    name: "get_press_release",
    title: "Get press release",
    description: "One press release with abstract, release date and PDF link",
    path: viewPath("pressrelease"),
    params: { domain: domainParam, lang: langPath, item_id: { in: "path", type: "string", required: true, description: "brs_id from list_press_releases" } },
    response: { dataPath: "data" },
  },
  {
    name: "list_publications",
    title: "List publications",
    description: "Publications of a domain (statistical yearbooks, reports) with PDF links",
    path: listPath("publication"),
    params: { domain: domainParam, ...contentFilters },
    response: pagedList(),
  },
  {
    name: "get_publication",
    title: "Get publication",
    description: "One publication with catalogue numbers, ISSN, abstract and PDF link",
    path: viewPath("publication"),
    params: { domain: domainParam, lang: langPath, item_id: { in: "path", type: "string", required: true, description: "pub_id from list_publications" } },
    response: { dataPath: "data" },
  },
  {
    name: "search_content",
    title: "Search content",
    description: "Full-text search of one kind of content (tables, publications, press releases, news, infographics) in a domain",
    path: "/v1/searching/content/domain/{domain}/model/{content_type}",
    params: {
      domain: domainParam,
      content_type: { in: "path", type: "string", required: true, enum: ["tablestatistic", "publication", "pressrelease", "news", "infographic"], description: "Kind of content" },
      keyword: { in: "query", type: "string", description: "Words to search for (use + between words)" },
      from_date: { in: "query", type: "string", wireName: "from", description: "Start date YYYY-MM-DD" },
      to_date: { in: "query", type: "string", wireName: "to", description: "End date YYYY-MM-DD" },
      classification: { in: "query", type: "string", description: "CSA subject id" },
      lang: langQuery,
    },
    response: { ...pagedList({ sizeParam: "perpage" }), maxLimit: 100 },
  },
];

const referenceOperations = [
  {
    name: "list_glossary",
    title: "List glossary",
    description: "Statistical concepts and definitions (Indonesian and English), optionally those starting with a letter",
    path: "/v1/api/list/model/glosarium",
    params: { prefix: { in: "query", type: "string", description: "First letter(s), e.g. a" } },
    response: { ...pagedList({ sizeParam: "perpage" }), maxLimit: 100 },
  },
  {
    name: "list_classifications",
    title: "List classifications",
    description: "Items of the KBLI (industry, 2009-2020) or KBKI (products, 2015) classifications",
    path: "/v1/api/list/model/{classification}",
    params: {
      classification: { in: "path", type: "string", required: true, enum: ["kbli2009", "kbli2015", "kbli2017", "kbli2020", "kbki2015"], description: "Classification" },
      level: { in: "query", type: "string", description: "Item level, e.g. kategori, golongan pokok, golongan, subgolongan, kelompok" },
    },
    response: { ...pagedList({ sizeParam: "perpage" }), maxLimit: 100 },
  },
];

const restDefinition = defineRestPlugin({
  name: "bps",
  version: "0.1.0",
  description: "BPS (Statistics Indonesia) Web API: domains, subjects, variables and dynamic data, static tables, indicators, press releases, publications, search, glossary, KBLI and export/import",
  apiName: "BPS Web API",
  baseUrl: "https://webapi.bps.go.id",
  auth: { type: "query", param: "key", env: "BPS_API_KEY" },
  // Errors are {"status":"Error","code":"KEY_MISSING","message":"Invalid API KEY"} (401 for a bad key, 400 for a bad
  // domain, 404 {"status":"Error","data-availability":"not-available"} when nothing exists). okPath also catches
  // {"status":"Error"} in a 200.
  errors: { messagePath: "message", codePath: "code", kindByCode: { KEY_MISSING: "auth_error" }, okPath: "status", okValue: "OK" },
  apiRequest: { examplePath: "/v1/api/list/model/infographic/domain/0000" },
  operations: [...domainOperations, ...dynamicDataOperations, ...tableOperations, ...contentOperations, ...referenceOperations],
});

// The search endpoint requires `page` (the list endpoints default to page 1), so a first call asks for page 1.
const sendFirstPage = (operation) =>
  operation.name !== "search_content" ? operation : { ...operation, run: (context) => operation.run({ ...context, args: { ...context.args, cursor: context.args.cursor ?? "1" } }) };

export const pluginDefinition = { ...restDefinition, operations: restDefinition.operations.map(sendFirstPage) };
