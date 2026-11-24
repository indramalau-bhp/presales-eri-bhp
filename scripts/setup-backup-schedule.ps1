# Pasang backup mingguan D1 di Windows Task Scheduler (sekali jalan).
# Jalankan dari folder project:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-backup-schedule.ps1
# Opsi: -Day Monday -Time 08:00 -Dest "D:\Backup\Presales" -SkipTest
param(
  [string]$Day  = "Monday",
  [string]$Time = "08:00",
  [string]$Dest = "",
  [switch]$SkipTest
)
$ErrorActionPreference = "Stop"
$root   = Split-Path $PSScriptRoot -Parent
$script = Join-Path $PSScriptRoot "backup-weekly.ps1"
$log    = Join-Path $root "backups\backup-log.txt"
$name   = "Backup Presales ERI D1"

if (-not (Test-Path $script)) { throw "Tidak menemukan $script" }

# 1. Uji backup sekali
if (-not $SkipTest) {
  Write-Host "[1/3] Uji backup (butuh login wrangler akun indra.malau@berca.co.id)..." -ForegroundColor Cyan
  $argsTest = @("-NoProfile","-ExecutionPolicy","Bypass","-File",$script)
  if ($Dest) { $argsTest += @("-Dest",$Dest) }
  & powershell.exe @argsTest
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Uji backup GAGAL. Lihat: $log" -ForegroundColor Red
    Write-Host "Kalau soal login, jalankan:  npx.cmd wrangler login   lalu ulangi." -ForegroundColor Yellow
    exit 1
  }
  Write-Host "Uji backup OK." -ForegroundColor Green
}

# 2. Daftarkan jadwal
Write-Host "[2/3] Mendaftarkan jadwal: tiap $Day jam $Time ..." -ForegroundColor Cyan
$arg = "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
if ($Dest) { $arg += " -Dest `"$Dest`"" }
$action   = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $root
$trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description "Backup mingguan database D1 inventory-aset ke OneDrive" -Force | Out-Null

# 3. Tampilkan hasil
Write-Host "[3/3] Terdaftar:" -ForegroundColor Cyan
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo | Select-Object LastRunTime, NextRunTime | Format-List
Write-Host "Selesai. Tes kapan saja:  schtasks /Run /TN `"$name`"   lalu cek:  Get-Content backups\backup-log.txt -Tail 5" -ForegroundColor Green
Write-Host "Hapus jadwal:            Unregister-ScheduledTask -TaskName `"$name`" -Confirm:`$false"
