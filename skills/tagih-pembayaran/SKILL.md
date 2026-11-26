---
name: tagih-pembayaran
description: Menyusun pesan pengingat dan penagihan pembayaran (invoice, piutang, cicilan, tagihan jatuh tempo) yang sopan tetapi tegas, dengan tingkat ketegasan yang naik sesuai lamanya keterlambatan. Gunakan saat diminta menagih pelanggan, mengingatkan tagihan yang belum dibayar, atau menindaklanjuti invoice yang lewat jatuh tempo.
license: Apache-2.0
metadata:
  version: "1.0.0"
  display_name: Menagih Pembayaran dengan Sopan
  author: graphrt
---

# Menagih pembayaran dengan sopan

Tujuanmu ada dua, dan keduanya sama penting: tagihan dibayar, dan hubungan dengan pelanggan tetap baik. Kebanyakan tagihan telat karena lupa, salah alamat atau proses internal pelanggan, bukan karena niat buruk. Mulailah dari anggapan itu.

## Data yang harus ada

- nama pelanggan dan orang yang dituju;
- nomor tagihan, tanggal tagihan, jumlah, dan tanggal jatuh tempo;
- untuk apa tagihan itu (barang atau jasa, periode);
- cara bayar yang diterima (nomor rekening dan nama pemilik, tautan pembayaran), dari pengguna;
- riwayat penagihan sebelumnya: sudah berapa kali diingatkan, lewat mana, apa jawabannya;
- kesepakatan yang berlaku: tempo, denda keterlambatan, cicilan.

Jangan mengarang jumlah, nomor rekening, denda atau tenggat. Denda hanya disebut kalau memang tertulis di kesepakatan dengan pelanggan itu. Kalau jumlah yang diberikan pengguna berbeda dari riwayat percakapan (misalnya sudah ada pembayaran sebagian), tanyakan dulu sebelum menulis.

## Pilih tingkat pesan

Hitung jarak hari ini dari tanggal jatuh tempo, lalu lihat riwayatnya. Naik satu tingkat setiap kali, jangan melompat.

| Tingkat | Kapan | Nada | Isi utama |
| --- | --- | --- | --- |
| 1. Pengingat sebelum jatuh tempo | Beberapa hari sebelum jatuh tempo | Ramah, informatif | Tagihan, tanggal jatuh tempo, cara bayar |
| 2. Pengingat pertama | Baru lewat jatuh tempo, belum pernah diingatkan | Ramah, menganggap lupa | Tagihan sudah jatuh tempo, tawarkan kirim ulang tagihan |
| 3. Pengingat kedua | Sudah diingatkan sekali, belum ada pembayaran atau jawaban | Sopan dan langsung | Minta tanggal pembayaran yang pasti, tanyakan apakah ada kendala |
| 4. Penagihan tegas | Sudah dua kali diingatkan, atau janji bayar tidak ditepati | Tegas, tanpa basa-basi, tetap hormat | Tenggat yang jelas dan akibat yang sudah disepakati |
| 5. Peringatan terakhir | Tingkat 4 tidak berhasil | Formal | Hanya disiapkan atas permintaan pengguna, lihat bagian batas |

Batas hari untuk tiap tingkat mengikuti kebiasaan bisnis ini. Kalau pengguna tidak menyebutkannya, usulkan tingkat berdasarkan riwayat dan sebutkan alasanmu.

## Isi setiap pesan

Urutannya selalu sama, panjangnya menyesuaikan saluran:

1. sapaan dan nama orangnya;
2. tagihan mana: nomor, untuk apa, jumlah, tanggal jatuh tempo;
3. apa yang diminta: bayar paling lambat tanggal tertentu, atau kabari kapan bisa bayar;
4. cara bayar, lengkap, supaya pelanggan tidak perlu mencari lagi;
5. jalan keluar: "Kalau sudah dibayar, mohon abaikan pesan ini dan kirimkan bukti transfernya" dan "Kalau ada kendala, kabari kami supaya bisa dicarikan jalan";
6. terima kasih dan nama pengirim.

Tulis jumlah dengan pemisah ribuan titik: `Rp4.750.000`. Tanggal ditulis lengkap, bukan "minggu depan".

## Contoh per tingkat

**Tingkat 2, lewat chat**

> Halo Pak Anton, semoga sehat. Saya mau mengingatkan tagihan INV-0231 untuk pemasangan kanopi sebesar Rp4.750.000 yang jatuh tempo 20 November 2026. Barangkali terlewat ya, Pak. Pembayaran bisa ke BCA `[nomor rekening]` a.n. `[nama pemilik]`. Kalau sudah ditransfer, mohon abaikan pesan ini dan kirimkan buktinya. Perlu saya kirim ulang tagihannya? Terima kasih, Pak.

**Tingkat 3, lewat chat**

> Selamat siang Pak Anton. Menyambung pesan saya tanggal 22 November, tagihan INV-0231 sebesar Rp4.750.000 belum kami terima pembayarannya. Mohon kabari kapan bisa diselesaikan, Pak, supaya kami bisa mencatatnya. Kalau ada kendala atau ada yang kurang sesuai dengan pekerjaannya, sampaikan saja, kita cari jalan keluarnya bersama.

**Tingkat 4, lewat email**

> Yth. Bapak Anton,
>
> Tagihan INV-0231 sebesar Rp4.750.000 untuk pemasangan kanopi telah melewati jatuh tempo sejak 20 November 2026. Kami sudah mengingatkan pada 22 dan 29 November dan belum menerima pembayaran maupun kabar.
>
> Kami mohon pembayaran diterima paling lambat 10 Desember 2026 ke BCA `[nomor rekening]` a.n. `[nama pemilik]`. Apabila Bapak membutuhkan pengaturan pembayaran bertahap, mohon hubungi kami sebelum tanggal tersebut.
>
> Sesuai kesepakatan `[rujukan kesepakatan]`, setelah tanggal itu `[akibat yang disepakati]`.
>
> Hormat kami,
> `[nama dan jabatan]`

Baris terakhir pada tingkat 4 hanya ditulis kalau akibatnya memang tertulis di kesepakatan. Kalau tidak ada, hapus baris itu.

## Kalau pelanggan menjawab

- **Berjanji membayar pada tanggal tertentu:** ucapkan terima kasih, ulangi tanggal dan jumlahnya sebagai konfirmasi, dan catat untuk ditindaklanjuti sehari setelah tanggal itu.
- **Minta keringanan atau cicilan:** jangan menyetujui atau menolak sendiri. Tanyakan usulannya (jumlah dan tanggal), lalu teruskan ke pengguna untuk diputuskan.
- **Membantah tagihan** (jumlah salah, pekerjaan belum selesai, barang bermasalah): hentikan penagihan untuk tagihan itu, catat keberatannya, dan teruskan ke pengguna. Tagihan yang sedang disengketakan tidak ditagih dengan nada tegas.
- **Mengaku sudah membayar:** minta bukti transfer dengan sopan dan minta pengguna mencocokkan mutasi rekening sebelum menjawab lebih jauh.

## Batas yang tidak boleh dilewati

- Tidak mengancam, mempermalukan, atau memakai kata-kata kasar.
- Tidak menghubungi keluarga, atasan, rekan kerja atau kontak lain milik pelanggan, dan tidak menagih di kolom komentar atau grup yang dilihat orang lain.
- Tidak menyebarkan data atau foto pelanggan, dan tidak mengancam akan menyebarkannya.
- Tidak mengaku sebagai pengacara, penagih resmi atau aparat, dan tidak menyebut langkah hukum yang belum benar-benar diputuskan pengguna.
- Tidak menagih di luar jam yang wajar. Tanpa arahan lain, pesan dikirim pada jam kerja hari kerja.
- Tidak menambah denda, bunga atau biaya yang tidak tertulis di kesepakatan.

Peringatan terakhir yang menyebut penghentian layanan, pemutusan kerja sama atau langkah hukum hanya kamu siapkan kalau pengguna memintanya dengan jelas, dan kamu sarankan pengguna memeriksakannya dulu ke orang yang paham hukum.

## Yang kamu serahkan

1. Draf pesan untuk tingkat yang dipilih, sesuai saluran (chat atau email).
2. Satu baris alasan: tingkat berapa dan mengapa.
3. Hal yang perlu dipastikan pengguna sebelum dikirim, misalnya jumlah setelah pembayaran sebagian atau nomor rekening.
4. Usulan tanggal tindak lanjut berikutnya kalau belum ada jawaban.

Kamu menyiapkan draf; yang mengirim adalah pengguna, atau kamu hanya setelah pengguna menyetujui isi dan penerimanya.
