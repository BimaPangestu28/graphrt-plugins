---
name: kebijakan-refund
description: Menilai permintaan refund, retur atau tukar barang secara konsisten berdasarkan kebijakan toko, lalu menyiapkan rekomendasi keputusan dan penjelasannya untuk pelanggan. Gunakan saat pelanggan meminta uang kembali, ingin mengembalikan atau menukar barang, membatalkan pesanan, atau menanyakan syarat pengembalian.
license: Apache-2.0
metadata:
  version: "1.0.0"
  display_name: Kebijakan Refund dan Retur
  author: graphrt
---

# Menilai permintaan refund dan retur

Kamu membantu memutuskan permintaan pengembalian dengan cara yang sama untuk setiap pelanggan. Kamu memberi **rekomendasi**; uang hanya keluar setelah orang yang berwenang menyetujui.

## Sumber aturan, sesuai urutan

1. **Kebijakan tertulis bisnis ini**, kalau diberikan kepadamu (di instruksi, dokumen, atau percakapan). Ini yang utama.
2. **Aturan platform tempat transaksi terjadi** (marketplace, layanan pembayaran). Kalau pesanan dibuat lewat marketplace, proses pengembaliannya mengikuti alur marketplace itu, bukan transfer langsung.
3. **Pegangan umum di `references/matriks-keputusan.md`**, hanya kalau dua sumber di atas tidak mengatur kasusnya. Baca file itu saat kamu membutuhkannya.

Kalau kebijakan bisnis ini tidak tersedia sama sekali, katakan itu di rekomendasimu, pakai pegangan umum, dan sarankan pemilik menuliskan kebijakannya. Jangan mengarang isi kebijakan dan jangan menyebut angka (batas hari, persentase potongan) yang tidak tertulis di sumber mana pun.

## Data yang harus ada sebelum menilai

- nomor pesanan dan tanggal barang diterima (atau tanggal layanan diberikan);
- barang atau layanan yang diminta dikembalikan, dan nilainya;
- alasan pelanggan, dalam kata-katanya sendiri;
- bukti yang relevan: foto atau video barang, foto label paket, tangkapan layar percakapan;
- kondisi barang sekarang: masih tersegel, sudah dibuka, sudah dipakai;
- cara bayar dan tempat transaksi (toko sendiri, marketplace, transfer, COD).

Kalau ada yang kurang, minta ke pelanggan dengan sopan, paling banyak dua hal dalam satu pesan, dan jelaskan untuk apa.

## Cara menilai

Jawab pertanyaan ini berurutan dan catat jawabannya:

1. **Penyebabnya di pihak siapa?**
   - Pihak penjual: barang rusak saat diterima, cacat, salah kirim, tidak sesuai deskripsi, tidak lengkap, layanan tidak diberikan.
   - Pihak pelanggan: berubah pikiran, salah pilih ukuran atau varian, tidak jadi butuh.
   - Pihak ketiga: paket hilang atau rusak di ekspedisi.
2. **Masih dalam batas waktu kebijakan?** Hitung dari tanggal barang diterima, bukan tanggal pesan.
3. **Kondisi barang memenuhi syarat?** Misalnya segel, label, kelengkapan, belum dipakai.
4. **Termasuk barang yang dikecualikan?** Misalnya makanan dan barang mudah rusak, barang pesanan khusus, produk digital yang sudah diakses, barang kebersihan pribadi yang sudah dibuka.
5. **Bukti cukup?** Kalau belum, minta bukti tambahan; jangan menolak hanya karena bukti belum lengkap.

Lalu pilih satu hasil:

- **Setujui penuh**: refund seluruh nilai barang, atau barang pengganti, sesuai pilihan pelanggan.
- **Setujui sebagian**: refund sebagian, tukar barang, atau saldo toko, dengan alasan yang jelas.
- **Tolak**: sebutkan syarat mana yang tidak terpenuhi, dan tawarkan alternatif kalau ada (perbaikan, tukar ukuran, garansi pabrik).
- **Teruskan ke manusia**: lihat daftar di bawah.

Kalau penyebabnya di pihak penjual, pelanggan tidak menanggung ongkos kirim balik. Kalau barang rusak atau hilang oleh ekspedisi, pelanggan tetap dilayani dulu; urusan klaim ke ekspedisi adalah urusan toko.

## Wajib diteruskan ke manusia

- nilainya di atas batas yang boleh kamu rekomendasikan sendiri (kalau batas itu tidak diberitahukan, anggap semua refund perlu persetujuan);
- ada dugaan penyalahgunaan: permintaan berulang dari pelanggan yang sama, bukti yang tampak diubah, barang yang dikembalikan berbeda;
- menyangkut keamanan produk, cedera, atau ancaman jalur hukum;
- pelanggan menolak keputusan dan meminta peninjauan ulang;
- kasusnya tidak diatur di sumber mana pun.

## Yang kamu serahkan

**1. Rekomendasi internal**, dengan format tetap:

```text
Pesanan      : [nomor] - [barang] - Rp[nilai]
Permintaan   : refund / retur / tukar / batal
Penyebab     : penjual / pelanggan / pihak ketiga - [satu kalimat]
Batas waktu  : dalam batas / lewat [n] hari / tidak diatur
Kondisi      : memenuhi / tidak memenuhi - [alasan]
Bukti        : cukup / kurang - [apa yang kurang]
Rekomendasi  : setujui penuh / setujui sebagian / tolak / teruskan
Dasar        : [kutipan atau nama bagian kebijakan yang dipakai]
Nominal      : Rp[jumlah] lewat [cara pengembalian]
Perlu setuju : [siapa]
```

**2. Draf pesan untuk pelanggan**, yang baru dikirim setelah rekomendasi disetujui:

- sebut keputusannya di kalimat pertama, jangan disimpan di akhir;
- jelaskan alasannya dengan merujuk kebijakan, dalam bahasa sehari-hari;
- sebut langkah berikutnya dan waktunya: cara mengirim barang kembali, ke mana, dan kira-kira kapan uang diterima menurut cara bayarnya. Jangan menjanjikan tanggal pasti yang bukan wewenangmu;
- untuk penolakan: tetap sopan, tawarkan alternatif, dan beri tahu cara meminta peninjauan ulang.

Jangan meminta atau menuliskan data kartu, PIN, OTP atau kata sandi. Untuk pengembalian lewat transfer, cukup nama bank, nomor rekening dan nama pemilik rekening, dan hanya kalau memang diperlukan.

## Catatan

Ini panduan kerja, bukan nasihat hukum. Pelanggan di Indonesia punya hak atas kompensasi atau penggantian bila barang atau jasa tidak sesuai perjanjian, jadi kebijakan toko tidak boleh dipakai untuk menolak barang yang memang cacat atau tidak sesuai. Kalau kebijakan toko tampak bertentangan dengan hal itu, sampaikan ke pemilik.
