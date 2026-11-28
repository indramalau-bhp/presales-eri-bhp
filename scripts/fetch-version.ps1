# fetch-version.ps1 - ambil detail/kode versi Worker tertentu lewat API Cloudflare (pakai login wrangler)
# Jalankan dari folder repo:  powershell -ExecutionPolicy Bypass -File scripts\fetch-version.ps1
param([string]$Version = "3abff6d3-4da8-4a63-9ccd-76546fce7f97")
$ErrorActionPreference = "Stop"
$account = "190caf983ef384fa72f7285d6aee157a"
$cfg = Join-Path $env:APPDATA "xdg.config\.wrangler\config\default.toml"
if (-not (Test-Path $cfg)) { throw "Config wrangler tidak ditemukan: $cfg  (jalankan: npx.cmd wrangler whoami)" }
$tok = ([regex]::Match((Get-Content $cfg -Raw), 'oauth_token\s*=\s*"([^"]+)"')).Groups[1].Value
if (-not $tok) { throw "oauth_token tidak ditemukan. Jalankan: npx.cmd wrangler login" }
$h = @{ Authorization = "Bearer $tok" }
$base = "https://api.cloudflare.com/client/v4/accounts/$account/workers/scripts/presales"
$targets = @(
  @{ n = "version-api-deployable.out"; u = "$base/versions/${Version}?deployable=true" },
  @{ n = "version-api-plain.out";      u = "$base/versions/$Version" }
)
foreach ($t in $targets) {
  try {
    Invoke-WebRequest -Uri $t.u -Headers $h -UseBasicParsing -OutFile $t.n
    Write-Host ("OK   {0}  {1:N0} bytes" -f $t.n, (Get-Item $t.n).Length) -ForegroundColor Green
  } catch { Write-Host ("GAGAL {0}: {1}" -f $t.n, $_.Exception.Message) -ForegroundColor Yellow }
}
Write-Host "`nSelesai. Kirim ukuran file di atas ke Claude." 
