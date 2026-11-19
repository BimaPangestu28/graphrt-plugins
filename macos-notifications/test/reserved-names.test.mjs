/**
 * graphrt removes some keys from a node's config before the plugin sees them (layout fields such as
 * `width`/`height`/`position`, and node policy such as `timeout`/`retry`), so no parameter may use them.
 * Identical in every local media plugin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pluginDefinition } from "../definition.mjs";

const RESERVED_NODE_KEYS = [
  "id", "type", "title", "data", "parent", "parentId", "container_id", "iteration_id", "loop_id",
  "desc", "selected", "position", "positionAbsolute", "width", "height", "sourcePosition", "targetPosition", "zIndex", "isInIteration", "isInLoop",
  "on_error", "error_strategy", "default_value", "retry", "retry_config", "timeout_ms", "timeout",
];

test("no operation parameter uses a key graphrt strips from node configs", () => {
  for (const operation of pluginDefinition.operations) {
    for (const parameterName of Object.keys(operation.parameters.properties)) {
      assert.ok(!RESERVED_NODE_KEYS.includes(parameterName), `${operation.name}.${parameterName}`);
    }
  }
});
