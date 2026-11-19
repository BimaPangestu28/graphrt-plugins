/**
 * Decides whether a statement is read-only enough for an agent tool. This is defense in depth only: the tool role
 * (SNOWFLAKE_TOOL_ROLE, a separate least-privilege user) is the real boundary, see README "Safety".
 *
 * The SQL API reports no statement type before it runs a statement, so the text is lexed and checked against an
 * allowlist of statement forms:
 *   - lexing: comments (--, //, slash-star), 'strings' ('' and \ escapes), "quoted identifiers" ("" escapes) and
 *     $$strings$$. "$$" only opens a string at the start of a token, because "$" is an identifier character
 *     (`a$$` is an identifier, as in Snowflake). Anything unterminated is refused.
 *   - forms: SELECT ..., WITH ... (any CTE query), (SELECT ...), SHOW ..., DESCRIBE/DESC ..., and
 *     EXPLAIN [USING TEXT|JSON|TABULAR] followed by SELECT, WITH or "(".
 *   - refused anywhere: a second statement (";" before the end), the pipe operator `->>` (it chains statements),
 *     SYSTEM$ in any identifier, quoted or not, and keywords that write, run code or change the session
 *     (INSERT, UPDATE, DELETE, MERGE, CALL, EXECUTE, COPY, PUT, REMOVE, USE, COMMIT, ...).
 *   - table functions: TABLE(...) and LATERAL <name>(...) must name FLATTEN, GENERATOR, SPLIT_TO_TABLE,
 *     STRTOK_SPLIT_TO_TABLE or an INFORMATION_SCHEMA function. Other names may be stored procedures that write;
 *     RESULT_SCAN is refused because it reads results of queries other roles of the same user ran.
 */

const STATEMENT_KEYWORDS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"]);
const EXPLAINABLE_STARTS = new Set(["SELECT", "WITH"]);
const REFUSED_KEYWORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "CREATE", "ALTER", "DROP", "UNDROP", "COPY", "GRANT", "REVOKE",
  "CALL", "EXECUTE", "PUT", "REMOVE", "RM", "USE", "UNSET", "COMMIT", "ROLLBACK", "BEGIN",
]);
const BUILT_IN_TABLE_FUNCTIONS = new Set(["FLATTEN", "GENERATOR", "SPLIT_TO_TABLE", "STRTOK_SPLIT_TO_TABLE"]);
const MULTI_CHARACTER_OPERATORS = ["->>", "->", "::", "||", "<=", ">=", "<>", "!=", "=>"];
const WORD_PATTERN = /^[\p{L}_][\p{L}\p{N}_$]*/u;
const NUMBER_PATTERN = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;

/**
 * Classifies a statement.
 *
 * @param statement - SQL text (string)
 * @returns `{isReadOnly, reason}`; reason says why it is refused (object)
 *
 * @example
 * classifyStatement("SELECT * FROM orders").isReadOnly; // true
 */
export function classifyStatement(statement) {
  const tokens = tokenize(String(statement ?? ""));
  if (tokens === null) return refuse("it has an unterminated string, quoted identifier or comment");
  const body = tokens.at(-1)?.text === ";" && tokens.at(-1).type === "punct" ? tokens.slice(0, -1) : tokens;
  return checkTokens(body) ?? { isReadOnly: true, reason: null };
}

function refuse(reason) {
  return { isReadOnly: false, reason };
}

function checkTokens(tokens) {
  if (tokens.length === 0) return refuse("it is empty");
  for (let index = 0; index < tokens.length; index += 1) {
    const problem = checkToken(tokens, index);
    if (problem) return refuse(problem);
  }
  return checkStatementForm(tokens);
}

function checkToken(tokens, index) {
  const token = tokens[index];
  if (token.type === "punct" && token.text === ";") return "it contains more than one statement";
  if (token.type === "punct" && token.text === "->>") return "it uses the ->> operator, which chains statements";
  if ((token.type === "word" || token.type === "quoted") && token.text.toUpperCase().includes("SYSTEM$")) return "it calls a SYSTEM$ function";
  if (token.type === "word" && REFUSED_KEYWORDS.has(token.text.toUpperCase())) return `it contains ${token.text.toUpperCase()}`;
  if (isWord(token, "TABLE") && tokens[index + 1]?.text === "(") return checkTableFunction(tokens, index + 2);
  if (isWord(token, "LATERAL") && tokens[index + 1]?.type !== "punct") return checkTableFunction(tokens, index + 1);
  return null;
}

// tokens[start..] must be `name (` or `[db.]INFORMATION_SCHEMA.name (`.
function checkTableFunction(tokens, start) {
  const nameParts = [];
  let index = start;
  while (tokens[index]?.type === "word" || tokens[index]?.type === "quoted") {
    if (tokens[index].type === "quoted") return "it calls a table function by a quoted name";
    nameParts.push(tokens[index].text.toUpperCase());
    if (tokens[index + 1]?.text !== ".") break;
    index += 2;
  }
  if (tokens[index + 1]?.text !== "(" || nameParts.length === 0) return "it uses a table function that is not a known built-in";
  const functionName = nameParts.at(-1);
  const isBuiltIn = nameParts.length === 1 && BUILT_IN_TABLE_FUNCTIONS.has(functionName);
  const isInformationSchema = nameParts.length >= 2 && nameParts.at(-2) === "INFORMATION_SCHEMA";
  return isBuiltIn || isInformationSchema ? null : `TABLE(${nameParts.join(".")}) may be a stored procedure; only FLATTEN, GENERATOR, SPLIT_TO_TABLE, STRTOK_SPLIT_TO_TABLE and INFORMATION_SCHEMA functions are allowed`;
}

function checkStatementForm(tokens) {
  const firstWordIndex = tokens.findIndex((token) => token.text !== "(");
  const firstWord = tokens[firstWordIndex];
  if (firstWord?.type !== "word" || !STATEMENT_KEYWORDS.has(firstWord.text.toUpperCase())) {
    return refuse(`it starts with ${firstWord?.text ?? "nothing"}, not SELECT, WITH, SHOW, DESCRIBE or EXPLAIN`);
  }
  if (firstWordIndex > 0 && !EXPLAINABLE_STARTS.has(firstWord.text.toUpperCase())) return refuse("only a query may follow an opening parenthesis");
  if (firstWord.text.toUpperCase() !== "EXPLAIN") return null;
  const explainedIndex = isWord(tokens[firstWordIndex + 1], "USING") ? firstWordIndex + 3 : firstWordIndex + 1;
  const explained = tokens[explainedIndex];
  const isQuery = explained?.text === "(" || (explained?.type === "word" && EXPLAINABLE_STARTS.has(explained.text.toUpperCase()));
  return isQuery ? null : refuse("EXPLAIN is only allowed for queries");
}

function isWord(token, word) {
  return token?.type === "word" && token.text.toUpperCase() === word;
}

/**
 * Splits SQL into tokens; comments and whitespace are dropped.
 *
 * @param sql - SQL text (string)
 * @returns `[{type: "word" | "quoted" | "string" | "number" | "punct", text}]`, or null when something is unterminated (object[] | null)
 */
export function tokenize(sql) {
  const tokens = [];
  let position = 0;
  while (position < sql.length) {
    const next = readToken(sql, position);
    if (next === null) return null;
    if (next.token) tokens.push(next.token);
    position = next.end;
  }
  return tokens;
}

function readToken(sql, position) {
  const rest = sql.slice(position);
  if (/^\s/.test(rest)) return { end: position + 1 };
  if (rest.startsWith("--") || rest.startsWith("//")) return { end: endOfLine(sql, position) };
  if (rest.startsWith("/*")) return skipUntil(sql, position + 2, "*/", null);
  if (rest.startsWith("$$")) return skipUntil(sql, position + 2, "$$", "string");
  if (rest[0] === "'") return readQuoted(sql, position, "'", "string");
  if (rest[0] === '"') return readQuoted(sql, position, '"', "quoted");
  const word = WORD_PATTERN.exec(rest) ?? /^\$\d+/.exec(rest);
  if (word) return { token: { type: "word", text: word[0] }, end: position + word[0].length };
  const number = NUMBER_PATTERN.exec(rest);
  if (number) return { token: { type: "number", text: number[0] }, end: position + number[0].length };
  const operator = MULTI_CHARACTER_OPERATORS.find((candidate) => rest.startsWith(candidate)) ?? rest[0];
  return { token: { type: "punct", text: operator }, end: position + operator.length };
}

function endOfLine(sql, position) {
  const newline = sql.indexOf("\n", position);
  return newline === -1 ? sql.length : newline + 1;
}

function skipUntil(sql, from, terminator, tokenType) {
  const index = sql.indexOf(terminator, from);
  if (index === -1) return null;
  return { token: tokenType ? { type: tokenType, text: sql.slice(from, index) } : undefined, end: index + terminator.length };
}

// Quotes are escaped by doubling; inside 'strings' a backslash also escapes the next character.
function readQuoted(sql, position, quote, tokenType) {
  let text = "";
  for (let index = position + 1; index < sql.length; index += 1) {
    if (quote === "'" && sql[index] === "\\") {
      text += sql[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (sql[index] !== quote) {
      text += sql[index];
      continue;
    }
    if (sql[index + 1] === quote) {
      text += quote;
      index += 1;
      continue;
    }
    return { token: { type: tokenType, text }, end: index + 1 };
  }
  return null;
}
