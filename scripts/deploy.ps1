# deploy.ps1 - deploy aman: cek source -> backup D1 -> deploy -> cek live -> auto-rollback bila gagal
# Jalankan dari mana saja:  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
# Tambah  -SkipConfirm  untuk melewati pertanyaan konfirmasi.
param([switch]$SkipConfirm)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$live   = "https://presales.bhp-eri.workers.dev"
$stamp  = Get-Date -Format "yyyyMMdd-HHmm"
$sql    = "backups\pre-deploy-$stamp.sql"
New-Item -ItemType Directory -Force backups | Out-Null

function Fail($m) { Write-Host "`nBATAL: $m" -ForegroundColor Red; exit 1 }

Write-Host "1/6 Cek source" -ForegroundColor Cyan
foreach ($f in "src\worker.js","src\index.html") { if (-not (Test-Path $f)) { Fail "$f tidak ada" } }
node --check src\worker.js; if ($LASTEXITCODE -ne 0) { Fail "worker.js error sintaks" }
# Pengaman: fitur yang HARUS ada di source (cegah source lama menimpa versi live)
$w = Get-Content src\worker.js -Raw; $h = Get-Content src\index.html -Raw
$must = @(
  @{ t = $w; k = "service_quotations"; n = "worker: API Services Quota" },
  @{ t = $w; k = "service_quota_targets"; n = "worker: target quota" },
  @{ t = $h; k = "Services Quota"; n = "index.html: menu Services Quota" }
)
foreach ($m in $must) { if (-not $m.t.Contains($m.k)) { Fail "Source tidak memuat '$($m.k)' ($($m.n)). Kemungkinan source lama - deploy dibatalkan." } }
$sizeW = (Get-Item src\worker.js).Length; $sizeH = (Get-Item src\index.html).Length
if ($sizeW -lt 150000 -or $sizeH -lt 900000) { Fail "Ukuran source mencurigakan (worker $sizeW, html $sizeH)." }
Write-Host ("   OK worker {0:N0} B, index {1:N0} B" -f $sizeW, $sizeH) -ForegroundColor Green

Write-Host "2/6 Perubahan yang belum di-commit (src)" -ForegroundColor Cyan
$st = git status --short src wrangler.toml 2>$null; if ($st) { $st } else { Write-Host "   (bersih: sama dengan commit terakhir)" }

Write-Host "3/6 Versi live sekarang (untuk rollback otomatis)" -ForegroundColor Cyan
$ds = (npx.cmd wrangler deployments status 2>&1 | Out-String)
$prev = ([regex]::Match($ds, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')).Value
if (-not $prev) { Fail "Tidak bisa membaca versi aktif. Output: $ds" }
Write-Host "   Versi aktif: $prev" -ForegroundColor Green
if (-not $SkipConfirm) { $a = Read-Host "Lanjut deploy? (y/N)"; if ($a -ne "y") { Fail "Dibatalkan oleh pengguna." } }

Write-Host "4/6 Backup D1 -> $sql" -ForegroundColor Cyan
npx.cmd wrangler d1 export inventory-aset --remote --output $sql
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $sql) -or (Get-Item $sql).Length -lt 1024) { Fail "Backup gagal/kosong." }
Write-Host ("   OK {0:N0} KB" -f ((Get-Item $sql).Length/1KB)) -ForegroundColor Green

Write-Host "5/6 Deploy" -ForegroundColor Cyan
npx.cmd wrangler deploy
if ($LASTEXITCODE -ne 0) { Fail "wrangler deploy gagal. Versi lama tetap aktif ($prev)." }

Write-Host "6/6 Cek live" -ForegroundColor Cyan
Start-Sleep -Seconds 5
$ok = $false
try { $r = Invoke-WebRequest "$live/" -UseBasicParsing -TimeoutSec 30; $ok = ($r.StatusCode -eq 200) -and $r.Content.Contains("Services Quota") } catch { }
if (-not $ok) {
  Write-Host "   Halaman live GAGAL. Rollback otomatis ke $prev ..." -ForegroundColor Red
  npx.cmd wrangler rollback $prev --message "auto-rollback" -y
  exit 2
}
Write-Host "   Halaman live terbuka. Pengecekan data harus manual (butuh login)." -ForegroundColor Yellow
Write-Host "   Buka $live/#/presales/quotations (Ctrl+F5) dan pastikan angka & daftar quotation TAMPIL." -ForegroundColor Yellow
$a = Read-Host "   Ketik OK bila Services Quota terisi; apa pun selain OK = rollback otomatis"
if ($a -ne "OK") {
  Write-Host "   Rollback ke $prev ..." -ForegroundColor Red
  npx.cmd wrangler rollback $prev --message "rollback: quota tidak terisi" -y
  exit 2
}
Write-Host ""
Write-Host "Selesai. Backup: $sql" -ForegroundColor Green
Write-Host "Rollback manual: npx.cmd wrangler rollback $prev"
