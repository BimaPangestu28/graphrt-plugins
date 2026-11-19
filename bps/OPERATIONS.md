# bps operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `bps.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_domains` | BPS domains (national, provinces, regencies/cities) with their 4-digit domain_id, needed by every other operation | **domain_type**, province |
| `list_subject_categories` | Top-level subject categories of a domain (e.g. Sosial dan Kependudukan, Ekonomi dan Perdagangan) | **domain**, lang, cursor |
| `list_subjects` | Subjects of a domain (sub_id, title, category); filter by subject category | **domain**, lang, subject_category, cursor |
| `list_variables` | Variables (dynamic tables) of a domain with unit and subject; use var_id with get_dynamic_data | **domain**, lang, subject, year, own_domain_only, vertical_variable, cursor |
| `list_vertical_variables` | Row breakdowns (vervar, e.g. provinces or age groups) of a domain or of one variable | **domain**, lang, variable, cursor |
| `list_derived_variables` | Column breakdowns (turvar) of a domain or of one variable | **domain**, lang, variable, group, cursor |
| `list_periods` | Periods (th_id and year label) available for a variable; th_id goes into get_dynamic_data | **domain**, lang, variable, cursor |
| `list_derived_periods` | Sub-periods (turth: annual, months, quarters) of a variable | **domain**, lang, variable, cursor |
| `list_units` | Measurement units used by variables of a domain | **domain**, lang, cursor |
| `get_dynamic_data` | Values of one variable with labels: datacontent keys concatenate vervar + var + turvar + th + turth ids; read labels from vervar, turvar, tahun, turtahun | **domain**, **variable**, **periods**, lang, derived_variable, vertical_variable, derived_periods |
| `list_static_tables` | Published static tables of a domain (table_id, title, subject, update date, Excel link) | **domain**, lang, month, year, keyword, cursor |
| `get_static_table` | One static table; its HTML table is in `table` | **domain**, **lang**, **item_id** |
| `list_strategic_indicators` | Headline indicators (inflation, unemployment, growth, ...) with their latest value; national and province domains only | **domain**, lang, variable, cursor |
| `get_foreign_trade` | Export or import value (USD) and net weight (kg) by HS code, port and country for a year | **trade_flow**, **period_type**, **hs_codes**, **hs_code_type**, **year** |
| `list_press_releases` | Official statistical news releases (BRS) of a domain | **domain**, lang, month, year, keyword, cursor |
| `get_press_release` | One press release with abstract, release date and PDF link | **domain**, **lang**, **item_id** |
| `list_publications` | Publications of a domain (statistical yearbooks, reports) with PDF links | **domain**, lang, month, year, keyword, cursor |
| `get_publication` | One publication with catalogue numbers, ISSN, abstract and PDF link | **domain**, **lang**, **item_id** |
| `search_content` | Full-text search of one kind of content (tables, publications, press releases, news, infographics) in a domain | **domain**, **content_type**, keyword, from_date, to_date, classification, lang, cursor, limit |
| `list_glossary` | Statistical concepts and definitions (Indonesian and English), optionally those starting with a letter | prefix, cursor, limit |
| `list_classifications` | Items of the KBLI (industry, 2009-2020) or KBKI (products, 2015) classifications | **classification**, level, cursor, limit |
| `api_request` | Call any BPS Web API endpoint that has no dedicated operation, e.g. path "/v1/api/list/model/infographic/domain/0000". Only the API's own host is allowed. | method, **path**, query, body |
