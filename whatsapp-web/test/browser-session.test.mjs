import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserSession } from "../lib/browser-session.mjs";
import { createFakeLauncher, createFakeTimers } from "./helpers.mjs";

async function withSession(sessionOptions, testBody) {
  const profileDirectory = await mkdtemp(join(tmpdir(), "wa-session-"));
  const launcher = createFakeLauncher();
  const timers = createFakeTimers();
  const session = createBrowserSession({ profileDirectory, idleTimeoutMs: 1000, launchPersistentContext: launcher, timers, ...sessionOptions });
  try {
    await testBody({ session, launcher, timers, profileDirectory });
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

test("the browser starts lazily, headless, on the profile directory, and is reused", () =>
  withSession({}, async ({ session, launcher, profileDirectory }) => {
    assert.equal(launcher.launches.length, 0);
    await session.run(async () => "first");
    const secondResult = await session.run(async () => "second");
    assert.equal(secondResult, "second");
    assert.equal(launcher.launches.length, 1);
    assert.equal(launcher.launches[0].profileDirectory, profileDirectory);
    assert.equal(launcher.launches[0].launchOptions.headless, true);
    assert.equal(launcher.launches[0].launchOptions.handleSIGTERM, false);
  }));

test("operations run one at a time in submission order", () =>
  withSession({}, async ({ session }) => {
    const events = [];
    const slowTask = async () => {
      events.push("slow:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("slow:end");
    };
    const fastTask = async () => events.push("fast");
    await Promise.all([session.run(slowTask), session.run(fastTask)]);
    assert.deepEqual(events, ["slow:start", "slow:end", "fast"]);
  }));

test("a failing operation does not block the next one", () =>
  withSession({}, async ({ session }) => {
    await assert.rejects(session.run(async () => {
      throw new Error("boom");
    }));
    assert.equal(await session.run(async () => "ok"), "ok");
  }));

test("the browser closes after the idle timeout and relaunches on demand", () =>
  withSession({}, async ({ session, launcher, timers }) => {
    await session.run(async () => {});
    assert.equal(timers.pending().length, 1);
    assert.equal(timers.pending()[0].delayMs, 1000);
    await timers.fireAll();
    assert.equal(launcher.contexts[0].closed, true);
    assert.equal(session.isOpen(), false);
    await session.run(async () => {});
    assert.equal(launcher.launches.length, 2);
  }));

test("a headed operation relaunches the browser with a window and closeAfter closes it", () =>
  withSession({}, async ({ session, launcher }) => {
    await session.run(async () => {});
    await session.run(async () => {}, { headed: true, closeAfter: true });
    assert.equal(launcher.launches.length, 2);
    assert.equal(launcher.launches[1].launchOptions.headless, false);
    assert.equal(launcher.contexts[0].closed, true);
    assert.equal(launcher.contexts[1].closed, true);
    assert.equal(session.isOpen(), false);
  }));

test("close() shuts the browser down", () =>
  withSession({}, async ({ session, launcher, timers }) => {
    await session.run(async () => {});
    await session.close();
    assert.equal(launcher.contexts[0].closed, true);
    assert.equal(timers.pending().length, 0);
  }));

test("a browser closed from outside is relaunched by the next operation", () =>
  withSession({}, async ({ session, launcher }) => {
    await session.run(async () => {});
    launcher.contexts[0].emit("close");
    await session.run(async () => {});
    assert.equal(launcher.launches.length, 2);
  }));

test("cancelling closes the page and reports cancelled", () =>
  withSession({}, async ({ session, launcher }) => {
    const controller = new AbortController();
    const pending = session.run(
      (page) =>
        new Promise((resolve, reject) => {
          page.onClose(() => reject(new Error("Target page, context or browser has been closed")));
          controller.abort();
        }),
      { signal: controller.signal },
    );
    await assert.rejects(pending, { kind: "cancelled" });
    assert.equal(launcher.contexts[0].pagesCreated[0].closed, true);
  }));

test("an already-aborted signal fails before launching", () =>
  withSession({}, async ({ session, launcher }) => {
    await assert.rejects(session.run(async () => {}, { signal: AbortSignal.abort() }), { kind: "cancelled" });
    assert.equal(launcher.launches.length, 0);
  }));

test("cancelling while the browser is still launching never runs the task", async () => {
  const controller = new AbortController();
  const fakeLauncher = createFakeLauncher();
  const abortingLauncher = async (...launchArguments) => {
    controller.abort();
    return fakeLauncher(...launchArguments);
  };
  await withSession({ launchPersistentContext: abortingLauncher }, async ({ session }) => {
    let didTaskRun = false;
    const pending = session.run(async () => {
      didTaskRun = true;
    }, { signal: controller.signal });
    await assert.rejects(pending, { kind: "cancelled" });
    assert.equal(didTaskRun, false, "a send must not start after the run was cancelled");
  });
});

test("a crashed tab is closed and replaced by a fresh page", () =>
  withSession({}, async ({ session, launcher }) => {
    let firstPage;
    await session.run(async (page) => {
      firstPage = page;
    });
    firstPage.emit("crash");
    let secondPage;
    await session.run(async (page) => {
      secondPage = page;
    });
    assert.notEqual(secondPage, firstPage);
    assert.equal(firstPage.closed, true, "the crashed page is closed");
    assert.equal(launcher.contexts[0].pagesCreated.length, 2);
  }));

test("a page that reports itself closed is not reused", () =>
  withSession({}, async ({ session, launcher }) => {
    let firstPage;
    await session.run(async (page) => {
      firstPage = page;
    });
    firstPage.isClosed = () => true; // still listed by the context, but dead
    let secondPage;
    await session.run(async (page) => {
      secondPage = page;
    });
    assert.notEqual(secondPage, firstPage);
    assert.equal(launcher.contexts[0].pagesCreated.length, 2);
  }));

test("a missing Chromium is reported as setup_required", () =>
  withSession(
    {
      launchPersistentContext: async () => {
        throw new Error("browserType.launchPersistentContext: Executable doesn't exist at /nope");
      },
    },
    async ({ session }) => {
      await assert.rejects(session.run(async () => {}), { kind: "setup_required" });
    },
  ));
