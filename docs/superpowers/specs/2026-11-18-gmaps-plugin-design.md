# Plugin `gmaps` — Design

Tanggal: 2026-11-18 · Status: disetujui

## Intent
Plugin graphrt yang membuka maps.google.com, mencari sebuah query, dan
mengembalikan nomor telepon (plus info dasar) dari hasil pencarian. Harus
**gratis**: tanpa API key / layanan berbayar.

## Goals
- Satu node `gmaps.search` + satu tool `gmaps_search` (untuk agent).
- Mendukung satu tempat maupun banyak bisnis via `max_results`.
- Gagal dengan jelas (bukan diam-diam kosong) saat diblokir/CAPTCHA.

## Non-goals
- Bypass CAPTCHA, rotasi proxy, atau anti-deteksi.
- Review, jam buka, foto, email.

## Constraints
- graphrt plugin = folder dengan `graphrt-plugin.json`; browser butuh
  `runtime: process` (WASM tanpa network).
- stdout dipakai protokol JSON-RPC; log hanya ke stderr.
- Scraping melanggar ToS Google, selector bisa berubah, volume tinggi
  memicu CAPTCHA — didokumentasikan di README.

## Approaches
1. **Playwright + Chromium headless (dipilih)** — gratis, merender JS Maps.
   Berat (~150 MB Chromium), rapuh terhadap perubahan UI.
2. Google Places API — stabil & resmi, tapi berbayar + API key. Ditolak: user
   mau gratis.
3. HTTP fetch HTML tanpa browser — ringan, tapi hasil Maps dirender lewat JS
   sehingga tidak andal. Ditolak.

## Design
- Lokasi: `gmaps/` di repo ini. Node.js ESM (`.mjs`) + JSDoc, tanpa build step
  (call saya: mengikuti template `node-uppercase`; SDK di-vendor sebagai
  `graphrt-plugin.mjs`).
- Config: `query` (string, wajib), `max_results` (int, default 20, 1–100),
  `language` (default `id`), `headless` (bool, default `true`).
- Output: `results` (array `{name, phone, address, website, rating, maps_url}`),
  `phones` (array string, non-null, unik), `count` (integer).
- Alur: buka `https://www.google.com/maps/search/<query>?hl=<language>` →
  terima consent jika muncul → jika langsung halaman tempat, ekstrak satu →
  jika daftar (`div[role=feed]`), scroll sampai `max_results` atau akhir daftar
  → buka tiap tempat, ekstrak detail dari tombol `data-item-id` (`phone:tel:`,
  `address`, `authority`).
- Progress `ctx.progress("place", {index, total, name})`; hormati `ctx.signal`.
- Error: CAPTCHA/`/sorry/` → `PluginError` kind `blocked`; input salah →
  `invalid_input`; browser tidak terpasang → `setup_required` dengan pesan cara
  install.
- Limits: `timeout_ms` 300000, `max_concurrency` 2.
- Logika parsing murni (normalisasi telepon, URL builder, ekstraksi dari
  atribut) dipisah dari kode Playwright agar bisa di-unit-test.

## Testing
- Unit test `node:test` untuk modul parsing murni.
- `example.yaml` untuk smoke test manual via `graphrt run --plugins .`.

## Left to the builder
- Selector detail persis, timing tunggu/scroll, struktur file internal.
