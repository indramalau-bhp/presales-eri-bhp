# Backup mingguan D1 "inventory-aset": jalankan backup.ps1, salin ke OneDrive, simpan 8 file terakhir.
# Dijalankan oleh Windows Task Scheduler. Log: backups\backup-log.txt
param([string]$Dest = "")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$log = Join-Path $root "backups\backup-log.txt"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Log($m) { Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m) }

try {
  Log "Mulai backup"
  & "$PSScriptRoot\backup.ps1"
  $latest = Get-ChildItem (Join-Path $root "backups") -Filter "inventory-aset-*.sql" |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest -or $latest.Length -lt 100KB) { throw "File backup tidak ada atau terlalu kecil." }
  Log ("OK lokal: {0} ({1} byte)" -f $latest.Name, $latest.Length)

  if (-not $Dest) {
    $base = if ($env:OneDriveCommercial) { $env:OneDriveCommercial } else { $env:OneDrive }
    if ($base) { $Dest = Join-Path $base "Backup-Presales-ERI" }
  }
  if ($Dest) {
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    Copy-Item $latest.FullName $Dest -Force
    Log "Disalin ke $Dest"
    Get-ChildItem $Dest -Filter "inventory-aset-*.sql" | Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 8 | Remove-Item -Force
  } else { Log "PERINGATAN: folder OneDrive tidak ditemukan, hanya tersimpan lokal." }

  Get-ChildItem (Join-Path $root "backups") -Filter "inventory-aset-*.sql" | Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 8 | Remove-Item -Force
  Log "Selesai"
} catch {
  Log ("GAGAL: " + $_.Exception.Message)
  exit 1
}
