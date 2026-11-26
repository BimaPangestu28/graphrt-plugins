---
name: surat-penawaran
description: Menyusun surat penawaran harga atau proposal singkat untuk calon pelanggan, lengkap dengan ruang lingkup, rincian harga, syarat pembayaran dan masa berlaku. Gunakan saat diminta membuat penawaran, quotation, proposal harga, atau membalas permintaan harga (RFQ) dari calon klien.
license: Apache-2.0
metadata:
  version: "1.0.0"
  display_name: Menulis Surat Penawaran
  author: graphrt
---

# Menulis surat penawaran

Penawaran yang baik membuat calon pelanggan paham apa yang ia dapat, berapa biayanya, dan apa yang harus ia lakukan untuk setuju, tanpa perlu bertanya balik.

## Data yang harus ada

Jangan mulai menulis sebelum ini jelas. Kalau ada yang kurang, tanyakan ke pengguna dalam satu daftar pertanyaan, bukan satu per satu.

**Wajib**

- nama pelanggan atau perusahaannya, dan nama orang yang dituju;
- apa yang ditawarkan: barang (nama, spesifikasi, jumlah) atau jasa (pekerjaan, hasil yang diserahkan);
- harga satuan dan jumlahnya, dari pengguna atau dari daftar harga yang diberikan kepadamu;
- apakah harga sudah termasuk pajak, dan apakah bisnis ini memungut PPN;
- masa berlaku penawaran;
- syarat pembayaran (lunas di muka, uang muka dan pelunasan, tempo).

**Kalau relevan**

- ongkos kirim atau biaya pemasangan, dan siapa yang menanggung;
- waktu pengerjaan atau pengiriman;
- garansi dan layanan purnajual;
- hal yang tidak termasuk dalam penawaran;
- nomor penawaran dan identitas bisnis (nama, alamat, kontak, rekening).

Jangan mengarang harga, diskon, tarif pajak, nomor rekening, NPWP atau janji waktu. Yang belum ada ditulis sebagai `[diisi: ...]` supaya terlihat jelas sebelum dikirim.

## Susunan

1. **Kepala surat**: identitas bisnis, nomor dan tanggal penawaran, kepada siapa.
2. **Pembuka, satu sampai dua kalimat**: rujuk permintaan atau pertemuan sebelumnya, lalu langsung ke isi. Tidak perlu memuji diri sendiri panjang lebar.
3. **Kebutuhan pelanggan**, dalam satu atau dua kalimat memakai bahasa mereka. Ini menunjukkan penawaran dibuat untuk mereka, bukan templat.
4. **Yang ditawarkan**: ruang lingkup atau daftar barang. Untuk jasa, tulis hasil yang diserahkan, bukan hanya kegiatannya.
5. **Rincian harga** dalam tabel.
6. **Syarat dan ketentuan**: pembayaran, waktu pengerjaan atau pengiriman, garansi, yang tidak termasuk, masa berlaku.
7. **Langkah berikutnya**: cara menyetujui (balas pesan, tanda tangan, bayar uang muka) dan siapa yang bisa dihubungi.
8. **Penutup**, satu kalimat, lalu nama dan jabatan pengirim.

Contoh lengkap ada di `references/contoh-penawaran.md`. Baca kalau kamu butuh acuan bentuk; jangan menyalin angka atau nama dari contoh itu.

## Rincian harga

- Pakai tabel: nomor, uraian, jumlah, satuan, harga satuan, subtotal.
- Tulis rupiah dengan pemisah ribuan titik dan tanpa desimal: `Rp1.250.000`.
- Hitung ulang setiap subtotal dan total sebelum menyerahkan. Kalau hasil hitunganmu berbeda dari angka yang diberikan pengguna, sampaikan selisihnya; jangan diam-diam memilih salah satu.
- Tunjukkan diskon sebagai baris sendiri, dengan dasar yang jelas (misalnya jumlah pembelian), bukan disembunyikan di harga satuan.
- Pajak ditulis terang: sebutkan apakah harga sudah atau belum termasuk PPN. Tarif dan status pajak datang dari pengguna, bukan dari tebakanmu.
- Kalau ada beberapa pilihan paket, paling banyak tiga, dengan perbedaan yang mudah dibandingkan.

## Gaya bahasa

- Untuk perusahaan dan instansi: bahasa Indonesia baku yang ringkas, sapaan "Bapak/Ibu".
- Untuk pelanggan perorangan atau lewat chat: sopan dan hangat, boleh "Kak", tetap dengan rincian harga dan syarat yang lengkap.
- Kalimat aktif dan pendek. Hindari "Bersama surat ini kami bermaksud untuk menyampaikan".
- Tulis manfaat dalam bentuk yang bisa diperiksa ("garansi 12 bulan, teknisi datang dalam 2 hari kerja"), bukan klaim kosong ("kualitas terbaik, harga termurah").
- Jangan menjelekkan pesaing.

## Versi singkat untuk chat

Kalau penawaran dikirim lewat WhatsApp atau pesan singkat, pakai bentuk ini dan tawarkan versi lengkap sebagai dokumen:

```text
Halo Kak [nama], berikut penawaran untuk [kebutuhan]:

1. [uraian] - [jumlah] x Rp[harga] = Rp[subtotal]
2. [uraian] - [jumlah] x Rp[harga] = Rp[subtotal]

Total: Rp[total] ([sudah/belum] termasuk PPN, [sudah/belum] termasuk ongkir)
Pembayaran: [syarat]
Estimasi: [waktu pengerjaan atau pengiriman]
Berlaku sampai: [tanggal]

Kalau setuju, cukup balas pesan ini ya, Kak.
```

## Sebelum menyerahkan

- Semua `[diisi: ...]` yang tersisa kamu daftar di bawah draf, supaya pengguna tahu apa yang masih harus dilengkapi.
- Total sama dengan jumlah semua baris.
- Ada masa berlaku dan ada cara menyetujui.
- Tidak ada janji (garansi, tenggat, bonus) yang tidak berasal dari pengguna.

Kamu menyiapkan draf. Penawaran adalah komitmen harga, jadi yang mengirimkannya ke pelanggan adalah pengguna, setelah ia memeriksa angkanya.
