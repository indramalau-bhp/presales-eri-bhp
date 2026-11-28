# staging-setup.ps1 - siapkan Worker + D1 staging (sekali saja). Tidak menyentuh data/worker live.
# Jalankan dari folder repo:  powershell -ExecutionPolicy Bypass -File scripts\staging-setup.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$cfg = "wrangler.staging.toml"
if (-not (Select-String -Path $cfg -Pattern "REPLACE_WITH_STAGING_D1_ID" -Quiet)) { Write-Host "Staging sudah disiapkan (ID D1 sudah terisi)." -ForegroundColor Yellow; exit 0 }

Write-Host "1/3 Buat database D1 presales-staging" -ForegroundColor Cyan
$out = (npx.cmd wrangler d1 create presales-staging 2>&1 | Out-String); Write-Host $out
$id = ([regex]::Match($out, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')).Value
if (-not $id) { throw "ID database tidak ditemukan di output. Salin manual ke $cfg" }
(Get-Content $cfg -Raw).Replace("REPLACE_WITH_STAGING_D1_ID", $id) | Set-Content $cfg -NoNewline
Write-Host "   ID D1 staging: $id" -ForegroundColor Green

Write-Host "2/3 Deploy worker staging (schema dibuat otomatis saat akses pertama)" -ForegroundColor Cyan
npx.cmd wrangler deploy --config $cfg
if ($LASTEXITCODE -ne 0) { throw "Deploy staging gagal" }

Write-Host "3/3 Secret staging (isi nilai BERBEDA dari live)" -ForegroundColor Cyan
Write-Host "   Masukkan ADMIN_PASSWORD staging:"; npx.cmd wrangler secret put ADMIN_PASSWORD --config $cfg
Write-Host "   Masukkan NOTIFY_KEY staging:";     npx.cmd wrangler secret put NOTIFY_KEY --config $cfg

Write-Host "`nSelesai. URL: https://presales-staging.<subdomain-anda>.workers.dev" -ForegroundColor Green
Write-Host "PENTING: tambahkan URL itu ke 'Authorized JavaScript origins' di OAuth Client Google Cloud, agar login Google bisa dipakai di staging."
