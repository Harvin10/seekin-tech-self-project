# Papan Prioritas

Matriks Eisenhower, daftar tugas dan kalender dalam satu PWA. Berjalan di Cloudflare Pages dengan database D1, dan memakai design system Seekin ERP (token, Plus Jakarta Sans, bottom nav dengan tombol Tambah, header gaya e-wallet, sheet bawah).

## Isi folder

| Path | Isi |
|---|---|
| `public/` | Semua yang diunggah ke Pages |
| `public/_worker.js` | API (`/api/*`), login, header keamanan; menyajikan file statis lewat `env.ASSETS` |
| `public/index.html`, `app.js`, `app.css`, `boot.js` | Aplikasi (tanpa build step) |
| `public/sw.js`, `manifest.webmanifest`, `icons/` | PWA: bisa dipasang, terbuka saat offline |
| `public/fonts/` | Plus Jakarta Sans (SIL OFL, lihat `OFL.txt`) |
| `schema.sql` | Tabel D1 |
| `wrangler.toml` | Nama proyek, binding D1 `DB`, variabel `ALLOW_SIGNUP` |
| `CLAUDE.md` | Panduan untuk Claude saat mengelola data |

## Deploy

Database D1 `papan-prioritas` sudah dibuat di akun Cloudflare kamu dan tabelnya sudah terpasang. ID-nya sudah tertulis di `wrangler.toml`.

```sh
cd apps/papan-prioritas
npm install
npx wrangler login
npx wrangler pages project create papan-prioritas --production-branch main
npm run deploy
```

Lalu buka `https://papan-prioritas.pages.dev`:

1. Akun pertama yang dibuat menjadi pemilik papan.
2. Setelah itu pendaftaran tertutup otomatis.
3. Untuk menambah akun lain, ubah `ALLOW_SIGNUP` di `wrangler.toml` menjadi `"true"`, deploy, daftarkan akunnya, lalu kembalikan ke `"false"`.

**Lewat GitHub:**
1. Di dashboard, pilih *Workers & Pages → Create → Pages → Connect to Git*, lalu repo `seekin-tech-self-project`.
2. Isi *Root directory* dengan `apps/papan-prioritas`.
3. Kosongkan *Build command* dan isi *Build output directory* dengan `public`.
4. Di *Build watch paths*, sertakan hanya `apps/papan-prioritas/*`.
5. Binding D1 dibaca dari `wrangler.toml`.

Hindari unggah drag-and-drop di dashboard. Cara itu tidak mendukung Functions, jadi pakai wrangler atau Git.

## Coba di komputer

```sh
npm run db:init:local
npm run dev        # http://localhost:8788
```

## Keamanan

- **Kata sandi:** disimpan sebagai PBKDF2-SHA256 dengan 100.000 iterasi dan salt per akun.
- **Sesi:** cookie `__Host-sid` (HttpOnly, Secure, SameSite=Lax), berlaku 30 hari. Yang disimpan di D1 hanya hash SHA-256 dari tokennya.
- **Batas percobaan:** login dibatasi 8 kali gagal per 15 menit, per email dan per IP.
- **Permintaan tulis:** ditolak kalau `Origin`-nya bukan situs ini, dan harus berupa JSON.
- **Header keamanan:** CSP ketat tanpa inline script atau style, HSTS, `frame-ancestors 'none'`.
- **Isolasi data:** setiap baris data dimiliki satu `user_id`. API tidak pernah membaca atau mengubah baris milik akun lain.

## Offline

- **Tampilan:** service worker menyimpan app shell, dan aplikasi menyimpan salinan data terakhir di perangkat.
- **Perubahan saat offline:** masuk antrean dan dikirim berurutan begitu tersambung lagi. Di bilah atas muncul tanda *Offline · n*.
- **Pembaruan:** saat ada versi baru, muncul banner *Versi baru siap → Muat ulang*. Naikkan `VERSION` di `sw.js` setiap kali kamu mengubah file aplikasi.
