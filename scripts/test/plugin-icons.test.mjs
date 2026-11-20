import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ICON_FILE_NAME, ICON_SOURCES, MAX_ICON_BYTES, findIconProblems, iconAssetNameFor, readIconSources, readPluginIcon,
} from "../lib/plugin-icons.mjs";
import { listPluginNames } from "../lib/plugin-package.mjs";
import { NEUTRAL_ACCENT_COLOR, renderLucideIcon, renderSimpleIcon } from "../generate-icons.mjs";
import { REPO_ROOT } from "../plugins.mjs";

const SAFE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#181717"><path d="M12 .3c-6.6 0-12 5.4-12 12z"/></svg>\n';

test("accepts plain shapes with presentation attributes", () => {
  assert.deepEqual(findIconProblems(SAFE_ICON), []);
  const strokedIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="2" stroke-linecap="round">'
    + '<g><circle cx="12" cy="12" r="10"/><rect width="16" height="12" x="4" y="8" rx="2"/><line x1="1" y1="2" x2="3" y2="4"/>'
    + '<polyline points="1 2 3 4"/><polygon points="1,2 3,4 5,6" fill-rule="evenodd"/></g></svg>';
  assert.deepEqual(findIconProblems(strokedIcon), []);
});

test("rejects scripts, foreign content, links, styles, handlers and external references", () => {
  const wrap = (inner, rootAttributes = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${rootAttributes}>${inner}</svg>`;
  const unsafeIcons = {
    script: wrap("<script>alert(1)</script>"),
    "self-closing script": wrap('<script href="https://example.test/x.js"/>'),
    foreignObject: wrap("<foreignObject><div/></foreignObject>"),
    "style element": wrap("<style>path{fill:red}</style>"),
    "style attribute": wrap('<path d="M0 0" style="fill:red"/>'),
    href: wrap('<path d="M0 0" href="https://example.test"/>'),
    "xlink:href": wrap('<path d="M0 0" xlink:href="#a"/>'),
    use: wrap('<use href="#a"/>'),
    image: wrap('<image href="https://example.test/a.png"/>'),
    "event handler": wrap('<path d="M0 0" onclick="alert(1)"/>'),
    "onload on root": wrap('<path d="M0 0"/>', ' onload="alert(1)"'),
    "url() fill": wrap('<path d="M0 0" fill="url(https://example.test/#g)"/>'),
    "url() in geometry": wrap('<path d="M0 0 url(#x)"/>'),
    "javascript colour": wrap('<path d="M0 0" fill="javascript:alert(1)"/>'),
    comment: wrap('<!-- hi --><path d="M0 0"/>'),
    "xml declaration": `<?xml version="1.0"?>${wrap('<path d="M0 0"/>')}`,
    doctype: `<!DOCTYPE svg [<!ENTITY x "y">]>${wrap('<path d="M0 0"/>')}`,
    entity: wrap('<path d="&x;"/>'),
    text: wrap("hello"),
    "single-quoted attribute": wrap("<path d='M0 0'/>"),
    "unknown attribute": wrap('<path d="M0 0" filter="blur"/>'),
    "wrong namespace": '<svg xmlns="http://example.test/svg" viewBox="0 0 24 24"/>',
    "no viewBox": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    "nested svg": wrap('<svg viewBox="0 0 1 1"/>'),
    "two roots": `${wrap("")}${wrap("")}`,
    "non-svg root": '<path d="M0 0"/>',
    unclosed: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g>',
    mismatched: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g></path></svg>',
    "repeated attribute": wrap('<path d="M0 0" d="M1 1"/>'),
    empty: "",
  };
  for (const [caseName, svgText] of Object.entries(unsafeIcons)) {
    assert.notDeepEqual(findIconProblems(svgText), [], caseName);
  }
});

test("names icon assets by plugin and content hash", () => {
  const assetName = iconAssetNameFor("meta-api", Buffer.from(SAFE_ICON));
  assert.match(assetName, /^icon-meta-api-[0-9a-f]{12}\.svg$/);
  assert.equal(iconAssetNameFor("meta-api", Buffer.from(SAFE_ICON)), assetName);
  assert.notEqual(iconAssetNameFor("meta-api", Buffer.from(`${SAFE_ICON} `)), assetName);
});

test("every plugin has exactly one safe, small icon.svg and an icons.json entry", () => {
  const pluginNames = listPluginNames();
  assert.ok(pluginNames.length > 100, "expected the full plugin list");
  for (const pluginName of pluginNames) {
    const icon = readPluginIcon(pluginName);
    assert.ok(icon.bytes.length <= MAX_ICON_BYTES, pluginName);
    const iconFiles = readdirSync(join(REPO_ROOT, pluginName)).filter((fileName) => /^(icon|logo)\b/i.test(fileName));
    assert.deepEqual(iconFiles, [ICON_FILE_NAME], `${pluginName} must have exactly one icon file`);
  }
  const iconSources = readIconSources();
  assert.deepEqual(Object.keys(iconSources).sort(), pluginNames, "icons.json must list exactly the plugins");
  for (const [pluginName, entry] of Object.entries(iconSources)) {
    assert.ok(ICON_SOURCES.includes(entry.source), pluginName);
    assert.match(entry.slug, /^[a-z0-9-]+$/, pluginName);
    assert.match(entry.version, /^\d+\.\d+\.\d+$/, pluginName);
    assert.match(entry.color, /^#[0-9A-F]{6}$/i, pluginName);
    const fillOrStroke = entry.source === "simple-icons" ? `fill="${entry.color}"` : `stroke="${entry.color}"`;
    assert.ok(readFileSync(join(REPO_ROOT, pluginName, ICON_FILE_NAME), "utf8").includes(fillOrStroke), `${pluginName} icon uses ${entry.color}`);
  }
});

test("rejects a missing or unsafe icon with the plugin name", () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "plugin-icons-"));
  try {
    assert.throws(() => readPluginIcon("ghost", repositoryRoot), /ghost: no icon\.svg/);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("renders Simple Icons marks and Lucide glyphs that pass the allowlist", () => {
  const brandIcon = renderSimpleIcon({ hex: "181717", path: "M0 0h24v24H0z" });
  assert.equal(brandIcon, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#181717"><path d="M0 0h24v24H0z"/></svg>\n');
  const lucideNode = [
    ["ellipse", { cx: "12", cy: "5", rx: "9", ry: "3" }],
    ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2", class: "dropped" }],
    ["circle", { cx: "7.5", cy: "7.5", r: ".5", fill: "currentColor" }],
  ];
  const glyph = renderLucideIcon(lucideNode, NEUTRAL_ACCENT_COLOR);
  assert.ok(glyph.includes('<path d="M3 5a9 3 0 1 0 18 0a9 3 0 1 0 -18 0"/>'), "ellipse becomes a path");
  assert.ok(glyph.includes('<rect width="16" height="12" x="4" y="8" rx="2"/>'), "non-geometry attributes are dropped");
  assert.ok(glyph.includes(`<circle cx="7.5" cy="7.5" r=".5" fill="${NEUTRAL_ACCENT_COLOR}"/>`), "currentColor takes the stroke colour");
  assert.deepEqual(findIconProblems(brandIcon), []);
  assert.deepEqual(findIconProblems(glyph), []);
});
