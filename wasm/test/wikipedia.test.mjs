/**
 * wikipedia: the Node.js plugin and its WebAssembly build (wasm/wikipedia) agree on every case.
 */
import { fileURLToPath } from "node:url";
import * as operationsModule from "../../wikipedia/lib/shared/operations.mjs";
import { pluginDefinition } from "../../wikipedia/definition.mjs";
import { defineParitySuite } from "./rest-parity.mjs";

const SEARCH = { batchcomplete: true, continue: { sroffset: 10 }, query: { searchinfo: { totalhits: 25 }, search: Array.from({ length: 10 }, (_, index) => ({ ns: 0, title: `Borobudur ${index}`, pageid: index, snippet: "<span class=\"searchmatch\">Borobudur</span>" })) } };
const PAGE = { batchcomplete: true, query: { pages: [{ pageid: 4, ns: 0, title: "Borobudur", extract: "Borobudur is a 9th-century Mahayana Buddhist temple.\n\n== History ==\nBuilt by the Sailendra dynasty. 🙂 Ünïcödé" }] } };
const LANGLINKS = { continue: { llcontinue: "4|de", continue: "||" }, query: { pages: [{ pageid: 4, title: "Borobudur", langlinks: [{ lang: "ar", url: "https://ar.wikipedia.org/wiki/x", title: "بوروبودور" }] }] } };

const CASES = [
  { name: "search", operation: "search_pages", args: { query: "Borobudur temple" }, responses: [{ body: SEARCH }] },
  { name: "search, second page", operation: "search_pages", args: { query: "Borobudur", cursor: "10", limit: 10 }, responses: [{ body: { query: { searchinfo: { totalhits: 25 }, search: SEARCH.query.search.slice(0, 5) } } }] },
  { name: "search, last page", operation: "search_pages", args: { query: "Borobudur", cursor: 20, limit: "10" }, responses: [{ body: { query: { searchinfo: { totalhits: 25 }, search: SEARCH.query.search.slice(0, 5) } } }] },
  { name: "search, bad cursor", operation: "search_pages", args: { query: "x", cursor: "abc" }, kind: "invalid_input", message: /cursor/ },
  { name: "search in Indonesian", operation: "search_pages", args: { query: "candi", language: "id" }, responses: [{ body: SEARCH }] },
  { name: "WIKIPEDIA_LANGUAGE sets the default wiki", operation: "search_pages", args: { query: "candi" }, env: { WIKIPEDIA_LANGUAGE: " zh-min-nan " }, responses: [{ body: SEARCH }] },
  { name: "bad WIKIPEDIA_LANGUAGE", operation: "search_pages", args: { query: "candi" }, env: { WIKIPEDIA_LANGUAGE: "evil.com/" }, kind: "invalid_input", message: /Invalid API base URL configuration/ },
  { name: "bad language argument", operation: "get_page_summary", args: { page_title: "X", language: "en.evil.com" }, kind: "invalid_input", message: /Invalid Wikipedia language/ },
  { name: "language must be a string", operation: "get_page_summary", args: { page_title: "X", language: 5 }, kind: "invalid_input" },
  { name: "action API error in a 200 body", operation: "search_pages", args: { query: "x", limit: 5 }, responses: [{ body: { error: { code: "badvalue", info: "Unrecognized value for parameter \"list\"." } } }], kind: "invalid_input", message: /badvalue/ },
  { name: "maxlag is retryable", operation: "search_pages", args: { query: "x" }, responses: Array.from({ length: 3 }, () => ({ body: { error: { code: "maxlag", info: "Waiting for a database server: 5 seconds lagged." } } })), kind: "rate_limited", rateLimited: true },
  { name: "page summary", operation: "get_page_summary", args: { page_title: "Candi Borobudur/Prambanan & ? #" }, responses: [{ body: { title: "Borobudur", extract: "A temple", coordinates: { lat: -7.6079, lon: 110.2038 } } }] },
  { name: "page summary not found (REST)", operation: "get_page_summary", args: { page_title: "Nope" }, responses: [{ status: 404, body: { type: "https://mediawiki.org/wiki/HyperSwitch/errors/not_found", title: "Not found.", detail: "Page or revision not found." } }], kind: "not_found" },
  { name: "page content capped", operation: "get_page_content", args: { page_title: "Borobudur", max_chars: 60 }, responses: [{ body: PAGE }] },
  { name: "page content, intro only", operation: "get_page_content", args: { page_title: "Borobudur", intro_only: "true" }, responses: [{ body: PAGE }] },
  { name: "page content, intro_only false is not sent", operation: "get_page_content", args: { page_title: "Borobudur", intro_only: false }, responses: [{ body: PAGE }] },
  { name: "page content of a missing page", operation: "get_page_content", args: { page_title: "Nope" }, responses: [{ body: { query: { pages: [{ ns: 0, title: "Nope", missing: true }] } } }], kind: "not_found", message: /no page "Nope"/ },
  { name: "page content of an invalid title", operation: "get_page_content", args: { page_title: "<>" }, responses: [{ body: { query: { pages: [{ title: "<>", invalidreason: "The requested page title contains invalid characters: \"<\".", invalid: true }] } } }], kind: "not_found" },
  { name: "page content without pages", operation: "get_page_content", args: { page_title: "X" }, responses: [{ body: { batchcomplete: true } }], kind: "not_found" },
  { name: "media list", operation: "get_page_media", args: { page_title: "Borobudur", language: "de" }, responses: [{ body: { items: [{ title: "File:Borobudur.jpg", type: "image" }] } }] },
  { name: "nearby pages", operation: "search_nearby_pages", args: { coordinates: "-7.6079|110.2038", radius_meters: 500 }, responses: [{ body: { query: { geosearch: [{ title: "Borobudur", dist: 12.5 }] } } }] },
  { name: "nearby radius too large", operation: "search_nearby_pages", args: { coordinates: "0|0", radius_meters: 20000 }, kind: "invalid_input" },
  { name: "languages with a continuation cursor", operation: "get_page_languages", args: { page_title: "Borobudur", limit: 1 }, responses: [{ body: LANGLINKS }] },
  { name: "languages, following the cursor", operation: "get_page_languages", args: { page_title: "Borobudur", cursor: "4|de" }, responses: [{ body: { query: { pages: [{ title: "Borobudur", langlinks: [] }] } } }] },
  { name: "api_request on the default wiki", operation: "api_request", args: { path: "/w/api.php", query: { action: "query", list: "random", format: "json" } }, responses: [{ body: { query: { random: [] } } }] },
];

defineParitySuite({
  pluginName: "wikipedia",
  pluginDefinition,
  operationsModule,
  wasmPath: fileURLToPath(new URL("../wikipedia/wikipedia.wasm", import.meta.url)),
  cases: CASES,
});
