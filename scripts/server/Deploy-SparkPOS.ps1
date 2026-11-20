<#
  Installs a SparkPOS site update package on the IIS server. scripts/deploy.sh copies this file and
  the package here over SSH and runs it, so nobody has to remote into the server. It can also be
  run by hand in an admin PowerShell:
      C:\deploy\Deploy-SparkPOS.ps1 -Site VrossPOS -Zip C:\deploy\incoming\VrossPOS-update-v2.2.0-20261119-1015.zip

  What it does, in order (the same steps as the package's README-UPDATE.txt):
    1. Unzips the package to C:\deploy\staging and checks it's a SparkPOS site with no settings file.
    2. Backs up the site folder to C:\deploy\backups (keeps the last 5; product images left out).
    3. Stops the app pool, copies the new files over, never touching appsettings*.json or
       wwwroot\images, and starts the pool again (also when the copy failed).
    4. Checks <HealthUrl>/health when given.
  Database migrations are NOT part of it: run new numbered .sql files separately.

  -Rollback puts the newest backup of the site back instead.
#>
param(
    [Parameter(Mandatory = $true)][string]$Site,       # IIS site folder name under C:\inetpub, e.g. VrossPOS
    [string]$Zip,                                       # the update package (not needed with -Rollback)
    [string]$Pool = $Site,                              # app pool name (defaults to the site name)
    [string]$SiteRoot = "C:\inetpub\$Site",
    [string]$HealthUrl,                                 # e.g. https://vrosspos.itcoresystems.com
    [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
Import-Module WebAdministration

$deploy = 'C:\deploy'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backups = Join-Path $deploy 'backups'
New-Item -ItemType Directory -Force -Path $backups, (Join-Path $deploy 'staging') | Out-Null

if (-not (Test-Path (Join-Path $SiteRoot 'appsettings.json'))) {
    throw "$SiteRoot\appsettings.json not found: is $Site the right site? Nothing was changed."
}
if (-not (Get-Item "IIS:\AppPools\$Pool" -ErrorAction SilentlyContinue)) {
    throw "App pool '$Pool' not found. Pass -Pool <name>. Nothing was changed."
}

function Copy-Files([string]$from, [string]$to) {
    # /E subfolders, never the server's settings or the uploaded product photos; nothing deleted
    robocopy $from $to /E /XF appsettings*.json /XD images logs /R:3 /W:2 /NFL /NDL /NP /NJH | Out-Host
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }
}

function Stop-Pool {
    if ((Get-WebAppPoolState -Name $Pool).Value -ne 'Stopped') { Stop-WebAppPool -Name $Pool }
    for ($i = 0; $i -lt 30 -and (Get-WebAppPoolState -Name $Pool).Value -ne 'Stopped'; $i++) { Start-Sleep -Seconds 1 }
    Start-Sleep -Seconds 2   # let the worker process let go of PosApi.dll
}

if ($Rollback) {
    $last = Get-ChildItem $backups -Directory -Filter "$Site-*" | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $last) { throw "No backup of $Site in $backups." }
    Write-Host "== Rolling $Site back to $($last.Name)"
    Stop-Pool
    try { Copy-Files $last.FullName $SiteRoot } finally { Start-WebAppPool -Name $Pool }
} else {
    if (-not $Zip -or -not (Test-Path $Zip)) { throw "Package not found: $Zip" }
    $staging = Join-Path $deploy "staging\$Site-$stamp"
    Write-Host "== Unzipping $Zip"
    Expand-Archive -Path $Zip -DestinationPath $staging -Force
    if (-not (Test-Path (Join-Path $staging 'PosApi.dll')) -or -not (Test-Path (Join-Path $staging 'wwwroot\sw.js'))) {
        throw "$Zip isn't a SparkPOS site package (no PosApi.dll or wwwroot\sw.js). Nothing was changed."
    }
    if (Get-ChildItem $staging -Filter 'appsettings*.json') {
        throw "$Zip contains an appsettings file; it must never replace the server's. Nothing was changed."
    }

    $backup = Join-Path $backups "$Site-$stamp"
    Write-Host "== Backing up $SiteRoot to $backup"
    robocopy $SiteRoot $backup /E /XD images logs /R:1 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Backup failed (robocopy $LASTEXITCODE). Nothing was changed." }
    Get-ChildItem $backups -Directory -Filter "$Site-*" | Sort-Object Name -Descending | Select-Object -Skip 5 |
        Remove-Item -Recurse -Force

    Write-Host "== Stopping $Pool, copying, starting"
    Stop-Pool
    try { Copy-Files $staging $SiteRoot } finally { Start-WebAppPool -Name $Pool }
    Remove-Item $staging -Recurse -Force
    Remove-Item $Zip -Force
}

if ($HealthUrl) {
    $url = $HealthUrl.TrimEnd('/') + '/health'
    for ($i = 1; $i -le 10; $i++) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10
            if ($r.StatusCode -eq 200) { Write-Host "== $url : $($r.Content)"; break }
        } catch { if ($i -eq 10) { throw "$url didn't answer after the update: check the site (or run with -Rollback)." } }
        Start-Sleep -Seconds 3
    }
}
Write-Host "== Done: $Site"
