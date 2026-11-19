/**
 * Finds the first keyword of a MySQL statement, the way the server reads it.
 *
 * This does not decide what is a write (the read-only session does that). It
 * exists for one statement type the read-only session cannot contain: a stored
 * procedure may COMMIT and start its own READ WRITE transaction, so `query`
 * refuses CALL for agents. The scanner skips whitespace, empty statements
 * (`;`), `#` and `-- ` comments and `/* *\/` comments, but treats the content of
 * MySQL executable comments (`/*! ... *\/`, `/*!50000 ... *\/`) as code, because
 * the server runs it.
 */

const WORD_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*/;

/**
 * Returns the first keyword of the first non-empty statement, upper-cased.
 *
 * @param sqlText - SQL text (string)
 * @returns The keyword, or null when the statement starts with something else (operator, quote) or is empty (string | null)
 *
 * @example
 * firstStatementKeyword("/*!50000 CALL p() *\/"); // "CALL"
 */
export function firstStatementKeyword(sqlText) {
  let index = 0;
  while (index < sqlText.length) {
    const skippedTo = skipNonCode(sqlText, index);
    if (skippedTo !== index) {
      index = skippedTo;
      continue;
    }
    const word = WORD_PATTERN.exec(sqlText.slice(index));
    return word ? word[0].toUpperCase() : null;
  }
  return null;
}

// Skips one run of whitespace, `;`, a comment, or the opening/closing marks of an executable comment.
function skipNonCode(sqlText, index) {
  const character = sqlText[index];
  if (/\s/.test(character) || character === ";") return index + 1;
  if (character === "#") return endOfLine(sqlText, index);
  if (sqlText.startsWith("--", index) && (index + 2 >= sqlText.length || /\s/.test(sqlText[index + 2]))) return endOfLine(sqlText, index);
  if (sqlText.startsWith("/*!", index)) return skipVersionDigits(sqlText, index + 3);
  if (sqlText.startsWith("*/", index)) return index + 2;
  if (sqlText.startsWith("/*", index)) {
    const commentEnd = sqlText.indexOf("*/", index + 2);
    return commentEnd === -1 ? sqlText.length : commentEnd + 2;
  }
  return index;
}

function endOfLine(sqlText, index) {
  const lineEnd = sqlText.indexOf("\n", index);
  return lineEnd === -1 ? sqlText.length : lineEnd + 1;
}

// `/*!50000 CALL ...` → the code starts after the optional 5 or 6 digit version.
function skipVersionDigits(sqlText, index) {
  const versionMatch = /^\d{5,6}/.exec(sqlText.slice(index, index + 6));
  return versionMatch ? index + versionMatch[0].length : index;
}
