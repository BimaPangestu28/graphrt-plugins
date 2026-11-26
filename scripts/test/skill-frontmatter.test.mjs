import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillFile } from "../lib/skill-frontmatter.mjs";

const skillText = (frontmatterLines, body = "# Title\n\nDo the thing.\n") => `---\n${frontmatterLines.join("\n")}\n---\n\n${body}`;

test("reads every field of the specification in the supported subset", () => {
  const { frontmatter, body } = parseSkillFile(skillText([
    "name: refund-policy",
    "description: \"Use when: a customer says \\\"money back\\\" # not a comment\"",
    "license: Apache-2.0",
    "compatibility: 'Needs the orders plugin; it''s optional'",
    "metadata:",
    "  version: \"1.0.0\"",
    "  display_name: Refund Policy",
    "  author: graphrt",
    "allowed-tools: orders/lookup  mail/*",
  ]));
  assert.deepEqual(frontmatter, {
    name: "refund-policy",
    description: 'Use when: a customer says "money back" # not a comment',
    license: "Apache-2.0",
    compatibility: "Needs the orders plugin; it's optional",
    metadata: { version: "1.0.0", display_name: "Refund Policy", author: "graphrt" },
    allowedTools: ["orders/lookup", "mail/*"],
  });
  assert.equal(body, "# Title\n\nDo the thing.");
});

test("allowed-tools may be a list, and absent fields stay empty", () => {
  const { frontmatter } = parseSkillFile(skillText(["name: a", "description: Does a thing.", "", "allowed-tools:", "  - mail/send", "  - \"sheets/*\""]));
  assert.deepEqual(frontmatter.allowedTools, ["mail/send", "sheets/*"]);
  assert.deepEqual(frontmatter.metadata, {});
  assert.equal(frontmatter.license, undefined);
});

test("a missing or unclosed frontmatter is refused", () => {
  assert.throws(() => parseSkillFile("# Just markdown\n"), /must start with frontmatter/);
  assert.throws(() => parseSkillFile(""), /must start with frontmatter/);
  assert.throws(() => parseSkillFile("---\nname: a\ndescription: d\n"), /no closing `---`/);
  assert.throws(() => parseSkillFile("\uFEFF---\nname: a\n---\n"), /byte order mark/);
  assert.throws(() => parseSkillFile("---\r\nname: a\r\n---\r\n"), /LF line endings/);
});

test("YAML outside the subset is refused with its line number, never guessed", () => {
  const refused = [
    [["name: a", "description: >", "  folded", "  text"], /line 4: `description` must be written on one line/],
    [["name: a", "description: >-"], /line 3: `description`: a value starting with ">"/],
    [["name: a", "description: |"], /line 3: `description`: a value starting with "\|"/],
    [["name: a", "description: first", "  second line"], /line 4: `description` must be written on one line/],
    [["name: a", "description: Use when: asked"], /line 3: `description`: a value containing `: ` or ` #` must be quoted/],
    [["name: a", "description: text # comment"], /must be quoted/],
    [["name: a", "# a comment", "description: d"], /line 3: expected `key: value`/],
    [["name: a", "name: b", "description: d"], /line 3: `name` is given twice/],
    [["name: a", "description: d", "model: opus"], /line 4: unknown field `model`/],
    [["name: a", "description: d", "allowed_tools: x/y"], /expected `key: value`/],
    [["name: a", "description: [a, b]"], /a value starting with "\["/],
    [["name: a", "description: {a: b}"], /a value starting with "\{"/],
    [["name: a", "description: &anchor text"], /a value starting with "&"/],
    [["name: a", "description: !!str text"], /a value starting with "!"/],
    [["name: a", "description: \"unterminated"], /a value starting with "\\""/],
    [["name: a", "description: \"tab\\tescape\""], /a value starting with "\\""/],
    [["name: a", "description:"], /`description`: the value is empty/],
    [["name: a", "description: d", "metadata: inline"], /`metadata` must be followed by indented/],
    [["name: a", "description: d", "metadata:", "    version: \"1.0.0\""], /expected a metadata line/],
    [["name: a", "description: d", "metadata:", "  version: \"1.0.0\"", "  version: \"2.0.0\""], /metadata `version` is given twice/],
    [["name: a", "description: d", "metadata:", "  nested:", "    deep: x"], /expected a metadata line/],
    [["name: a", "description: d", "allowed-tools: a/b", "  - c/d"], /either one line or a list/],
    [["name: a", "description: d", "allowed-tools:", "  mail/send"], /expected a list item/],
    [["name: a", "\tdescription: d"], /tabs are not allowed/],
  ];
  for (const [frontmatterLines, expectedMessage] of refused) {
    assert.throws(() => parseSkillFile(skillText(frontmatterLines)), expectedMessage, frontmatterLines.join(" | "));
  }
});

test("values YAML would not read as text must be quoted", () => {
  for (const value of ["1.0", "1.10", "42", "-3", "1e3", "0x1F", "true", "No", "null", "~", "on", ".inf", "2026-11-27"]) {
    assert.throws(() => parseSkillFile(skillText(["name: a", "description: d", "metadata:", `  version: ${value}`])), /quote it|must be a complete quoted string/, value);
    assert.equal(parseSkillFile(skillText(["name: a", "description: d", "metadata:", `  version: "${value}"`])).frontmatter.metadata.version, value);
  }
  // Text that merely starts like a number stays text.
  assert.equal(parseSkillFile(skillText(["name: a", "description: 3 langkah menagih, tanpa marah"])).frontmatter.description, "3 langkah menagih, tanpa marah");
});
