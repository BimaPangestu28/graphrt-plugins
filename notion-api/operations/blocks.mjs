/**
 * Block and comment operations: read a page's content, append plain-text paragraphs, add a comment.
 * Appends and comments are never retried after an unknown outcome.
 */
import { buildParagraphBlocks, MAX_PARAGRAPHS_TOTAL_LENGTH, splitIntoRichText } from "../lib/rich-text.mjs";
import { extractNotionId, notionIdSegment, rejectInput, toCursorResult, withWriteOutcomeHint } from "../lib/client.mjs";
import { buildPagination, CURSOR_PROPERTY, LIMIT_PROPERTY } from "./common.mjs";

const MAX_APPENDED_BLOCKS = 100;
const BLOCK_ID_PROPERTY = { type: "string", description: "Block id, or a page id/URL (a page is a block)" };

function buildAppendPosition(args) {
  if (args.after_block_id && args.at_start) rejectInput("Pass either `after_block_id` or `at_start`, not both");
  if (args.after_block_id) return { type: "after_block", after_block: { id: extractNotionId(args.after_block_id) } };
  return args.at_start ? { type: "start" } : undefined;
}

function buildCommentTarget(args) {
  const targets = [
    args.page_id && { parent: { page_id: extractNotionId(args.page_id) } },
    args.block_id && { parent: { block_id: extractNotionId(args.block_id) } },
    args.discussion_id && { discussion_id: args.discussion_id },
  ].filter(Boolean);
  if (targets.length !== 1) rejectInput("Pass exactly one of `page_id`, `block_id` or `discussion_id`");
  return targets[0];
}

export const blockOperations = [
  {
    name: "get_block_children",
    title: "Get block children",
    description: "Read the content of a page or block: its child blocks (paragraphs, headings, lists, ...), one page at a time.",
    parameters: { type: "object", properties: { block_id: BLOCK_ID_PROPERTY, limit: LIMIT_PROPERTY, cursor: CURSOR_PROPERTY }, required: ["block_id"] },
    run: async ({ client, args, signal }) => {
      const path = `/blocks/${notionIdSegment(args.block_id)}/children`;
      return toCursorResult(await client.request({ path, query: buildPagination(args), signal }));
    },
  },
  {
    name: "append_paragraphs",
    title: "Append paragraphs",
    description: `Append plain-text paragraphs (at most ${MAX_APPENDED_BLOCKS} per call, ${MAX_PARAGRAPHS_TOTAL_LENGTH} characters in total) to a page or block, at the end by default. Never retried after an unknown outcome.`,
    parameters: {
      type: "object",
      properties: {
        block_id: BLOCK_ID_PROPERTY,
        paragraphs: { type: "array", items: { type: "string" }, maxItems: MAX_APPENDED_BLOCKS, description: "One string per paragraph; long text is split into 2000-character pieces" },
        after_block_id: { type: "string", description: "Insert after this child block instead of at the end" },
        at_start: { type: "boolean", description: "Insert at the start instead of at the end" },
      },
      required: ["block_id", "paragraphs"],
    },
    run: async ({ client, args, signal }) => {
      if (args.paragraphs.length === 0) rejectInput("`paragraphs` must have at least one item");
      const json = { children: buildParagraphBlocks(args.paragraphs), position: buildAppendPosition(args) };
      const request = client.request({ method: "PATCH", path: `/blocks/${notionIdSegment(args.block_id)}/children`, json, signal });
      return { data: await withWriteOutcomeHint(request, "read the page with get_block_children before appending again") };
    },
  },
  {
    name: "add_comment",
    title: "Add comment",
    description: "Add a plain-text comment to a page, a block or an existing discussion thread. Never retried after an unknown outcome.",
    parameters: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "Comment on this page (id or URL)" },
        block_id: { type: "string", description: "Comment on this block" },
        discussion_id: { type: "string", description: "Reply in this discussion thread" },
        text: { type: "string", description: "Comment text" },
      },
      required: ["text"],
    },
    run: async ({ client, args, signal }) => {
      const json = { ...buildCommentTarget(args), rich_text: splitIntoRichText(args.text, "text") };
      const request = client.request({ method: "POST", path: "/comments", json, signal });
      return { data: await withWriteOutcomeHint(request, "list the page's comments (api_request GET /comments?block_id=...) before commenting again") };
    },
  },
];
