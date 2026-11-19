# web-search operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `web-search.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `search` | Search the web; returns {provider, query, answer, results: [{title, url, snippet, published_at, source}]} (paid per query) | **query**, max_results, country, language, freshness, include_answer |
| `search_news` | Search recent news articles; same result shape as search (paid per query) | **query**, max_results, country, language, freshness, include_answer |
