// Unit tests for lib/agent-tool-policy.mjs (the same file in every social and WhatsApp plugin that has it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAgentPolicy, assertToolOptIn, makeNodeOnly, requireToolOptIn, wrapEach } from "../lib/agent-tool-policy.mjs";

const OPT_IN_ENV = "DEMO_TOOL_ALLOW_POST";
const demoOperation = { name: "create_demo", description: "Publish a demo", run: async () => ({ data: "sent" }) };

test("assertToolOptIn refuses tool calls unless the env is exactly 1", () => {
  for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
    assert.throws(
      () => assertToolOptIn({ source: "tool", environment: { [OPT_IN_ENV]: value } }, "create_demo", OPT_IN_ENV),
      (error) => error.kind === "permission_denied" && error.message.includes(`${OPT_IN_ENV}=1`) && error.message.includes("create_demo"),
      String(value),
    );
  }
  assert.doesNotThrow(() => assertToolOptIn({ source: "tool", environment: { [OPT_IN_ENV]: "1" } }, "create_demo", OPT_IN_ENV));
});

test("assertToolOptIn never limits workflow nodes", () => {
  assert.doesNotThrow(() => assertToolOptIn({ source: "node", environment: {} }, "create_demo", OPT_IN_ENV));
});

test("requireToolOptIn refuses before the operation runs and names the env in the description", async () => {
  let runCount = 0;
  const guarded = requireToolOptIn(OPT_IN_ENV)({ ...demoOperation, run: async () => ({ data: (runCount += 1) }) });
  assert.match(guarded.description, /as an agent tool only when DEMO_TOOL_ALLOW_POST=1/);
  await assert.rejects(guarded.run({ source: "tool", environment: {} }), (error) => error.kind === "permission_denied");
  assert.equal(runCount, 0);
  await guarded.run({ source: "tool", environment: { [OPT_IN_ENV]: "1" } });
  await guarded.run({ source: "node", environment: {} });
  assert.equal(runCount, 2);
});

test("applyAgentPolicy wraps only the named operations and refuses unknown names", () => {
  const operations = [demoOperation, { ...demoOperation, name: "read_demo" }];
  const wrapped = applyAgentPolicy(operations, { create_demo: makeNodeOnly });
  assert.equal(wrapped[0].nodeOnly, true);
  assert.equal(wrapped[1].nodeOnly, undefined);
  assert.throws(() => applyAgentPolicy(operations, { create_dmeo: makeNodeOnly }), /create_dmeo/);
  assert.deepEqual(Object.keys(wrapEach(["a", "b"], makeNodeOnly)), ["a", "b"]);
});

test("requireToolOptIn can name a further condition in the description", () => {
  const guarded = requireToolOptIn(OPT_IN_ENV, "the recipient is in DEMO_ALLOWLIST")(demoOperation);
  assert.equal(guarded.description, "Publish a demo (as an agent tool only when DEMO_TOOL_ALLOW_POST=1 and the recipient is in DEMO_ALLOWLIST)");
});
