/**
 * robots.txt parsing and matching per RFC 9309 (pure functions).
 *
 * - Groups start with one or more `user-agent` lines; the group(s) naming our
 *   product token apply, otherwise the `*` group(s). A user-agent value is
 *   reduced to its leading product name (`[a-z_-]`), compared case-insensitively,
 *   so `graphrt-web-browser/1.0` names us.
 * - The most specific (longest) matching rule wins; on a tie `allow` wins.
 * - `*` matches any characters, a trailing `$` anchors the end of the path.
 * - Percent-escapes of unreserved characters (`A-Z a-z 0-9 - . _ ~`) are decoded
 *   in rules and paths, so `/%7Ejoe` and `/~joe` are equal.
 * - `/robots.txt` itself is always allowed.
 *
 * robots.txt comes from untrusted servers, so matching work is bounded: runs of
 * `*` collapse to one, rules longer than 2 KB or with more than 32 `*` are
 * ignored, a group keeps at most 2,000 rules (10,000 in all), and one check may
 * spend at most MAX_MATCH_STEPS character comparisons. A check that runs out of
 * budget fails closed (disallowed).
 */
import { matchesWildcard } from "./wildcard.mjs";

const MAX_RULES = 10000;
export const MAX_RULES_PER_GROUP = 2000;
export const MAX_PATTERN_CHARS = 2048;
export const MAX_WILDCARDS_PER_RULE = 32;
export const MAX_MATCH_STEPS = 1000000;
const UNRESERVED_CHARACTER = /[A-Za-z0-9\-._~]/;

/**
 * Parses robots.txt content into groups.
 *
 * @param robotsText - File content (string)
 * @returns `[{agents: string[], rules: [{allow: boolean, pattern: string}]}]` (object[])
 *
 * @example
 * parseRobotsTxt("User-agent: *\nDisallow: /private");
 * // [{ agents: ["*"], rules: [{ allow: false, pattern: "/private" }] }]
 */
export function parseRobotsTxt(robotsText) {
  const groups = [];
  let currentGroup = null;
  let ruleCount = 0;
  for (const line of String(robotsText ?? "").replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const directive = parseDirective(line);
    if (!directive) continue;
    if (directive.key === "user-agent") {
      // A user-agent line after rules starts a new group; consecutive ones share a group.
      if (!currentGroup || currentGroup.rules.length > 0) {
        currentGroup = { agents: [], rules: [] };
        groups.push(currentGroup);
      }
      currentGroup.agents.push(extractProductName(directive.value));
    } else if ((directive.key === "allow" || directive.key === "disallow") && currentGroup && directive.value) {
      const pattern = normalizeRulePattern(directive.value);
      if (!pattern || ruleCount >= MAX_RULES || currentGroup.rules.length >= MAX_RULES_PER_GROUP) continue;
      currentGroup.rules.push({ allow: directive.key === "allow", pattern });
      ruleCount += 1;
    }
  }
  return groups;
}

/**
 * Picks the rules that apply to a crawler.
 *
 * @param groups - From parseRobotsTxt (object[])
 * @param productToken - Our robots product token, e.g. "graphrt-web-browser" (string)
 * @returns Rules of the matching groups (object[])
 */
export function selectRules(groups, productToken) {
  const token = productToken.toLowerCase();
  const namedGroups = groups.filter((group) => group.agents.includes(token));
  const applicableGroups = namedGroups.length > 0 ? namedGroups : groups.filter((group) => group.agents.includes("*"));
  return applicableGroups.flatMap((group) => group.rules);
}

/**
 * Decides whether a path may be crawled.
 *
 * @param rules - From selectRules (object[])
 * @param pathWithQuery - URL path plus query, e.g. "/a/b?c=1" (string)
 * @returns true when allowed (boolean)
 *
 * @example
 * isPathAllowed([{ allow: false, pattern: "/" }, { allow: true, pattern: "/public$" }], "/public"); // true
 */
export function isPathAllowed(rules, pathWithQuery) {
  const path = normalizePercentEncoding(pathWithQuery || "/");
  if (path === "/robots.txt") return true;
  const budget = { remainingSteps: MAX_MATCH_STEPS, exhausted: false };
  let bestRule = null;
  for (const rule of rules) {
    const isMatch = matchesRule(rule.pattern, path, budget);
    if (budget.exhausted) return false;
    if (!isMatch) continue;
    const isMoreSpecific = !bestRule || rule.pattern.length > bestRule.pattern.length;
    const winsTie = bestRule && rule.pattern.length === bestRule.pattern.length && rule.allow;
    if (isMoreSpecific || winsTie) bestRule = rule;
  }
  return bestRule ? bestRule.allow : true;
}

function matchesRule(pattern, path, budget) {
  // Rules match path prefixes unless they end with `$`.
  const isAnchored = pattern.endsWith("$");
  const body = isAnchored ? pattern.slice(0, -1) : pattern;
  if (!body.includes("*")) {
    budget.remainingSteps -= body.length;
    budget.exhausted = budget.remainingSteps < 0;
    return isAnchored ? path === body : path.startsWith(body);
  }
  return matchesWildcard(isAnchored ? body : `${body}*`, path, budget);
}

/**
 * Normalises a rule value, or returns null for a rule that is ignored (too long, too many `*`).
 *
 * @param value - Raw `allow`/`disallow` value (string)
 * @returns Pattern (string | null)
 */
function normalizeRulePattern(value) {
  // Escapes can only shrink a value by decoding, so anything 3x over the cap is too long either way.
  if (value.length > MAX_PATTERN_CHARS * 3) return null;
  const pattern = normalizePercentEncoding(value).replace(/\*{2,}/g, "*");
  if (pattern.length > MAX_PATTERN_CHARS) return null;
  let wildcardCount = 0;
  for (const character of pattern) if (character === "*") wildcardCount += 1;
  return wildcardCount > MAX_WILDCARDS_PER_RULE ? null : pattern;
}

// RFC 9309: the user-agent value is a product token; keep its leading name, e.g. "Foo-Bot/2.1" -> "foo-bot".
function extractProductName(userAgentValue) {
  const lowerCased = userAgentValue.toLowerCase();
  if (lowerCased.startsWith("*")) return "*";
  return /^[a-z_-]*/.exec(lowerCased)[0];
}

function parseDirective(line) {
  const content = line.replace(/#.*$/, "").trim();
  const separatorIndex = content.indexOf(":");
  if (separatorIndex <= 0) return null;
  return { key: content.slice(0, separatorIndex).trim().toLowerCase(), value: content.slice(separatorIndex + 1).trim() };
}

// Percent-encodes non-ASCII characters, decodes escaped unreserved characters and upper-cases the
// remaining escapes, so "/ä" and "/%c3%a4", or "/~joe" and "/%7Ejoe", compare equal.
function normalizePercentEncoding(value) {
  return value.replace(/[^\x00-\x7F]+/g, (characters) => encodeURIComponent(characters)).replace(/%([0-9a-f]{2})/gi, (escape, hexDigits) => {
    const character = String.fromCharCode(Number.parseInt(hexDigits, 16));
    return UNRESERVED_CHARACTER.test(character) ? character : escape.toUpperCase();
  });
}
