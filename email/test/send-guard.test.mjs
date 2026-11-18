import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSendGuard } from "../lib/send-guard.mjs";

async function withStateFile(testBody) {
  const directory = await mkdtemp(join(tmpdir(), "email-guard-"));
  try {
    await testBody(join(directory, "nested", "state.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createClock(isoTime) {
  const clock = { current: new Date(isoTime).getTime(), now: () => clock.current };
  return clock;
}

test("counts recipients and refuses a message that would pass the cap", () =>
  withStateFile(async (stateFilePath) => {
    const guard = createSendGuard({ stateFilePath, dailyLimit: 5, clock: createClock("2026-11-18T10:00:00") });
    assert.deepEqual(await guard.reserveSend(3), { sends_today: 3, daily_limit: 5 });
    await assert.rejects(guard.reserveSend(3), { kind: "rate_limited", retryable: false, message: /3 of 5/ });
    assert.deepEqual(await guard.reserveSend(2), { sends_today: 5, daily_limit: 5 });
    const saved = JSON.parse(await readFile(stateFilePath, "utf8"));
    assert.equal(saved.count, 5);
    assert.equal(saved.day, "2026-11-18");
  }));

test("a limit of 0 disables sending", () =>
  withStateFile(async (stateFilePath) => {
    const guard = createSendGuard({ stateFilePath, dailyLimit: 0 });
    await assert.rejects(guard.reserveSend(1), { kind: "rate_limited" });
  }));

test("the count resets on a new local day but not when the clock moves back", () =>
  withStateFile(async (stateFilePath) => {
    const clock = createClock("2026-11-18T23:00:00");
    const guard = createSendGuard({ stateFilePath, dailyLimit: 2, clock });
    await guard.reserveSend(2);
    clock.current = new Date("2026-11-19T00:30:00").getTime();
    assert.equal((await guard.reserveSend(2)).sends_today, 2);
    clock.current = new Date("2026-11-18T12:00:00").getTime();
    await assert.rejects(guard.reserveSend(1), { kind: "rate_limited" });
  }));

for (const [caseName, content] of [
  ["invalid JSON", "{nope"],
  ["negative count", JSON.stringify({ day: "2026-11-18", count: -1, last_send_at: null })],
  ["missing day", JSON.stringify({ count: 1, last_send_at: null })],
]) {
  test(`fails closed on a corrupt state file (${caseName})`, () =>
    withStateFile(async (stateFilePath) => {
      const guard = createSendGuard({ stateFilePath, dailyLimit: 100 });
      await guard.reserveSend(1);
      await writeFile(stateFilePath, content);
      await assert.rejects(guard.reserveSend(1), { kind: "rate_limited", message: /cannot be used/ });
      assert.equal(await readFile(stateFilePath, "utf8"), content, "the corrupt file is left for the user to inspect");
    }));
}

test("concurrent reservations are serialised and cannot both pass the cap", () =>
  withStateFile(async (stateFilePath) => {
    const guard = createSendGuard({ stateFilePath, dailyLimit: 3 });
    const outcomes = await Promise.allSettled([guard.reserveSend(2), guard.reserveSend(2), guard.reserveSend(1)]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "rejected", "fulfilled"]);
    assert.equal((await guard.getUsage()).sends_today, 3);
  }));

test("two guard instances on one counter file never lose updates or pass the cap together", () =>
  withStateFile(async (stateFilePath) => {
    const firstGuard = createSendGuard({ stateFilePath, dailyLimit: 15 });
    const secondGuard = createSendGuard({ stateFilePath, dailyLimit: 15 });
    const attempts = Array.from({ length: 20 }, (unused, index) => (index % 2 ? firstGuard : secondGuard).reserveSend(1));
    const outcomes = await Promise.allSettled(attempts);
    const fulfilledCount = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
    assert.equal(fulfilledCount, 15);
    assert.equal(JSON.parse(await readFile(stateFilePath, "utf8")).count, 15);
  }));

const CHILD_RESERVE_SCRIPT = `
  const [modulePath, stateFilePath, attemptCount] = process.argv.slice(1);
  const { createSendGuard } = await import(modulePath);
  const guard = createSendGuard({ stateFilePath, dailyLimit: 25 });
  let reservedCount = 0;
  for (let attempt = 0; attempt < Number(attemptCount); attempt += 1) {
    try { await guard.reserveSend(1); reservedCount += 1; } catch (reserveError) { if (reserveError.retryable) throw reserveError; }
  }
  process.stdout.write(String(reservedCount));
`;

function runReservingChild(stateFilePath, attemptCount) {
  const modulePath = pathToFileURL(fileURLToPath(new URL("../lib/send-guard.mjs", import.meta.url))).href;
  const childArguments = ["--input-type=module", "-e", CHILD_RESERVE_SCRIPT, modulePath, stateFilePath, String(attemptCount)];
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(process.execPath, childArguments, (childError, stdout, stderr) =>
      childError ? rejectPromise(new Error(`${childError.message}\n${stderr}`)) : resolvePromise(Number(stdout)),
    );
  });
}

test("two processes sharing one counter file reserve exactly the cap in total", () =>
  withStateFile(async (stateFilePath) => {
    const reservedCounts = await Promise.all([runReservingChild(stateFilePath, 20), runReservingChild(stateFilePath, 20)]);
    assert.equal(reservedCounts[0] + reservedCounts[1], 25);
    assert.equal(JSON.parse(await readFile(stateFilePath, "utf8")).count, 25);
  }));

async function writeLockFile(stateFilePath, lockContent, modifiedAt) {
  await mkdir(dirname(stateFilePath), { recursive: true });
  const lockFilePath = `${stateFilePath}.lock`;
  await writeFile(lockFilePath, JSON.stringify(lockContent));
  if (modifiedAt) await utimes(lockFilePath, modifiedAt, modifiedAt);
  return lockFilePath;
}

test("a lock left by a dead process is taken over and released afterwards", () =>
  withStateFile(async (stateFilePath) => {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const lockFilePath = await writeLockFile(stateFilePath, { pid: deadPid, token: "old", boot_time_ms: Date.now() });
    const guard = createSendGuard({ stateFilePath, dailyLimit: 5, lockTimeoutMs: 2000 });
    assert.equal((await guard.reserveSend(1)).sends_today, 1);
    await assert.rejects(stat(lockFilePath), { code: "ENOENT" });
  }));

test("a lock written before the last boot is taken over even when its pid is alive now", () =>
  withStateFile(async (stateFilePath) => {
    await writeLockFile(stateFilePath, { pid: process.pid, token: "old", boot_time_ms: 1000 }, new Date(1000));
    const guard = createSendGuard({ stateFilePath, dailyLimit: 5, lockTimeoutMs: 2000 });
    assert.equal((await guard.reserveSend(1)).sends_today, 1);
  }));

test("a lock held by a live process times out as a retryable rate_limited error and is left alone", () =>
  withStateFile(async (stateFilePath) => {
    const lockFilePath = await writeLockFile(stateFilePath, { pid: process.pid, token: "someone-else", boot_time_ms: Date.now() });
    const guard = createSendGuard({ stateFilePath, dailyLimit: 5, lockTimeoutMs: 150 });
    await assert.rejects(guard.reserveSend(1), { kind: "rate_limited", retryable: true, message: /Nothing was sent/ });
    assert.equal(JSON.parse(await readFile(lockFilePath, "utf8")).token, "someone-else");
    await assert.rejects(readFile(stateFilePath, "utf8"), { code: "ENOENT" });
  }));
