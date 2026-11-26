---
name: ringkasan-rapat
description: Mengubah catatan, transkrip atau notulen rapat menjadi ringkasan singkat berisi keputusan dan daftar tindak lanjut yang punya penanggung jawab serta tenggat. Gunakan saat diminta merangkum rapat, membuat notulen, minutes of meeting (MoM), atau daftar action item dari hasil diskusi.
license: Apache-2.0
metadata:
  version: "1.0.0"
  display_name: Ringkasan Rapat dan Tindak Lanjut
  author: graphrt
---

# Ringkasan rapat menjadi daftar tindak lanjut

Hasil kerjamu harus bisa dibaca dalam dua menit oleh orang yang tidak ikut rapat, dan setelah membacanya setiap orang tahu apa yang harus ia kerjakan dan kapan.

## Aturan dasar

- **Hanya tulis yang benar-benar dibicarakan.** Jangan menambah keputusan, angka, nama atau tenggat yang tidak ada di sumber.
- **Bedakan keputusan dari wacana.** "Kita coba naikkan harga bulan depan" yang disepakati adalah keputusan; "mungkin harga perlu naik" adalah diskusi.
- **Setiap tindak lanjut punya satu penanggung jawab dan satu tenggat.** Kalau sumber tidak menyebutnya, tulis `belum ditentukan` dan masukkan ke bagian pertanyaan terbuka. Jangan menunjuk orang atau mengarang tanggal sendiri.
- **Tanggal ditulis lengkap.** Ubah "Jumat depan" atau "akhir bulan" menjadi tanggal, dihitung dari tanggal rapat. Kalau tanggal rapat tidak diketahui, biarkan seperti aslinya dan tanyakan.
- **Nama ditulis seperti di sumber.** Kalau transkrip hanya menyebut "Pembicara 2", pakai itu dan minta pengguna mencocokkan namanya.
- Bahasa ringkasan mengikuti bahasa rapat. Istilah yang dipakai peserta dipertahankan.

## Langkah

1. Baca seluruh sumber sekali sebelum menulis apa pun. Transkrip otomatis sering salah eja nama, angka dan istilah: kalau sebuah angka atau nama tampak janggal, tandai `[perlu dicek]`, jangan diam-diam dibetulkan.
2. Kumpulkan keputusan. Tulis masing-masing sebagai kalimat yang berdiri sendiri, berikut alasannya kalau disebut.
3. Kumpulkan tindak lanjut. Mulai setiap butir dengan kata kerja ("Kirim", "Hitung", "Hubungi") dan sebut hasil yang diharapkan, bukan kegiatannya. "Kirim penawaran revisi ke PT Maju" lebih baik daripada "Follow up klien".
4. Kumpulkan hal yang belum selesai: pertanyaan tanpa jawaban, perbedaan pendapat yang belum diputus, informasi yang ditunggu.
5. Tulis ringkasan paling akhir, setelah daftar di atas jadi, supaya isinya tidak melenceng dari keputusan.

Topik yang dibahas beberapa kali digabung menjadi satu. Obrolan pembuka, candaan dan pengulangan tidak perlu masuk.

## Format hasil

```markdown
# [Judul rapat] - [tanggal rapat]

Peserta: [nama-nama]. Tidak hadir: [nama, kalau disebut].

## Ringkasan
[2 sampai 4 kalimat: untuk apa rapat ini, dan apa hasil terpentingnya.]

## Keputusan
1. [Keputusan]. Alasan: [kalau disebut].

## Tindak lanjut
| No | Tindakan | Penanggung jawab | Tenggat |
| --- | --- | --- | --- |
| 1 | [kata kerja + hasil yang diharapkan] | [nama] | [tanggal] |

## Belum diputuskan
- [Pertanyaan atau hal yang ditunggu], menunggu [siapa atau apa].

## Rapat berikutnya
[Tanggal, jam dan agenda, kalau disebut.]
```

Hilangkan bagian yang memang kosong, kecuali **Tindak lanjut**: kalau tidak ada, tulis "Tidak ada tindak lanjut yang disepakati" supaya jelas bahwa itu bukan terlewat.

## Menyesuaikan dengan pembaca

- **Untuk dikirim lewat chat (WhatsApp, Slack, Teams):** tanpa tabel dan tanpa judul bertingkat. Pakai daftar bernomor: `1. [Nama] - [tindakan] - paling lambat [tanggal]`, lalu keputusan dalam dua atau tiga butir.
- **Untuk atasan atau klien:** ringkasan dan keputusan di depan, tindak lanjut hanya yang menyangkut mereka, tanpa detail diskusi internal.
- **Untuk arsip tim:** format lengkap di atas.

Kalau pengguna tidak menyebut pembacanya, pakai format lengkap.

## Sebelum menyerahkan

Periksa sendiri:

- Apakah setiap tindak lanjut bisa dicentang selesai atau belum? Kalau tidak, rumuskan ulang.
- Apakah ada keputusan yang membutuhkan tindak lanjut tetapi belum ada butirnya? Tambahkan, dengan penanggung jawab `belum ditentukan` kalau tidak disebut.
- Apakah ada nama, angka atau tanggal yang kamu tulis tanpa ada di sumber? Hapus.

Sesudah hasilnya, tambahkan satu baris terpisah berisi hal yang perlu dipastikan pengguna, misalnya: "Perlu dipastikan: penanggung jawab butir 3, dan ejaan nama 'Pak Hendrik/Hendri'."

## Hal sensitif

Jangan memasukkan ke ringkasan yang akan dibagikan: gaji dan penilaian kinerja perorangan, masalah pribadi peserta, kata sandi atau kode akses yang kebetulan disebut dalam rapat. Kalau hal seperti itu merupakan inti rapat, tanyakan dulu siapa yang boleh menerimanya.
