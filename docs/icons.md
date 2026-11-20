# Plugin icons

Every plugin has one icon, `<plugin>/icon.svg`, that the graphrt-builder-desktop Plugins screen shows next to the
plugin. The catalog links to it through each entry's `icon_url`.

## Adding or changing an icon
1. Install the generator's pinned packages once: `npm ci` at the repo root.
2. Add or edit the plugin's line in [`icons.json`](../icons.json):
   ```json
   "my-api": { "source": "simple-icons", "slug": "myapi" }
   ```
   or, for a glyph:
   ```json
   "my-tool": { "source": "lucide", "slug": "database" }
   ```
3. Run `npm run icons`. It writes `<plugin>/icon.svg` and fills in `version` and `color` in `icons.json`.
   `npm run icons:check` reports stale files without changing anything.
4. Commit `icons.json` and the icon. `npm test` checks that every plugin has exactly one icon, that it passes the
   SVG allowlist below, and that it is at most 8 KB.

The generator is deterministic: its output depends only on `icons.json` and the package versions pinned in the
root `package-lock.json`.

## Choosing the source
- **Brand plugins** use the brand's mark from [Simple Icons](https://simpleicons.org) (`source: "simple-icons"`,
  `slug` as listed on simpleicons.org), filled with the brand colour Simple Icons publishes.
- **No Simple Icons mark**: Simple Icons has removed some brands at their owners' request (for example LinkedIn,
  Slack, OpenAI, Salesforce, several Microsoft and AWS marks) and never had others. Do **not** copy a logo from the
  brand's website or another icon set. Use a [Lucide](https://lucide.dev) glyph for the category instead
  (`source: "lucide"`), drawn in the neutral accent `#64748B`.
- **Marks with their own licence**: some Simple Icons marks carry licence data of their own (for example MiniMax's
  custom terms). The generator refuses them; use a Lucide glyph.
- **Generic and local plugins** (files, shell, CSV, QR codes, RSS, email, browser, embeddings, ...) use a Lucide
  glyph.
- **Indonesian services** without a Simple Icons mark (BMKG, BPS, Midtrans, Xendit, Biteship, ...) use a Lucide
  category glyph (weather, chart, wallet, truck, ...).
- **Unofficial integrations** (`whatsapp-web`, `google-maps-scraper`) use a Lucide glyph even though the brand mark
  exists, so the icon does not suggest the brand endorses them.

## SVG allowlist
Icons are displayed by another app, so they are treated as untrusted markup. `scripts/lib/plugin-icons.mjs`
accepts only:

- elements: `svg` (root only), `g`, `path`, `circle`, `rect`, `line`, `polyline`, `polygon`;
- attributes: `xmlns` (the SVG namespace), `viewBox`, `width`, `height`, geometry (`d`, `cx`, `r`, `points`, ...)
  and presentation attributes (`fill`, `stroke`, `stroke-width`, `fill-rule`, `opacity`, ...), with colours as
  hex, `none` or `currentColor`;
- double-quoted values without `&`, `<`, `>`, and no text, comments, doctypes or processing instructions.

Scripts, `foreignObject`, `style` elements and attributes, `href`/`xlink:href`, `use`, `image`, event handlers and
`url(...)` references all fail the check. Lucide `ellipse` elements are converted to equivalent paths.

## How icons are published
Icons are not part of the plugin tarballs, so changing one never needs a plugin release. `publish-plugins.mjs`
(including `--catalog-only`) uploads each icon as an asset of the `catalog` release, named by its content:

```
https://github.com/<owner>/graphrt-plugins/releases/download/catalog/icon-<plugin>-<first 12 hex of sha256>.svg
```

A changed icon gets a new name, so an `icon_url` never changes meaning. Icons are uploaded before `index.json`, so
every URL in a live catalog resolves, and old icon assets are kept so that older catalogs keep working (a release
holds up to 1000 assets; prune unreferenced icons by hand if it ever gets close). `SHA256SUMS` lists the icons too.

## Licences and trademarks
- **Simple Icons** marks are distributed under [CC0 1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md).
  Version pinned in `package.json`; per-icon version in `icons.json`.
- **Lucide** glyphs are distributed under the ISC licence (a few, derived from Feather, under MIT). The full text
  is in [`LICENSES/lucide.txt`](../LICENSES/lucide.txt).
- **Trademarks:** brand names and marks belong to their owners. They are used only to identify the service a
  plugin integrates with and do not imply endorsement by, or affiliation with, the owner. Owners who want their
  mark removed can open an issue, and the plugin will switch to a Lucide glyph. Follow the brand's guidelines
  (linked from simpleicons.org) when you change how a mark is shown: do not recolour, distort or combine it.
