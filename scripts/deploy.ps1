# deploy.ps1 - backup D1 -> cek sintaks -> deploy -> cek health
# Jalankan dari folder repo:  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$stamp  = Get-Date -Format "yyyyMMdd-HHmm"
$dir    = "backups"
$sql    = Join-Path $dir "pre-deploy-$stamp.sql"
$health = "https://presales.bhp-eri.workers.dev/health"
New-Item -ItemType Directory -Force $dir | Out-Null

Write-Host "1/5 Backup database D1 (inventory-aset) -> $sql" -ForegroundColor Cyan
npx.cmd wrangler d1 export inventory-aset --remote --output $sql
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $sql) -or (Get-Item $sql).Length -lt 1024) { throw "Backup gagal/kosong. Deploy dibatalkan." }
Write-Host ("   OK {0:N0} KB" -f ((Get-Item $sql).Length/1KB)) -ForegroundColor Green

Write-Host "2/5 Cek sintaks worker.js" -ForegroundColor Cyan
node --check src\worker.js
if ($LASTEXITCODE -ne 0) { throw "worker.js error sintaks. Deploy dibatalkan." }

Write-Host "3/5 Catat versi saat ini (untuk rollback)" -ForegroundColor Cyan
npx.cmd wrangler deployments list 2>&1 | Select-Object -Last 8

Write-Host "4/5 Deploy" -ForegroundColor Cyan
npx.cmd wrangler deploy
if ($LASTEXITCODE -ne 0) { throw "Deploy gagal. Versi lama tetap aktif." }

Write-Host "5/5 Cek health" -ForegroundColor Cyan
Start-Sleep -Seconds 4
try { $r = Invoke-WebRequest $health -UseBasicParsing -TimeoutSec 20; Write-Host "   $($r.StatusCode) $($r.Content)" -ForegroundColor Green }
catch { Write-Host "   Health GAGAL: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "   Rollback: npx.cmd wrangler rollback" -ForegroundColor Yellow }

Write-Host "`nSelesai. Backup: $sql" -ForegroundColor Green
Write-Host "Rollback kode : npx.cmd wrangler rollback"
Write-Host "Restore data  : npx.cmd wrangler d1 execute inventory-aset --remote --file $sql   (hanya jika data rusak)"
