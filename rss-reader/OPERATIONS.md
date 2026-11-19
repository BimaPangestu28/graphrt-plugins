# rss-reader operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `rss-reader.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `read_feed` | Fetches an RSS 2.0, RSS 1.0, Atom or JSON Feed from a public https URL and returns the feed and its items in one normalised shape (title, link, dates, author, categories, plain-text summary, enclosures) | **url**, max_items, since, include_content, content_format, max_content_chars |
| `parse_feed` | Parses RSS, Atom or JSON Feed text you already have (e.g. from another node) into the same normalised shape as read_feed, without any network access | **content**, max_items, since, include_content, content_format, max_content_chars |
