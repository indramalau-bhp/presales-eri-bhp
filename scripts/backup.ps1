# Backup database D1 "inventory-aset" ke file SQL bertimestamp.
# Jalankan dari folder project:  powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
# Login wrangler harus akun indra.malau@berca.co.id.
$ErrorActionPreference = "Stop"
$dir = Join-Path $PSScriptRoot "..\backups"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $dir "inventory-aset-$stamp.sql"
Write-Host "Mengekspor database D1 (produksi) -> $out"
npx.cmd wrangler d1 export inventory-aset --remote --output "$out"
Write-Host ""
Write-Host "Selesai. Salin file ini ke tempat aman (Google Drive / OneDrive)."
Write-Host "Simpan minimal 4 backup terakhir."
