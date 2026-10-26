# Mengelola Papan Prioritas (untuk Claude)

Data ada di Cloudflare D1, database `papan-prioritas`, id `76bb3874-85a8-4aab-98e0-bee27fb4b27b`. Pakai tool D1 query di konektor Cloudflare. Aplikasi memuat ulang data setiap 60 detik dan saat dibuka kembali, jadi perubahan langsung terlihat.

## Tabel

- `users(id, email, name, …)`: jangan sentuh kolom `pass_*`.
- `tasks`:
  - `id TEXT`: UUID baru untuk tugas baru.
  - `user_id TEXT`
  - `title TEXT`
  - `notes TEXT`
  - `quadrant TEXT`:
    - `'q1'` Kerjakan (penting + mendesak)
    - `'q2'` Jadwalkan (penting)
    - `'q3'` Delegasikan (mendesak)
    - `'q4'` Singkirkan
    - `NULL` belum dipilah
  - `due_date 'YYYY-MM-DD'`, `due_time 'HH:MM'`
  - `delegate_to TEXT`: hanya diisi untuk q3.
  - `done 0|1`, `done_at`
  - `created_at`, `updated_at`
- `events(id, user_id, title, date 'YYYY-MM-DD', start_time 'HH:MM', end_time 'HH:MM', notes, created_at, updated_at)`

## Aturan

- Tanggal dan jam memakai waktu lokal Asia/Jakarta. Timestamp memakai ISO-8601 UTC (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`).
- Selalu isi `user_id`. Ambil dari `SELECT id FROM users WHERE email = ?`.
- Setiap UPDATE juga mengisi `updated_at`.
- Hapus data hanya bila diminta.
- Tugas baru masuk `q4` kecuali diminta kuadran lain. Pemilik menyeretnya sendiri ke kuadran yang lebih penting.
- Tugas dengan jam spesifik cukup diberi `due_date` dan `due_time`. Tugas itu langsung tampil di kalender.

## Contoh

```sql
-- Tambah tugas Q1 untuk hari ini
INSERT INTO tasks (id, user_id, title, quadrant, due_date, created_at, updated_at)
SELECT lower(hex(randomblob(16))), id, 'Balas email investor', 'q1', date('now','+7 hours'),
       strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM users WHERE email = '<email akun kamu>';

-- Pindahkan tugas yang lewat tenggat dari Q2 ke Q1
UPDATE tasks SET quadrant = 'q1', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE done = 0 AND quadrant = 'q2' AND due_date < date('now','+7 hours');
```
