# news-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `news-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `search_articles` | Search news articles and blog posts (title, description, url, source, author, publishedAt, content truncated to 200 chars) | query, search_in, sources, domains, exclude_domains, from, to, language, sort_by, cursor, limit |
| `get_top_headlines` | Breaking headlines by country, category, source or keyword (sources cannot be combined with country or category) | country, category, sources, query, cursor, limit |
| `list_sources` | Sources that publish top headlines: id, name, description, url, category, language, country | category, language, country |
| `api_request` | Call any NewsAPI endpoint that has no dedicated operation, e.g. path "/v2/top-headlines?country=us". Only the API's own host is allowed. | method, **path**, query, body |
