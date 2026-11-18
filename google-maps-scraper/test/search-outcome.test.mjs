import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForSearchOutcome } from "../lib/search-outcome.mjs";

const SEARCH_URL = "https://www.google.com/maps/search/x";
const EMPTY_PROBE = { hasFeed: false, hasPlaceMarker: false, hasCaptcha: false, bodyText: "" };

/** Fake page whose probe returns each state in turn, repeating the last one. */
function createFakePage(probeStates) {
  const fakePage = {
    probeCount: 0,
    currentState: () => probeStates[Math.min(fakePage.probeCount, probeStates.length - 1)],
    url: () => fakePage.currentState().pageUrl ?? SEARCH_URL,
    async evaluate() {
      const probeState = fakePage.currentState();
      fakePage.probeCount += 1;
      return { ...EMPTY_PROBE, ...probeState };
    },
  };
  return fakePage;
}

const fastTiming = { timeoutMs: 200, pollMs: 1 };

test("waitForSearchOutcome keeps waiting past a bare header until the feed appears", async () => {
  const fakePage = createFakePage([{ bodyText: "Results" }, { bodyText: "Results" }, { hasFeed: true }]);
  assert.equal(await waitForSearchOutcome(fakePage, fastTiming), "results");
  assert.equal(fakePage.probeCount, 3);
});

test("waitForSearchOutcome reports a single place from the /maps/place/ URL", async () => {
  const fakePage = createFakePage([{}, { pageUrl: "https://www.google.com/maps/place/Braga" }]);
  assert.equal(await waitForSearchOutcome(fakePage, fastTiming), "single_place");
});

test("waitForSearchOutcome returns no_results quickly", async () => {
  const fakePage = createFakePage([{ bodyText: "Google Maps can't find zzqq" }]);
  const startedAt = Date.now();
  assert.equal(await waitForSearchOutcome(fakePage, { timeoutMs: 5000, pollMs: 1 }), "no_results");
  assert.ok(Date.now() - startedAt < 1000);
});

test("waitForSearchOutcome reports blocked on a CAPTCHA element", async () => {
  const fakePage = createFakePage([{ hasCaptcha: true }]);
  assert.equal(await waitForSearchOutcome(fakePage, fastTiming), "blocked");
});

test("waitForSearchOutcome returns timeout when nothing recognisable appears", async () => {
  const fakePage = createFakePage([{ bodyText: "loading" }]);
  assert.equal(await waitForSearchOutcome(fakePage, { timeoutMs: 20, pollMs: 1 }), "timeout");
});

test("waitForSearchOutcome treats a probe failure mid-navigation as not decided yet", async () => {
  let probeCount = 0;
  const fakePage = {
    url: () => SEARCH_URL,
    async evaluate() {
      probeCount += 1;
      if (probeCount === 1) throw new Error("Execution context was destroyed");
      return { ...EMPTY_PROBE, hasFeed: true };
    },
  };
  assert.equal(await waitForSearchOutcome(fakePage, fastTiming), "results");
});

test("waitForSearchOutcome stops when the signal aborts", async () => {
  const fakePage = createFakePage([{ bodyText: "loading" }]);
  await assert.rejects(
    waitForSearchOutcome(fakePage, { timeoutMs: 5000, pollMs: 1, signal: AbortSignal.abort() }),
    (error) => error.kind === "cancelled",
  );
});
