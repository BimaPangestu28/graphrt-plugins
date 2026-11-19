# libur-nasional operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `libur-nasional.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_holidays` | Indonesian national holidays (libur nasional) and cuti bersama of a year (2011 to next year), optionally one month or kind; each item has date, name, is_national_holiday and kind | year, month, kind |
| `check_date` | Whether a date (default: today in Asia/Jakarta) is a national holiday, cuti bersama, weekend or working day, with the holiday names | date |
| `next_holidays` | The next national holidays (and cuti bersama) from a date, across the year boundary, with how many days away each is | from_date, count, include_cuti_bersama |
| `count_working_days` | Working days (Monday-Friday minus national holidays and, by default, cuti bersama) between two dates, both included; at most 3 calendar years | **start_date**, **end_date**, cuti_bersama_is_day_off |
| `api_request` | Call any API Hari Libur endpoint that has no dedicated operation, e.g. path "/api/today". Only the API's own host is allowed. | method, **path**, query, body |
