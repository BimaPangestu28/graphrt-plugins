/**
 * Checks on the statement SQLite actually compiled (`StatementSync.sourceSQL`).
 *
 * They are not what keeps reads read-only (the read-only connection does
 * that); they keep calls inside the file allowlist and make multi-statement
 * input fail loudly:
 * - SQLite's prepare compiles only the first statement and silently ignores
 *   the rest, so any non-comment text after it is refused.
 * - `ATTACH` would open another file (even on a read-only connection), and
 *   `VACUUM INTO` writes a new file anywhere. node:sqlite (Node 22/24) has no
 *   authorizer and no `sqlite3_limit`, so two independent layers refuse them:
 *   a token scanner that skips empty statements, comments, strings and quoted
 *   names, and a check of the compiled bytecode (`EXPLAIN`), which looks for
 *   the `sqlite_attach` function and a `Vacuum` opcode with an INTO target.
 */
import { invalidInput, permissionDenied } from "./errors.mjs";

const QUOTE_ENDINGS = { "'": "'", '"': '"', "`": "`", "[": "]" };
const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_$]/;

/**
 * Removes SQL comments (`-- ...` and `/* ... *\/`) outside string literals and quoted identifiers.
 *
 * @param sqlText - SQL text (string)
 * @returns The text with every comment replaced by one space (string)
 *
 * @example
 * stripSqlComments("/* hi *\/ SELECT '--x' -- tail"); // "  SELECT '--x'  "
 */
export function stripSqlComments(sqlText) {
  let output = "";
  let index = 0;
  while (index < sqlText.length) {
    const skipEnd = findCommentEnd(sqlText, index);
    if (skipEnd !== null) {
      output += " ";
      index = skipEnd;
      continue;
    }
    const quoteEnd = findQuoteEnd(sqlText, index);
    const nextIndex = quoteEnd ?? index + 1;
    output += sqlText.slice(index, nextIndex);
    index = nextIndex;
  }
  return output;
}

/**
 * Scans the first non-empty statement: its bare (unquoted) words, upper-cased, and where it starts.
 * Empty statements (`;`), whitespace, comments, string literals and quoted identifiers are skipped.
 *
 * @param sqlText - SQL text (string)
 * @returns `{keywords, startOffset}`; startOffset is -1 when there is no statement (object)
 *
 * @example
 * scanFirstStatement(";; /* c *\/ attach 'b.db' AS b"); // { keywords: ["ATTACH", "AS", "B"], startOffset: 11 }
 */
export function scanFirstStatement(sqlText) {
  const keywords = [];
  let startOffset = -1;
  let index = 0;
  while (index < sqlText.length) {
    const character = sqlText[index];
    const commentEnd = findCommentEnd(sqlText, index);
    if (commentEnd !== null || /\s/.test(character)) {
      index = commentEnd ?? index + 1;
      continue;
    }
    if (character === ";") {
      if (startOffset !== -1) break;
      index += 1;
      continue;
    }
    if (startOffset === -1) startOffset = index;
    index = consumeToken(sqlText, index, keywords);
  }
  return { keywords, startOffset };
}

/**
 * Refuses input with more than one statement.
 *
 * @param fullSql - The SQL the caller passed (string)
 * @param compiledSql - `sourceSQL` of the prepared statement, or undefined on Node versions without it (string | undefined)
 * @throws PluginError kind `invalid_input` - When text other than comments, spaces and `;` follows the first statement
 */
export function assertSingleStatement(fullSql, compiledSql) {
  if (typeof compiledSql !== "string") return;
  const compiledStart = fullSql.indexOf(compiledSql);
  const remainder = compiledStart === -1 ? "" : fullSql.slice(compiledStart + compiledSql.length);
  if (/^[\s;]*$/.test(stripSqlComments(remainder))) return;
  throw invalidInput("Only one SQL statement per call: SQLite would silently skip everything after the first one");
}

/**
 * Token-level layer: refuses statements whose first word is ATTACH, or VACUUM with an INTO.
 *
 * @param sqlText - The statement's SQL (string)
 * @throws PluginError kind `permission_denied` - For ATTACH and VACUUM ... INTO
 */
export function assertNoOtherFiles(sqlText) {
  const { keywords } = scanFirstStatement(sqlText);
  if (keywords[0] === "ATTACH") throw attachRefused();
  if (keywords[0] === "VACUUM" && keywords.includes("INTO")) throw vacuumIntoRefused();
}

/**
 * Bytecode layer: compiles `EXPLAIN <statement>` and refuses programs that attach a file or VACUUM INTO one.
 * Statements that already are EXPLAIN are not run, so they are allowed. If the program cannot be inspected,
 * the statement is refused.
 *
 * @param database - Open DatabaseSync (object)
 * @param sqlText - The statement's SQL (string)
 * @throws PluginError kind `permission_denied` - For ATTACH, VACUUM INTO, or a program that cannot be inspected
 */
export function assertCompiledProgramTouchesNoOtherFiles(database, sqlText) {
  const { keywords, startOffset } = scanFirstStatement(sqlText);
  if (startOffset === -1 || keywords[0] === "EXPLAIN") return;
  let programRows;
  try {
    programRows = database.prepare(`EXPLAIN ${sqlText.slice(startOffset)}`).all();
  } catch (explainError) {
    throw permissionDenied(`The statement was refused because its program could not be checked for file access: ${explainError.message}`);
  }
  for (const programRow of programRows) {
    if (/^sqlite_attach\b/.test(String(programRow.p4 ?? ""))) throw attachRefused();
    if (programRow.opcode === "Vacuum" && Number(programRow.p2) !== 0) throw vacuumIntoRefused();
  }
}

function attachRefused() {
  return permissionDenied("ATTACH is not allowed: it would open a file outside SQLITE_ALLOWED_DIRS");
}

function vacuumIntoRefused() {
  return permissionDenied("VACUUM INTO is not allowed: it would write a file outside SQLITE_ALLOWED_DIRS");
}

// Index just past a comment starting at `index`, or null when no comment starts there.
function findCommentEnd(sqlText, index) {
  if (sqlText.startsWith("--", index)) {
    const lineEnd = sqlText.indexOf("\n", index);
    return lineEnd === -1 ? sqlText.length : lineEnd;
  }
  if (sqlText.startsWith("/*", index)) {
    const commentEnd = sqlText.indexOf("*/", index + 2);
    return commentEnd === -1 ? sqlText.length : commentEnd + 2;
  }
  return null;
}

// Index just past a quoted literal or identifier starting at `index` (doubled quotes stay inside), or null.
function findQuoteEnd(sqlText, index) {
  const quoteEnd = QUOTE_ENDINGS[sqlText[index]];
  if (!quoteEnd) return null;
  let searchFrom = index + 1;
  for (;;) {
    const closingIndex = sqlText.indexOf(quoteEnd, searchFrom);
    if (closingIndex === -1) return sqlText.length;
    if (quoteEnd !== "]" && sqlText[closingIndex + 1] === quoteEnd) {
      searchFrom = closingIndex + 2;
      continue;
    }
    return closingIndex + 1;
  }
}

// Consumes one token; bare words are recorded upper-cased. Returns the index after it.
function consumeToken(sqlText, index, keywords) {
  const quoteEnd = findQuoteEnd(sqlText, index);
  if (quoteEnd !== null) return quoteEnd;
  if (!WORD_START.test(sqlText[index])) return index + 1;
  let wordEnd = index + 1;
  while (wordEnd < sqlText.length && WORD_PART.test(sqlText[wordEnd])) wordEnd += 1;
  keywords.push(sqlText.slice(index, wordEnd).toUpperCase());
  return wordEnd;
}
