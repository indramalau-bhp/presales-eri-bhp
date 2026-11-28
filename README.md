# ERI Sales and Presales Workspace

Cloudflare Worker + D1. Live: https://presales.bhp-eri.workers.dev

## Aturan main (penting)
1. **Push ke `main` = deploy ke live** (GitHub Actions `deploy.yml`). Jangan push langsung bila belum diuji.
2. Kerja di branch (`git checkout -b nama-perubahan`). Gabungkan ke `develop` -> otomatis ke **staging**. Setelah lolos, gabungkan ke `main`.
3. Sebelum push ke main: `npm test` (tes asap memakai salinan backup, tidak menyentuh live).
4. Setelah tiap deploy ke live, cek **Services Quota** dan **Request Monitor**.
5. Rollback darurat: `npx.cmd wrangler deployments list` lalu `npx.cmd wrangler rollback <VERSION_ID> -y`.
6. Source kebenaran adalah repo ini. Jangan deploy dari folder lain.

## Perintah
- `npm test` : tes asap (butuh `backups/pre-deploy-*.sql`)
- `scripts/deploy.ps1` : deploy manual aman (backup D1, cek, auto-rollback)
- `scripts/staging-setup.ps1` : siapkan staging (sekali)
- `scripts/diagnose.ps1` : simpan detail versi Worker ke `diag/`

## Variabel/Secret
Variabel ada di `wrangler.toml` (`REQUEST_PRESALES_MANAGER`, `MASTER_EMAILS`, ...). Secret (`ADMIN_PASSWORD`, `NOTIFY_KEY`) hanya lewat `wrangler secret put`, tidak pernah di repo.
