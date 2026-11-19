import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRestPlugin } from "../lib/rest-plugin.mjs";
import { createTransferBudget, readFileInputWithinBudget } from "../lib/transfer-budget.mjs";
import { buildSpec, createScriptedFetch, publicResolver, runOperation, waitOrAbort } from "./fixtures/rest-test-helpers.mjs";

function createFakeClock(startMs) {
  const clock = { nowMs: startMs };
  clock.now = () => clock.nowMs;
  return clock;
}

// --- the helper ----------------------------------------------------------------------------------------------

test("createTransferBudget gives file reads the time left minus what the request needs", () => {
  const clock = createFakeClock(1000);
  const budget = createTransferBudget({ totalMs: 10000, minRequestMs: 4000, maxRequestMs: 5000, now: clock.now });
  assert.equal(budget.deadlineAt, 11000);
  assert.equal(budget.fileReadTimeoutMs(), 6000);
  clock.nowMs = 3000;
  assert.equal(budget.fileReadTimeoutMs(), 4000);
});

test("createTransferBudget gives the request its own timeout, capped by the time left", () => {
  const clock = createFakeClock(0);
  const budget = createTransferBudget({ totalMs: 10000, minRequestMs: 2000, maxRequestMs: 5000, now: clock.now });
  assert.equal(budget.requestTimeoutMs(), 5000);
  clock.nowMs = 7000;
  assert.equal(budget.requestTimeoutMs(), 3000);
});

test("createTransferBudget refuses to start the request when less than minRequestMs is left (not retryable)", () => {
  const clock = createFakeClock(0);
  const budget = createTransferBudget({ totalMs: 10000, minRequestMs: 4000, maxRequestMs: 4000, now: clock.now });
  clock.nowMs = 6500;
  assert.throws(() => budget.requestTimeoutMs(), (error) => error.kind === "timeout" && error.retryable === false && /nothing was sent/.test(error.message) && /4000 ms/.test(error.message));
  assert.throws(() => budget.fileReadTimeoutMs(), (error) => error.kind === "timeout" && error.retryable === false);
});

test("createTransferBudget validates its arguments", () => {
  assert.throws(() => createTransferBudget({ totalMs: 0, minRequestMs: 1 }), /totalMs/);
  assert.throws(() => createTransferBudget({ totalMs: 1000, minRequestMs: 1000 }), /minRequestMs/);
});

test("readFileInputWithinBudget downloads an https input with the file-read timeout (for hand-written operations)", async () => {
  const fetchImpl = createScriptedFetch(async (url, init) => {
    await waitOrAbort(5000, init.signal);
    return new Response("late");
  });
  const budget = createTransferBudget({ totalMs: 400, minRequestMs: 200 });
  const startedAt = Date.now();
  await assert.rejects(readFileInputWithinBudget("https://cdn.example.com/a.png", { paramName: "image", fetchImpl, resolveHostAddresses: publicResolver }, budget), /timed out/);
  assert.ok(Date.now() - startedAt < 400, "the download stops when only minRequestMs is left");
});

test("readFileInputWithinBudget reads a local file from the allowlisted directory", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "budget-")));
  try {
    await writeFile(join(directory, "a.png"), "PNG");
    const budget = createTransferBudget({ totalMs: 10000, minRequestMs: 1000 });
    const fileInput = await readFileInputWithinBudget(join(directory, "a.png"), { paramName: "image", fileDirEnv: "UP", environment: { UP: directory } }, budget);
    assert.equal(fileInput.bytes.toString(), "PNG");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// --- declarative operations: multipart and file bodies share the call's budget ---------------------------------

// limits.timeout_ms 10900: 900 ms for the whole call (host timeout minus 10 s).
const budgetSpec = (bodyMode, operationOverrides = {}) =>
  buildSpec(
    [
      {
        name: "edit",
        title: "Edit",
        description: "Paid edit with a file input",
        method: "POST",
        path: "/edits",
        write: "unsafe",
        bodyMode,
        ...(bodyMode === "multipart" ? { multipart: { fileDirEnv: "PROBE_UPLOAD_DIR" } } : { fileBody: { fileDirEnv: "PROBE_UPLOAD_DIR" } }),
        timeoutMs: 400,
        params: { image: { in: "body", type: "string", file: true, required: true } },
        ...operationOverrides,
      },
    ],
    { limits: { timeout_ms: 10900 } },
  );

for (const bodyMode of ["multipart", "file"]) {
  test(`${bodyMode}: a slow https input is cut off so the request keeps its full timeout inside the call budget`, async () => {
    const fetchImpl = createScriptedFetch(async (url, init) => {
      await waitOrAbort(5000, init.signal);
      return new Response("late");
    });
    const startedAt = Date.now();
    const { error } = await runOperation(budgetSpec(bodyMode), "edit", { image: "https://cdn.example.com/slow.png" }, { fetchImpl });
    const elapsedMs = Date.now() - startedAt;
    assert.match(error?.message ?? "", /timed out/);
    assert.equal(fetchImpl.calls.length, 1, "the paid request is not started");
    assert.ok(elapsedMs < 800, `the download got 900 - 400 ms, not its own 120 s default (took ${elapsedMs} ms)`);
  });

  test(`${bodyMode}: the paid request gets min(timeoutMs, time left) after the download`, async () => {
    const fetchImpl = createScriptedFetch(async (url, init, callIndex) => {
      if (callIndex === 0) {
        await waitOrAbort(300, init.signal);
        return new Response("PNG", { headers: { "content-type": "image/png" } });
      }
      await waitOrAbort(5000, init.signal);
      return { body: {} };
    });
    const startedAt = Date.now();
    const { error } = await runOperation(budgetSpec(bodyMode), "edit", { image: "https://cdn.example.com/a.png" }, { fetchImpl });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(fetchImpl.calls.length, 2);
    assert.match(error.message, /request timed out.*outcome unknown/);
    assert.ok(elapsedMs < 900, `everything ends inside the call budget (took ${elapsedMs} ms)`);
  });
}

test("operations with file inputs must leave time to read them before the request (checked at load)", () => {
  assert.throws(() => defineRestPlugin(budgetSpec("multipart", { timeoutMs: 900 })), /file inputs.*raise limits\.timeout_ms or set minRequestMs/);
  assert.doesNotThrow(() => defineRestPlugin(budgetSpec("multipart", { timeoutMs: 900, minRequestMs: 300 })));
  assert.throws(() => defineRestPlugin(budgetSpec("multipart", { minRequestMs: 500 })), /minRequestMs.*timeoutMs/);
  assert.throws(() => defineRestPlugin(buildSpec([{ name: "get", title: "G", description: "d", path: "/x", minRequestMs: 10 }])), /minRequestMs.*file/);
});
