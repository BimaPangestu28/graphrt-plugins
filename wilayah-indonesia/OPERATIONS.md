# wilayah-indonesia operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `wilayah-indonesia.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_provinces` | All 38 provinces of Indonesia with their 2-digit Kemendagri codes |  |
| `list_regencies` | Regencies (kabupaten) and cities (kota) of a province | **province_code** |
| `list_districts` | Districts (kecamatan) of a regency or city | **regency_code** |
| `list_villages` | Villages of a district: desa and kelurahan (type) with their 10-digit codes | **district_code** |
| `get_region` | One region by Kemendagri code (dots optional, e.g. 32.73.07.1001 or 3273071001): name, level, village type (desa/kelurahan), parents and full address | **code** |
| `search_regions` | Find provinces, regencies/cities, districts or villages by name (case and accent insensitive, every word must match), best matches first, with full addresses | **query**, level, within_code, limit |
