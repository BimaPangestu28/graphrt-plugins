import { test } from "node:test";
import assert from "node:assert/strict";
import {
  communityReleaseTagFor, expectedTarballUrl, findCommunityEntryProblems, findCommunityPluginProblems, listRepoDirectoryNames, readCommunityPlugins,
  versionFromTag, withPendingReviewStandIns,
} from "../lib/community-plugins.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPluginNames } from "../lib/plugin-package.mjs";
import { REPO_ROOT } from "../plugins.mjs";
import { renderCommunityReleaseNotes } from "../lib/community-ingest.mjs";

const OFFICIAL_NAMES = ["currency-rates", "github", "shared", "scripts", "community-legacy"];

function validEntry(overrides = {}) {
  return {
    repository_url: "https://github.com/acme/graphrt-acme-crm",
    tag: "v1.2.0",
    tarball_url: "https://github.com/acme/graphrt-acme-crm/releases/download/v1.2.0/acme-crm-1.2.0.tar.gz",
    tarball_sha256: "a".repeat(64),
    publisher: "Acme Inc.",
    display_name: "Acme CRM",
    status: "beta",
    status_reason: "Official Acme API; reviewed at v1.2.0, checked live with an invalid key only.",
    tos_risk: "none",
    reviewed_by: "a-maintainer",
    reviewed_at: "2026-11-20",
    ...overrides,
  };
}

function problemsOf(entryOverrides, pluginName = "acme-crm") {
  return findCommunityEntryProblems(pluginName, validEntry(entryOverrides), OFFICIAL_NAMES);
}

test("the committed registry is valid and starts empty", () => {
  const registry = readCommunityPlugins();
  assert.deepEqual(findCommunityPluginProblems(registry, listRepoDirectoryNames()), []);
  assert.deepEqual(registry, {});
});

test("no official plugin is named community-*: that prefix is the mirror release namespace", () => {
  assert.deepEqual(listPluginNames().filter((pluginName) => pluginName.startsWith("community-")), []);
});

test("accepts a complete entry, with or without tos_notes", () => {
  assert.deepEqual(problemsOf({}), []);
  assert.deepEqual(problemsOf({ tos_risk: "medium", tos_notes: "Acme forbids bulk export; the plugin caps reads at 100 rows." }), []);
  assert.deepEqual(problemsOf({ tag: "1.2.0", tarball_url: "https://github.com/acme/graphrt-acme-crm/releases/download/1.2.0/acme-crm-1.2.0.tar.gz" }), []);
});

test("derives the version, mirror tag and expected tarball URL from the tag", () => {
  assert.equal(versionFromTag("v1.2.0"), "1.2.0");
  assert.equal(versionFromTag("0.3.1-beta.2"), "0.3.1-beta.2");
  assert.equal(versionFromTag("release-1.2"), null);
  assert.equal(communityReleaseTagFor("acme-crm", "1.2.0"), "community-acme-crm-v1.2.0");
  assert.equal(expectedTarballUrl("acme-crm", validEntry()), validEntry().tarball_url);
});

test("rejects invalid names and names that collide with this repo", () => {
  for (const badName of ["Acme", "acme_crm", "-acme", "acme--crm", "a".repeat(65), "acme/crm", ""]) {
    assert.match(problemsOf({}, badName).join("\n"), /name must be lowercase/, badName);
  }
  assert.match(problemsOf({}, "currency-rates").join("\n"), /collides with an official plugin/);
  assert.match(problemsOf({}, "shared").join("\n"), /collides with an official plugin or directory/);
  assert.match(problemsOf({}, "legacy").join("\n"), /collides with the official plugin community-legacy/);
});

test("requires every field, refuses unknown ones and non-strings", () => {
  const entry = validEntry();
  delete entry.reviewed_by;
  assert.match(findCommunityEntryProblems("acme-crm", entry, OFFICIAL_NAMES).join("\n"), /missing `reviewed_by`/);
  assert.match(problemsOf({ homepage: "https://acme.example" }).join("\n"), /unknown field `homepage`/);
  assert.match(problemsOf({ tarball_sha256: 42 }).join("\n"), /`tarball_sha256` must be a string/);
  assert.match(problemsOf({ publisher: "  Acme" }).join("\n"), /surrounding whitespace/);
  assert.match(problemsOf({ display_name: "" }).join("\n"), /non-empty/);
  assert.match(findCommunityEntryProblems("acme-crm", ["not", "an", "object"], OFFICIAL_NAMES).join("\n"), /entry must be an object/);
  assert.deepEqual(findCommunityPluginProblems([], OFFICIAL_NAMES), ["community-plugins.json must hold a JSON object"]);
});

test("enforces length limits and printable text", () => {
  assert.match(problemsOf({ publisher: "A".repeat(61) }).join("\n"), /`publisher` is longer than 60/);
  assert.match(problemsOf({ display_name: "A".repeat(61) }).join("\n"), /`display_name` is longer than 60/);
  assert.match(problemsOf({ status_reason: "x".repeat(501) }).join("\n"), /`status_reason` is longer than 500/);
  assert.match(problemsOf({ tos_risk: "high", tos_notes: "x".repeat(2001) }).join("\n"), /`tos_notes` is longer than 2000/);
  assert.match(problemsOf({ display_name: "Acme‮MRC" }).join("\n"), /control or bidi/);
  assert.match(problemsOf({ status_reason: "line\nbreak" }).join("\n"), /control or bidi/);
});

test("requires https GitHub repository URLs and a tarball that is a release asset of that repository and tag", () => {
  assert.match(problemsOf({ repository_url: "http://github.com/acme/graphrt-acme-crm" }).join("\n"), /repository_url must be https:\/\/github.com/);
  assert.match(problemsOf({ repository_url: "https://gitlab.com/acme/graphrt-acme-crm" }).join("\n"), /repository_url must be/);
  assert.match(problemsOf({ repository_url: "https://github.com/acme/graphrt-acme-crm.git" }).join("\n"), /no .git suffix/);
  assert.match(problemsOf({ repository_url: "https://github.com/acme/graphrt-acme-crm/" }).join("\n"), /repository_url must be/);
  const wrongRepository = problemsOf({ tarball_url: "https://github.com/evil/fork/releases/download/v1.2.0/acme-crm-1.2.0.tar.gz" });
  assert.match(wrongRepository.join("\n"), /tarball_url must be the release asset of the tag in repository_url/);
  assert.match(problemsOf({ tarball_url: "https://github.com/acme/graphrt-acme-crm/releases/download/v1.1.0/acme-crm-1.1.0.tar.gz" }).join("\n"), /tarball_url must be/);
  assert.match(problemsOf({ tarball_url: "http://github.com/acme/graphrt-acme-crm/releases/download/v1.2.0/acme-crm-1.2.0.tar.gz" }).join("\n"), /tarball_url must be https/);
  assert.match(problemsOf({ tag: "latest" }).join("\n"), /tag `latest` must be v<semver>/);
});

test("requires a 64-hex sha256", () => {
  assert.match(problemsOf({ tarball_sha256: "A".repeat(64) }).join("\n"), /64 lowercase hex/);
  assert.match(problemsOf({ tarball_sha256: "a".repeat(63) }).join("\n"), /64 lowercase hex/);
  assert.match(problemsOf({ tarball_sha256: "g".repeat(64) }).join("\n"), /64 lowercase hex/);
});

test("applies the plugin-status.json rules to status and ToS labels", () => {
  assert.match(problemsOf({ status: "alpha" }).join("\n"), /status `alpha` must be one of stable, beta, experimental/);
  assert.match(problemsOf({ tos_risk: "extreme" }).join("\n"), /tos_risk `extreme` must be one of/);
  assert.match(problemsOf({ tos_risk: "medium" }).join("\n"), /tos_risk medium needs tos_notes/);
  assert.match(problemsOf({ tos_risk: "high" }).join("\n"), /tos_risk high needs tos_notes/);
});

test("blocks every spoofing string of the audit's probe-registry.mjs", () => {
  const probes = {
    "publisher Cyrillic a": { publisher: "Gr\u0430phRT" },
    "publisher ZWSP": { publisher: "graph\u200brt" },
    "publisher RLM": { publisher: "Acme\u200f" },
    "display ALM U+061C": { display_name: "X\u061c" },
    "display LS U+2028": { display_name: "X\u2028Y" },
    "display BOM": { display_name: "X\ufeff" },
    "publisher markdown link": { publisher: "[Official team](https://evil.example)" },
    "display html": { display_name: "<img src=x onerror=alert(1)>" },
    "display RLO": { display_name: "X\u202e" },
    "status_reason zero-width": { status_reason: "Fine\u200b" },
  };
  for (const [label, overrides] of Object.entries(probes)) {
    assert.ok(problemsOf(overrides).length > 0, `${label} must be blocked`);
  }
});

test("publisher and display_name are printable ASCII without markup and never claim to be official or graphrt", () => {
  for (const publisher of ["Acme `team`", "Acme <x>", "Acme (official)", "Acme [x]", "Acme\u00e9", "OFFICIAL builds", "The Graphrt team", "\uff27raphRT"]) {
    assert.ok(problemsOf({ publisher }).length > 0, `publisher ${JSON.stringify(publisher)} must be refused`);
  }
  assert.match(problemsOf({ display_name: "Official Stripe" }).join("\n"), /display_name must not contain "official" or "graphrt"/);
  assert.match(problemsOf({ display_name: "graphRT CRM" }).join("\n"), /must not contain "official" or "graphrt"/);
  assert.match(problemsOf({ publisher: "Acme <x>" }).join("\n"), /publisher must be printable ASCII without < > \[ \] \( \) or backticks/);
  assert.deepEqual(problemsOf({ publisher: "Acme Inc. & Partners", display_name: "Acme CRM: Contacts / Deals" }), []);
});

test("mirror release notes escape the publisher and display name", () => {
  const notes = renderCommunityReleaseNotes("acme-crm", validEntry({ publisher: "Acme *bold* @someone", display_name: "Acme_CRM #1" }), "1.2.0", "b".repeat(64));
  assert.match(notes, /\*\*Acme\\_CRM \\#1\*\*/);
  assert.match(notes, /published by Acme \\\*bold\\\* \\@someone\./);
});

test("checks the publisher and the review record", () => {
  assert.match(problemsOf({ publisher: "GraphRT Labs" }).join("\n"), /publisher must not contain "official" or "graphrt"/);
  assert.match(problemsOf({ reviewed_by: "not a login" }).join("\n"), /reviewed_by must be/);
  assert.match(problemsOf({ reviewed_at: "2026-02-30" }).join("\n"), /reviewed_at `2026-02-30` must be a date/);
  assert.match(problemsOf({ reviewed_at: "20/11/2026" }).join("\n"), /must be a date/);
});

test("refuses entries still pending review, and offers stand-ins only for a contributor's own check", () => {
  const pendingProblems = problemsOf({ reviewed_by: "pending", reviewed_at: "pending" });
  assert.deepEqual(pendingProblems, ["acme-crm: not reviewed yet (a maintainer sets reviewed_by and reviewed_at before merging)"]);
  const pendingEntry = validEntry({ reviewed_by: "pending", reviewed_at: "pending" });
  assert.deepEqual(findCommunityEntryProblems("acme-crm", withPendingReviewStandIns(pendingEntry), OFFICIAL_NAMES), []);
  const reviewedEntry = validEntry();
  assert.equal(withPendingReviewStandIns(reviewedEntry), reviewedEntry);
});

test("the registry check is strict for pull requests and lenient, with error annotations, for the release flow", () => {
  const scratchDirectory = mkdtempSync(join(tmpdir(), "community-check-test-"));
  try {
    const registryPath = join(scratchDirectory, "community-plugins.json");
    writeFileSync(registryPath, JSON.stringify({ "acme-crm": validEntry({ tag: "latest" }) }));
    const checkScript = join(REPO_ROOT, "scripts", "check-community-plugins.mjs");
    const strict = spawnSync(process.execPath, [checkScript, "--registry", registryPath], { encoding: "utf8" });
    assert.equal(strict.status, 1);
    assert.match(strict.stderr, /is invalid:\n {2}acme-crm: tag `latest` must be v<semver>/);
    const lenient = spawnSync(process.execPath, [checkScript, "--lenient", "--registry", registryPath], { encoding: "utf8" });
    assert.equal(lenient.status, 0);
    assert.match(lenient.stdout, /^::error title=community-plugins.json::acme-crm: tag `latest` must be v<semver>.* \(the publish skips this entry\)$/m);
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
});

test("npm run check stays strict and the release flow uses the lenient check:release", () => {
  const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.match(scripts.check, /check-community-plugins\.mjs$/);
  assert.match(scripts["check:release"], /check-community-plugins\.mjs --lenient$/);
  const workflowDirectory = join(REPO_ROOT, ".github", "workflows");
  assert.match(readFileSync(join(workflowDirectory, "release.yml"), "utf8"), /run: npm run check:release/);
  assert.match(readFileSync(join(workflowDirectory, "ci.yml"), "utf8"), /run: npm run check\n/);
});
