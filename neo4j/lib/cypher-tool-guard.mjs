/**
 * Agent-tool guard for Cypher statements. Read queries are sent with `accessMode: "Read"`, but the Query API documents
 * that field for routing (cluster readers), not as a guaranteed write barrier on a single server, so the real
 * protection is this guard plus a database user with a read-only role. Even a read transaction can have side effects:
 * LOAD CSV and APOC procedures fetch URLs and read or write files, `genai.*` calls paid embedding APIs, `dbms.*`
 * procedures change configuration or kill queries, TERMINATE TRANSACTIONS stops other users' work, SHOW TRANSACTIONS
 * or SETTINGS reveal other users' queries and configuration, and USE switches to another database.
 *
 * So for agent tools a statement is scanned after removing comments and string literals, unquoting backtick names
 * (as " name ", so `apoc`.`load` is seen as apoc . load and USE`system` as USE system) and turning every character
 * outside printable ASCII into a space (Cypher whitespace includes U+001C..U+001F and U+0085, which JS \s misses).
 * It is refused when it:
 *   - uses LOAD CSV, USE or TERMINATE, or a backslash outside string literals (escape sequences in names);
 *   - (read-only operations) uses a write clause: CREATE, INSERT, MERGE, SET, DELETE, DETACH, REMOVE, FOREACH, DROP, ALTER,
 *     GRANT, DENY, REVOKE, RENAME, START/STOP DATABASE, IN TRANSACTIONS;
 *   - uses SHOW for anything but indexes, constraints, functions and procedures;
 *   - calls a namespaced function or procedure (`ns.name(` or `CALL ns.name`) outside a small allowlist of read-only
 *     built-ins, plus NEO4J_TOOL_ALLOWED_PROCEDURES (names, or prefixes ending in `.` or `*`).
 * Keywords are matched only in keyword positions: not after `.`, `$` or `:` (labels and relationship types), not right
 * after the AS keyword (aliases), not before `:` (map keys, `(var:Label)`), and never inside backticks. A variable
 * named like a keyword is still refused where it is used (`MATCH (set) RETURN set`); quote it in backticks.
 * This is defense in depth, not a parser: run the plugin as a Neo4j user with only the privileges agents need.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const ALLOWED_PROCEDURES_ENV = "NEO4J_TOOL_ALLOWED_PROCEDURES";

// Exact procedure/function names (lowercase) agents may call.
const SAFE_NAMES = new Set([
  "db.labels",
  "db.relationshiptypes",
  "db.propertykeys",
  "db.schema.visualization",
  "db.schema.nodetypeproperties",
  "db.schema.reltypeproperties",
  "db.index.fulltext.querynodes",
  "db.index.fulltext.queryrelationships",
  "db.index.vector.querynodes",
  "db.index.vector.queryrelationships",
  "db.info",
  "db.ping",
  "dbms.components",
]);
// Built-in function namespaces (temporal, spatial, vector math): pure functions.
const SAFE_PREFIXES = ["point.", "date.", "datetime.", "localdatetime.", "localtime.", "time.", "duration.", "vector."];
const SHOW_ALLOWED =
  /\bSHOW\s+(?:(?:ALL|RANGE|TEXT|POINT|LOOKUP|FULLTEXT|VECTOR|UNIQUE|UNIQUENESS|EXIST|EXISTENCE|NODE|RELATIONSHIP|REL|KEY|PROPERTY|TYPE|BUILT\s+IN|USER\s+DEFINED|EXECUTABLE(?:\s+BY\s+\w+)?)\s+)*(?:INDEX|INDEXES|CONSTRAINT|CONSTRAINTS|FUNCTION|FUNCTIONS|PROCEDURE|PROCEDURES)\b/gi;
// A keyword, not a property (`n.use`), parameter (`$use`), map key (`{use: 1}`), variable with a label (`(use:X)`),
// label or relationship type (`:Create`, `[:DELETE]`; Cypher always reads the name after `:` as one) or alias
// (`AS remove`; the name after the AS keyword is always the alias). Backtick names never count as keywords: the
// keyword scan sees them as `_` (so `AS \`as\` CREATE` still finds CREATE).
const keyword = (words) => new RegExp(`(?<![\\w.$])(?<!:\\s*)(?<!(?<![\\w.$])AS\\s+)(?:${words})\\b(?!\\s*:)`, "i");
const FORBIDDEN_CLAUSES = [
  { pattern: /\bLOAD\s+CSV\b/i, label: "LOAD CSV" },
  { pattern: keyword("USE"), label: "USE" },
  { pattern: keyword("TERMINATE"), label: "TERMINATE" },
];
// Checked on the unquoted text: a backslash inside a backtick name is an escape sequence too.
const BACKSLASH = /\\/;
const WRITE_CLAUSE = keyword("CREATE|INSERT|MERGE|SET|DELETE|DETACH|REMOVE|FOREACH|DROP|ALTER|GRANT|DENY|REVOKE|RENAME|(?:START|STOP)\\s+DATABASE|IN\\s+TRANSACTIONS");
// Ends a // comment: Cypher ends it at \r or \n; ending it early at other line separators only scans more text.
const LINE_TERMINATORS = /[\r\n\u0085\u2028\u2029]/;
const NON_PRINTABLE_ASCII = /[^\x20-\x7E\r\n]/g;
const SHOW_KEYWORD = keyword("SHOW");
/** What the keyword scan sees instead of a backtick name: an identifier that is no keyword. */
const BACKTICK_PLACEHOLDER = "_";
const NAME = "[A-Za-z_][\\w]*";
const QUALIFIED_CALL = new RegExp(`(${NAME}(?:\\s*\\.\\s*${NAME})+)\\s*\\(`, "g");
const CALL_CLAUSE = new RegExp(`\\bCALL\\s+(${NAME}(?:\\s*\\.\\s*${NAME})*)`, "gi");

/**
 * Removes comments and string literals, unquotes backtick names as " name " and turns every character outside
 * printable ASCII (and \r, \n) into a space, so keywords can be matched safely.
 *
 * @param statement - Cypher statement (string)
 * @param options - `{backtickNames}`: "unquote" (default, for procedure names) or "placeholder" (every backtick
 *   name becomes `_`, for keyword matching: a backtick name is never a keyword) (object, optional)
 * @returns Statement with strings as '' and comments as spaces (string)
 *
 * @example
 * stripCypherNoise("MATCH (n) // CALL apoc.x()\nRETURN 'LOAD CSV', `a`.b"); // "MATCH (n)  \nRETURN '',  a .b"
 * stripCypherNoise("RETURN 1 AS `create`", { backtickNames: "placeholder" }); // "RETURN 1 AS  _ "
 */
export function stripCypherNoise(statement, { backtickNames = "unquote" } = {}) {
  return removeCommentsAndStrings(statement, backtickNames === "placeholder").replace(NON_PRINTABLE_ASCII, " ");
}

function removeCommentsAndStrings(statement, usePlaceholder) {
  let output = "";
  let index = 0;
  while (index < statement.length) {
    const character = statement[index];
    const nextCharacter = statement[index + 1];
    if (character === "/" && nextCharacter === "/") {
      index = skipLineComment(statement, index);
      output += " ";
    } else if (character === "/" && nextCharacter === "*") {
      const end = statement.indexOf("*/", index + 2);
      index = end === -1 ? statement.length : end + 2;
      output += " ";
    } else if (character === "'" || character === '"') {
      index = skipString(statement, index, character);
      output += "''";
    } else if (character === "`") {
      const { text, nextIndex } = readBacktickName(statement, index);
      // A space on both sides keeps the name off a keyword (USE`system`); right after a dot it is a property.
      output += `${output.endsWith(".") ? "" : " "}${usePlaceholder ? BACKTICK_PLACEHOLDER : text} `;
      index = nextIndex;
    } else {
      output += character;
      index += 1;
    }
  }
  return output;
}

function skipLineComment(text, startIndex) {
  const end = text.slice(startIndex).search(LINE_TERMINATORS);
  return end === -1 ? text.length : startIndex + end;
}

function skipString(text, startIndex, quote) {
  let index = startIndex + 1;
  while (index < text.length) {
    if (text[index] === "\\") index += 2;
    else if (text[index] === quote) return index + 1;
    else index += 1;
  }
  return text.length;
}

// `` inside a backtick name is an escaped backtick.
function readBacktickName(text, startIndex) {
  let name = "";
  let index = startIndex + 1;
  while (index < text.length) {
    if (text[index] === "`" && text[index + 1] === "`") {
      name += "`";
      index += 2;
    } else if (text[index] === "`") {
      return { text: name, nextIndex: index + 1 };
    } else {
      name += text[index];
      index += 1;
    }
  }
  return { text: name, nextIndex: text.length };
}

/**
 * Lists the reasons a statement is refused for agent tools (empty when allowed).
 *
 * @param statement - Cypher statement (string)
 * @param allowedText - NEO4J_TOOL_ALLOWED_PROCEDURES value (string, optional)
 * @param options - `{readOnly}`: also refuse write clauses (object, optional)
 * @returns Problems, e.g. ["calls apoc.load.json"] (string[])
 *
 * @example
 * findToolStatementProblems("CALL apoc.load.json('https://x')"); // ["calls apoc.load.json"]
 */
export function findToolStatementProblems(statement, allowedText, { readOnly = false } = {}) {
  const cleaned = stripCypherNoise(String(statement));
  const keywordText = stripCypherNoise(String(statement), { backtickNames: "placeholder" });
  const problems = FORBIDDEN_CLAUSES.filter(({ pattern }) => pattern.test(keywordText)).map(({ label }) => `uses ${label}`);
  if (BACKSLASH.test(cleaned)) problems.push("uses a backslash outside string literals");
  if (readOnly && WRITE_CLAUSE.test(keywordText)) problems.push("uses a write clause (use run_write_query)");
  const withoutAllowedShow = keywordText.replace(SHOW_ALLOWED, " ");
  if (SHOW_KEYWORD.test(withoutAllowedShow)) problems.push("uses SHOW (only indexes, constraints, functions and procedures)");
  const extraAllowed = parseAllowedNames(allowedText);
  for (const calledName of listCalledNames(cleaned)) {
    if (!isAllowedName(calledName, extraAllowed)) problems.push(`calls ${calledName}`);
  }
  return [...new Set(problems)];
}

function listCalledNames(cleaned) {
  const normalize = (rawName) => rawName.replace(/\s+/g, "").toLowerCase();
  const functionNames = [...cleaned.matchAll(QUALIFIED_CALL)].map((match) => normalize(match[1]));
  const procedureNames = [...cleaned.matchAll(CALL_CLAUSE)].map((match) => normalize(match[1]));
  return [...functionNames, ...procedureNames];
}

function parseAllowedNames(allowedText) {
  return String(allowedText ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedName(calledName, extraAllowed) {
  if (SAFE_NAMES.has(calledName) || SAFE_PREFIXES.some((prefix) => calledName.startsWith(prefix))) return true;
  return extraAllowed.some((entry) => {
    if (entry.endsWith("*")) return calledName.startsWith(entry.slice(0, -1));
    if (entry.endsWith(".")) return calledName.startsWith(entry);
    return calledName === entry;
  });
}

/**
 * Returns the definition with tool calls of the given operations refused when their statement fails the guard.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationNames - `{read, write}`: operations whose `statement` argument is checked; `read` ones also refuse
 *   write clauses (object of string[])
 * @returns A new definition (object)
 */
export function guardToolStatements(pluginDefinition, { read = [], write = [] }) {
  const readOnlyNames = new Set(read);
  const guarded = new Set([...read, ...write]);
  const wrapOperation = (operation) => {
    if (!guarded.has(operation.name)) return operation;
    const readOnly = readOnlyNames.has(operation.name);
    const run = (context) => {
      if (context.source === "tool") assertToolStatementAllowed(context, operation.name, readOnly);
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

function assertToolStatementAllowed({ args, environment }, operationName, readOnly) {
  if (typeof args?.statement !== "string") return;
  const problems = findToolStatementProblems(args.statement, environment?.[ALLOWED_PROCEDURES_ENV], { readOnly });
  if (problems.length === 0) return;
  throw new PluginError(
    `\`${operationName}\` as an agent tool refuses this statement: it ${problems.join(", ")}. ` +
      `Allow read-only procedures with ${ALLOWED_PROCEDURES_ENV}, or use a workflow node`,
    { kind: "permission_denied" },
  );
}
