import { test } from "node:test";
import assert from "node:assert/strict";
import { pathSegment } from "../lib/path.mjs";

test("pathSegment encodes characters that would change the path", () => {
  assert.equal(pathSegment("../me/feed?x=1#"), "..%2Fme%2Ffeed%3Fx%3D1%23");
  assert.equal(pathSegment("1234_5678"), "1234_5678");
  assert.equal(pathSegment(42), "42");
});

test("pathSegment rejects empty, dot-only and missing ids", () => {
  for (const badSegment of ["", ".", "..", undefined, null]) {
    assert.throws(() => pathSegment(badSegment), (error) => error.kind === "invalid_input");
  }
});
