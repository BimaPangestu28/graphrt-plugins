/**
 * Readable text, markdown and links from a DOM snapshot (pure functions).
 *
 * A snapshot node is either a text string or `{tag, attrs, children}` as built
 * by `snapshotDocumentInPage` (scripts, styles, media and hidden elements are
 * already gone).
 *
 * Main-content heuristic (`selectMainContent`):
 * 1. the `<main>` / `[role=main]` element with the most text;
 * 2. otherwise the `<article>` with the most text, when it holds at least half
 *    of all article text (a feed of many small articles falls through);
 * 3. otherwise `<body>`. A candidate with very little text also falls back to body.
 * Boilerplate (nav, footer, aside, forms, buttons, dialogs, site headers, and
 * landmarks/classes such as navigation, banner, cookie, sidebar, advert) is
 * then removed from the chosen element.
 */

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li",
  "main", "nav", "ol", "p", "pre", "section", "summary", "table", "ul", "caption",
]);
const PARAGRAPH_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "ul", "ol", "table", "hr", "figure", "dl", "section", "article", "main", "details"]);
const BOILERPLATE_TAGS = new Set(["nav", "footer", "aside", "form", "button", "dialog", "menu"]);
const BOILERPLATE_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "dialog", "alertdialog", "menu", "menubar"]);
const BOILERPLATE_NAME_TOKENS = new Set([
  "cookie", "cookies", "consent", "sidebar", "advert", "advertisement", "ads", "promo", "newsletter", "breadcrumb",
  "breadcrumbs", "share", "sharing", "social", "popup", "modal", "subscribe",
]);
const MIN_MAIN_TEXT_CHARS = 200;
const PRE_LINE_MARK = "\u0000";
const INDENT_MARK = "\u0001";
const MAX_TREE_DEPTH = 600;

/**
 * Picks the element that most likely holds the page's main content.
 *
 * @param root - Snapshot of `<body>` (object)
 * @returns The chosen element node (object)
 */
export function selectMainContent(root) {
  if (!isElement(root)) return root;
  const bodyTextLength = measureTextLength(root);
  const mainCandidates = findElements(root, (node) => node.tag === "main" || node.attrs?.role === "main");
  const articleCandidates = findElements(root, (node) => node.tag === "article");
  const chosen = pickLargest(mainCandidates) ?? pickDominantArticle(articleCandidates);
  if (!chosen) return root;
  const chosenLength = measureTextLength(chosen);
  const isTooSmall = chosenLength < MIN_MAIN_TEXT_CHARS && chosenLength < bodyTextLength * 0.25;
  return isTooSmall ? root : chosen;
}

/**
 * Returns a copy of the element without boilerplate descendants (see module docs).
 *
 * @param node - Snapshot element (object)
 * @returns Pruned copy (object)
 */
export function removeBoilerplate(node) {
  return pruneNode(node, 0) ?? { tag: "div", attrs: {}, children: [] };
}

/**
 * Renders a snapshot element as plain text or markdown, whitespace normalised.
 *
 * @param node - Snapshot element (object)
 * @param options - `{markdown: boolean}` (object, optional)
 * @returns Text (string)
 *
 * @example
 * renderContent({ tag: "h1", attrs: {}, children: ["Hi"] }, { markdown: true }); // "# Hi"
 */
export function renderContent(node, { markdown = false } = {}) {
  return normalizeRenderedText(renderNode(node, { markdown }, 0));
}

/**
 * Picks the element whose text a page operation returns.
 *
 * @param root - Snapshot of `<body>` (object | null)
 * @param options - `{mainContentOnly}` (object)
 * @returns The main content without boilerplate, the whole body, or null (object | null)
 */
export function selectContentRoot(root, { mainContentOnly = true } = {}) {
  if (!isElement(root)) return null;
  return mainContentOnly ? removeBoilerplate(selectMainContent(root)) : root;
}

/**
 * Renders readable text (and optionally markdown) for a content root.
 *
 * @param contentRoot - From selectContentRoot (object | null)
 * @param options - `{markdown}` (object)
 * @returns `{text, markdown?}` (object)
 */
export function buildReadableContent(contentRoot, { markdown = false } = {}) {
  if (!isElement(contentRoot)) return markdown ? { text: "", markdown: "" } : { text: "" };
  const content = { text: renderContent(contentRoot) };
  if (markdown) content.markdown = renderContent(contentRoot, { markdown: true });
  return content;
}

/**
 * Collects unique http(s) links (fragment removed) with their text, in document order.
 *
 * @param root - Snapshot of `<body>` (object | null)
 * @param baseUrl - Page URL for resolving relative hrefs (string)
 * @returns `[{url, text}]` (object[])
 */
export function collectLinks(root, baseUrl) {
  const linksByUrl = new Map();
  for (const anchor of findElements(root, (node) => node.tag === "a" && Boolean(node.attrs?.href))) {
    const url = toAbsoluteHttpUrl(anchor.attrs.href, baseUrl);
    if (!url || linksByUrl.has(url)) continue;
    linksByUrl.set(url, { url, text: truncateText(collapseWhitespace(collectPlainText(anchor)), 200).text });
  }
  return [...linksByUrl.values()];
}

/**
 * Cuts text to `maxChars`, preferring a whitespace boundary near the end.
 *
 * @param text - Text (string)
 * @param maxChars - Maximum length (number)
 * @returns `{text, truncated}` (object)
 */
export function truncateText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const hardCut = text.slice(0, maxChars);
  const lastBreak = Math.max(hardCut.lastIndexOf(" "), hardCut.lastIndexOf("\n"));
  const cut = lastBreak > maxChars * 0.8 ? hardCut.slice(0, lastBreak) : hardCut;
  return { text: `${cut.trimEnd()}…`, truncated: true };
}

/**
 * Collapses every whitespace run to one space and trims.
 *
 * @param text - Text (string)
 * @returns Collapsed text (string)
 */
export function collapseWhitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function renderNode(node, context, depth) {
  if (typeof node === "string") return node.replace(/\s+/g, " ");
  if (!isElement(node) || depth > MAX_TREE_DEPTH) return "";
  const renderer = ELEMENT_RENDERERS[node.tag];
  if (renderer) return renderer(node, context, depth);
  const inner = renderChildren(node, context, depth);
  if (PARAGRAPH_TAGS.has(node.tag)) return `\n\n${inner}\n\n`;
  return BLOCK_TAGS.has(node.tag) ? `\n${inner}\n` : inner;
}

function renderChildren(node, context, depth) {
  return node.children.map((child) => renderNode(child, context, depth + 1)).join("");
}

const ELEMENT_RENDERERS = {
  h1: renderHeading, h2: renderHeading, h3: renderHeading, h4: renderHeading, h5: renderHeading, h6: renderHeading,
  ul: renderList, ol: renderList,
  li: (node, context, depth) => `\n${renderChildren(node, context, depth)}\n`,
  a: renderLink,
  strong: (node, context, depth) => wrapInline(renderChildren(node, context, depth), context.markdown ? "**" : ""),
  b: (node, context, depth) => wrapInline(renderChildren(node, context, depth), context.markdown ? "**" : ""),
  em: (node, context, depth) => wrapInline(renderChildren(node, context, depth), context.markdown ? "_" : ""),
  i: (node, context, depth) => wrapInline(renderChildren(node, context, depth), context.markdown ? "_" : ""),
  code: (node, context, depth) => wrapInline(renderChildren(node, context, depth), context.markdown ? "`" : ""),
  pre: renderPreformatted,
  blockquote: renderBlockquote,
  br: () => "\n",
  hr: (node, context) => (context.markdown ? "\n\n---\n\n" : "\n\n"),
  table: renderTable,
  td: (node, context, depth) => ` ${renderChildren(node, context, depth)} `,
  th: (node, context, depth) => ` ${renderChildren(node, context, depth)} `,
  tr: (node, context, depth) => `\n${renderChildren(node, context, depth)}\n`,
};

function renderHeading(node, context, depth) {
  const inner = collapseWhitespace(renderChildren(node, context, depth));
  if (!inner) return "";
  const prefix = context.markdown ? `${"#".repeat(Number(node.tag[1]))} ` : "";
  return `\n\n${prefix}${inner}\n\n`;
}

function renderList(node, context, depth) {
  const items = node.children.filter((child) => isElement(child) && child.tag === "li");
  const otherChildren = node.children.filter((child) => !(isElement(child) && child.tag === "li"));
  const renderedItems = items.map((item, index) => {
    const marker = node.tag === "ol" ? `${index + 1}. ` : "- ";
    return formatListItem(renderChildren(item, context, depth + 1), marker);
  });
  const strayText = otherChildren.map((child) => renderNode(child, context, depth + 1)).join("");
  return `\n\n${strayText}${renderedItems.join("\n")}\n\n`;
}

// First line gets the marker; continuation lines (and nested lists) are indented under it.
function formatListItem(renderedItem, marker) {
  const lines = normalizeRenderedText(renderedItem, { keepMarks: true }).split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return "";
  const continuationIndent = INDENT_MARK.repeat(marker.length);
  return lines.map((line, index) => (index === 0 ? `${marker}${line}` : `${continuationIndent}${line}`)).join("\n");
}

function renderLink(node, context, depth) {
  const inner = renderChildren(node, context, depth);
  const label = collapseWhitespace(inner);
  if (!context.markdown || !label) return inner;
  const url = toAbsoluteHttpUrl(node.attrs?.href, null);
  if (!url) return inner;
  return `${leadingSpace(inner)}[${label.replace(/[[\]]/g, "\\$&")}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})${trailingSpace(inner)}`;
}

function renderPreformatted(node, context) {
  const rawText = collectPlainText(node).replace(/\n+$/, "");
  const markedLines = rawText.split("\n").map((line) => `${PRE_LINE_MARK}${line}`).join("\n");
  return context.markdown ? `\n\n${PRE_LINE_MARK}\`\`\`\n${markedLines}\n${PRE_LINE_MARK}\`\`\`\n\n` : `\n\n${markedLines}\n\n`;
}

function renderBlockquote(node, context, depth) {
  const inner = normalizeRenderedText(renderChildren(node, context, depth), { keepMarks: true });
  if (!context.markdown) return `\n\n${inner}\n\n`;
  return `\n\n${inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")}\n\n`;
}

function renderTable(node, context, depth) {
  const rows = findElements(node, (candidate) => candidate.tag === "tr");
  if (rows.length === 0) return `\n\n${renderChildren(node, context, depth)}\n\n`;
  const renderedRows = rows.map((row) =>
    row.children.filter((cell) => isElement(cell) && (cell.tag === "td" || cell.tag === "th")).map((cell) => collapseWhitespace(renderChildren(cell, context, depth + 1))),
  );
  if (!context.markdown) return `\n\n${renderedRows.map((cells) => cells.join(" | ")).join("\n")}\n\n`;
  const columnCount = Math.max(...renderedRows.map((cells) => cells.length), 1);
  const formatRow = (cells) => `| ${[...cells, ...Array(columnCount - cells.length).fill("")].map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
  const [headerRow, ...bodyRows] = renderedRows;
  return `\n\n${[formatRow(headerRow), formatRow(Array(columnCount).fill("---")), ...bodyRows.map(formatRow)].join("\n")}\n\n`;
}

function wrapInline(inner, marker) {
  const content = inner.trim();
  if (!content || !marker) return inner;
  return `${leadingSpace(inner)}${marker}${content}${marker}${trailingSpace(inner)}`;
}

function leadingSpace(text) {
  return /^\s/.test(text) ? " " : "";
}

function trailingSpace(text) {
  return /\s$/.test(text) ? " " : "";
}

/**
 * Normalises rendered output: trims and collapses spaces per line (except preformatted lines),
 * keeps at most one blank line in a row, and turns indent marks into spaces.
 */
function normalizeRenderedText(renderedText, { keepMarks = false } = {}) {
  const lines = renderedText.split("\n").map((line) => {
    if (line.startsWith(PRE_LINE_MARK)) return keepMarks ? line.trimEnd() : line.slice(PRE_LINE_MARK.length).trimEnd();
    const indent = /^[\s\u0001]*/.exec(line)[0].replace(/[^\u0001]/g, "");
    const content = line.replace(/[ \t\f\v\r\u00a0]+/g, " ").replace(/^[\s\u0001]+/, "").trimEnd();
    if (!content) return "";
    return keepMarks ? `${indent}${content}` : `${indent.replace(/\u0001/g, " ")}${content}`;
  });
  const joined = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
  return keepMarks ? joined : joined.replace(/[\u0000\u0001]/g, "");
}

function collectPlainText(node, depth = 0) {
  if (typeof node === "string") return node;
  if (!isElement(node) || depth > MAX_TREE_DEPTH) return "";
  if (node.tag === "br") return "\n";
  return node.children.map((child) => collectPlainText(child, depth + 1)).join("");
}

function pruneNode(node, depth) {
  if (typeof node === "string") return node;
  if (!isElement(node) || depth > MAX_TREE_DEPTH) return null;
  if (depth > 0 && isBoilerplate(node)) return null;
  const children = node.children.map((child) => pruneNode(child, depth + 1)).filter((child) => child !== null);
  return { ...node, children };
}

function isBoilerplate(node) {
  if (BOILERPLATE_TAGS.has(node.tag)) return true;
  if (node.tag === "header" && !containsHeading(node)) return true;
  if (BOILERPLATE_ROLES.has(String(node.attrs?.role ?? "").toLowerCase())) return true;
  const nameTokens = `${node.attrs?.id ?? ""} ${node.attrs?.class ?? ""}`.toLowerCase().split(/[\s_-]+/);
  return nameTokens.some((token) => BOILERPLATE_NAME_TOKENS.has(token));
}

function containsHeading(node) {
  return findElements(node, (candidate) => candidate.tag === "h1" || candidate.tag === "h2").length > 0;
}

function pickLargest(candidates) {
  let largest = null;
  for (const candidate of candidates) {
    if (!largest || measureTextLength(candidate) > measureTextLength(largest)) largest = candidate;
  }
  return largest;
}

function pickDominantArticle(articles) {
  const largest = pickLargest(articles);
  if (!largest) return null;
  const totalLength = articles.reduce((sum, article) => sum + measureTextLength(article), 0);
  return measureTextLength(largest) >= totalLength * 0.5 ? largest : null;
}

const textLengthCache = new WeakMap();

function measureTextLength(node) {
  if (typeof node === "string") return collapseWhitespace(node).length;
  if (!isElement(node)) return 0;
  if (!textLengthCache.has(node)) textLengthCache.set(node, collapseWhitespace(collectPlainText(node)).length);
  return textLengthCache.get(node);
}

function findElements(root, predicate) {
  const found = [];
  const stack = isElement(root) ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (predicate(node)) found.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      if (isElement(node.children[index])) stack.push(node.children[index]);
    }
  }
  return found;
}

function isElement(node) {
  return typeof node === "object" && node !== null && typeof node.tag === "string" && Array.isArray(node.children);
}

function toAbsoluteHttpUrl(href, baseUrl) {
  try {
    const url = baseUrl ? new URL(href, baseUrl) : new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
