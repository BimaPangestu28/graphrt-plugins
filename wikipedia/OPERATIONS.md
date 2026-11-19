# wikipedia operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `wikipedia.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `search_pages` | Full-text search: title, pageid, snippet (HTML with <span class=searchmatch>), wordcount and timestamp of matching articles | **query**, cursor, limit, language |
| `get_page_summary` | Short summary of a page: title, description, extract (plain text lead), thumbnail, coordinates and URLs | **page_title**, language |
| `get_page_content` | The article as plain text (section headings as lines), capped at max_chars: {pageid, title, extract, truncated, total_chars} | **page_title**, intro_only, language, max_chars |
| `get_page_media` | Images, audio and video used on a page: title (File:...), type, caption and srcset thumbnail URLs | **page_title**, language |
| `search_nearby_pages` | Articles with coordinates near a point, nearest first: title, pageid, lat, lon, dist (meters) | **coordinates**, radius_meters, limit, language |
| `get_page_languages` | The same article in other Wikipedias: langlinks [{lang, title, url}]; next_cursor when there are more than limit | **page_title**, cursor, limit, language |
| `api_request` | Call any Wikipedia (MediaWiki Action and REST v1 APIs) endpoint that has no dedicated operation, e.g. path "/w/api.php?action=query&list=random&rnnamespace=0&format=json". Only the API's own host is allowed. | method, **path**, query, body |
