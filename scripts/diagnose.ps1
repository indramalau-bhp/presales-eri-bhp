# diagnose.ps1 - simpan daftar versi Worker + detail (binding/variabel) 4 versi terbaru ke folder diag\
# Jalankan dari folder repo:  powershell -ExecutionPolicy Bypass -File scripts\diagnose.ps1
$ErrorActionPreference = "Continue"
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force diag | Out-Null
npx.cmd wrangler versions list --name presales --json 2>$null | Out-File -Encoding utf8 diag\versions.json
npx.cmd wrangler deployments list --name presales 2>$null | Out-File -Encoding utf8 diag\deployments.txt
$j = Get-Content diag\versions.json -Raw | ConvertFrom-Json
$ids = @($j | Sort-Object { $_.metadata.created_on } -Descending | Select-Object -First 5 | ForEach-Object { $_.id })
$i = 0
foreach ($id in $ids) {
  $i++
  npx.cmd wrangler versions view $id --name presales --json 2>$null | Out-File -Encoding utf8 ("diag\v{0}-{1}.json" -f $i, $id.Substring(0,8))
  Write-Host "disimpan: diag\v$i-$($id.Substring(0,8)).json"
}
Write-Host "Selesai. Beri tahu Claude."
