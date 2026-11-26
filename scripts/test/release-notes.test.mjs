import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReleaseNotes } from "../lib/release-notes.mjs";

const packedBase = { version: "1.0.0", tarballName: "x-1.0.0.tar.gz", sha256: "f".repeat(64), sizeBytes: 10 };

test("release notes of an MCP preset name its server instead of operations", () => {
  const notes = renderReleaseNotes({
    ...packedBase,
    name: "upwork",
    tag: "upwork-v1.0.0",
    manifest: { name: "upwork", runtime: "mcp", description: "Upwork MCP", permissions: { network: true }, mcp: { url: "https://mcp.upwork.com/mcp", auth: "oauth" } },
  });
  assert.match(notes, /MCP server preset:\*\* https:\/\/mcp\.upwork\.com\/mcp \(sign-in: oauth\)/);
  assert.match(notes, /no Node\.js/);
  assert.doesNotMatch(notes, /Operations/);
});

test("release notes of a code plugin keep the operation count", () => {
  const notes = renderReleaseNotes({
    ...packedBase,
    name: "demo",
    tag: "demo-v1.0.0",
    manifest: { name: "demo", runtime: "process", description: "Demo", nodes: [{ kind: "demo.a" }], tools: [{ name: "a" }] },
  });
  assert.match(notes, /Operations:\*\* 1 \(nodes `demo.<operation>`; 1 agent tools\)/);
  assert.match(notes, /Node\.js >= 20/);
});
