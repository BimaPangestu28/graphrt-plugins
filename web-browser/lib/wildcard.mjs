/**
 * Linear-backtracking wildcard matching (`*` = any run of characters).
 *
 * Used for robots.txt rules and for `get_links` patterns. Patterns come from
 * untrusted sources, so this deliberately avoids building regular expressions
 * (a pattern such as `*a*a*a*a*b` can make a regex backtrack exponentially).
 * Worst case is O(pattern length × text length); callers that match untrusted
 * patterns pass a step budget to bound it.
 */

/**
 * Tells whether the whole `text` matches `pattern`, where `*` matches any run of characters.
 *
 * @param pattern - Pattern with `*` wildcards; every other character is literal (string)
 * @param text - Text to test (string)
 * @param budget - `{remainingSteps, exhausted}`; each comparison costs one step. When it runs out,
 *   `exhausted` is set and the result is false (object, optional)
 * @returns true when the pattern covers the entire text (boolean)
 *
 * @example
 * matchesWildcard("https://*.example.com/*", "https://www.example.com/a"); // true
 * matchesWildcard("/private", "/private/x"); // false (no implicit trailing *)
 */
export function matchesWildcard(pattern, text, budget = { remainingSteps: Infinity, exhausted: false }) {
  let patternIndex = 0;
  let textIndex = 0;
  let starPatternIndex = -1;
  let starTextIndex = 0;
  while (textIndex < text.length) {
    budget.remainingSteps -= 1;
    if (budget.remainingSteps < 0) {
      budget.exhausted = true;
      return false;
    }
    if (patternIndex < pattern.length && pattern[patternIndex] !== "*" && pattern[patternIndex] === text[textIndex]) {
      patternIndex += 1;
      textIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      starPatternIndex = patternIndex;
      starTextIndex = textIndex;
      patternIndex += 1;
    } else if (starPatternIndex !== -1) {
      patternIndex = starPatternIndex + 1;
      starTextIndex += 1;
      textIndex = starTextIndex;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}
