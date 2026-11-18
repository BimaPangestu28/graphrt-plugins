import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSendGuard } from "../lib/send-guard.mjs";

const NOV_18_NOON = new Date(2026, 10, 18, 12, 0, 0).getTime();

function createFakeClock(startMs) {
  const clock = { nowMs: startMs, sleeps: [] };
  clock.now = () => clock.nowMs;
  clock.sleep = async (delayMs) => {
    clock.sleeps.push(delayMs);
    clock.nowMs += delayMs;
  };
  return clock;
}

async function withGuard(options, testBody) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "wa-guard-"));
  const clock = createFakeClock(options.startMs ?? NOV_18_NOON);
  const stateFilePath = join(stateDirectory, "send-state.json");
  const guard = createSendGuard({ stateFilePath, minIntervalMs: 5000, dailyLimit: 3, clock, ...options.guardOptions });
  try {
    await testBody({ guard, clock, stateFilePath });
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

test("first send goes through immediately and is persisted", () =>
  withGuard({}, async ({ guard, clock, stateFilePath }) => {
    const usage = await guard.reserveSend();
    assert.deepEqual(usage, { sends_today: 1, daily_limit: 3 });
    assert.deepEqual(clock.sleeps, []);
    const savedState = JSON.parse(await readFile(stateFilePath, "utf8"));
    assert.deepEqual(savedState, { day: "2026-11-18", count: 1, last_send_at: NOV_18_NOON });
  }));

test("a second send waits for the rest of the minimum interval", () =>
  withGuard({}, async ({ guard, clock }) => {
    await guard.reserveSend();
    clock.nowMs += 2000;
    await guard.reserveSend();
    assert.deepEqual(clock.sleeps, [3000]);
  }));

test("an interval longer than the wait cap is rate_limited instead of waited", () =>
  withGuard({ guardOptions: { minIntervalMs: 600000 } }, async ({ guard, clock }) => {
    await guard.reserveSend();
    clock.nowMs += 1000;
    await assert.rejects(guard.reserveSend(), (error) => error.kind === "rate_limited" && error.retryable && error.retryAfterMs === 599000);
    assert.deepEqual(clock.sleeps, []);
  }));

test("the daily cap rejects further sends with rate_limited until local midnight", () =>
  withGuard({}, async ({ guard, clock }) => {
    for (let sendIndex = 0; sendIndex < 3; sendIndex += 1) {
      await guard.reserveSend();
      clock.nowMs += 10000;
    }
    await assert.rejects(guard.reserveSend(), (error) => {
      assert.equal(error.kind, "rate_limited");
      assert.equal(error.retryable, false);
      assert.match(error.message, /daily send limit of 3/);
      return true;
    });
  }));

test("the count resets on a new local day and survives a new guard instance", () =>
  withGuard({}, async ({ guard, clock, stateFilePath }) => {
    await guard.reserveSend();
    await guard.reserveSend();
    const reloadedGuard = createSendGuard({ stateFilePath, minIntervalMs: 0, dailyLimit: 3, clock });
    assert.equal((await reloadedGuard.getUsage()).sends_today, 2);
    clock.nowMs = new Date(2026, 10, 19, 0, 0, 1).getTime();
    assert.equal((await reloadedGuard.reserveSend()).sends_today, 1);
  }));

test("a daily limit of 0 disables sending", () =>
  withGuard({ guardOptions: { dailyLimit: 0 } }, async ({ guard }) => {
    await assert.rejects(guard.reserveSend(), { kind: "rate_limited" });
  }));

const isClosedStateError = (error) =>
  error.kind === "rate_limited" && error.retryable === false && /send-state\.json/.test(error.message) && /delete/i.test(error.message);

for (const [description, corruptContent] of [
  ["not JSON", "{not json"],
  ["a JSON value that is not an object", "42"],
  ["an object with a bad count", JSON.stringify({ day: "2026-11-18", count: "many", last_send_at: 1 })],
  ["an object without a day", JSON.stringify({ count: 1 })],
]) {
  test(`a send state file that is ${description} blocks sending (fails closed) and says how to reset`, () =>
    withGuard({}, async ({ guard, stateFilePath }) => {
      await writeFile(stateFilePath, corruptContent);
      await assert.rejects(guard.reserveSend(), isClosedStateError);
      assert.equal(await readFile(stateFilePath, "utf8"), corruptContent, "the file is left for the user to inspect");
    }));
}

test("an unreadable send state file blocks sending", () =>
  withGuard({}, async ({ guard, stateFilePath }) => {
    await mkdir(stateFilePath); // reading a directory fails with EISDIR
    await assert.rejects(guard.reserveSend(), isClosedStateError);
  }));

test("a clock that moved back to the previous day keeps today's count (never resets early)", () =>
  withGuard({}, async ({ guard, clock }) => {
    for (let sendIndex = 0; sendIndex < 3; sendIndex += 1) {
      await guard.reserveSend();
      clock.nowMs += 10000;
    }
    clock.nowMs = new Date(2026, 10, 17, 23, 0, 0).getTime();
    await assert.rejects(guard.reserveSend(), { kind: "rate_limited" });
    assert.equal((await guard.getUsage()).sends_today, 3);
  }));

test("cancellation during the interval wait propagates", () =>
  withGuard(
    {
      guardOptions: {
        clock: {
          now: () => NOV_18_NOON,
          sleep: async () => {
            throw Object.assign(new Error("cancelled"), { kind: "cancelled" });
          },
        },
      },
    },
    async ({ guard }) => {
      await guard.reserveSend();
      await assert.rejects(guard.reserveSend(), { kind: "cancelled" });
    },
  ));
