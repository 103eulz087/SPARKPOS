# =====================================================================
#  TabletPOS - Windows Server deployment
#  Run in an elevated PowerShell from the solution root:
#     .\scripts\windows-setup.ps1 -SqlServer "localhost" -SqlUser "sa" -SqlPassword "..."
# =====================================================================
param(
  [string]$SqlServer   = "localhost",
  [string]$SqlUser     = "sa",
  [string]$SqlPassword = "YourStrong!Pass1",
  [string]$Database    = "TabletPOS",
  [string]$InstallPath = "C:\TabletPOS"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host "==> Creating the database" -ForegroundColor Cyan
sqlcmd -S $SqlServer -U $SqlUser -P $SqlPassword -Q "IF DB_ID('$Database') IS NULL CREATE DATABASE [$Database]"

Write-Host "==> Applying schema, procedures and seed data" -ForegroundColor Cyan
sqlcmd -S $SqlServer -U $SqlUser -P $SqlPassword -d $Database -i database\01_schema.sql -I
sqlcmd -S $SqlServer -U $SqlUser -P $SqlPassword -d $Database -i database\02_procedures.sql -I
sqlcmd -S $SqlServer -U $SqlUser -P $SqlPassword -d $Database -i database\03_seed.sql -I

Write-Host "==> Building the front end" -ForegroundColor Cyan
Push-Location web
npm install
npm run build
Pop-Location

Write-Host "==> Publishing the API" -ForegroundColor Cyan
dotnet publish src\PosApi\PosApi.csproj -c Release -o "$InstallPath\api"
New-Item -ItemType Directory -Force -Path "$InstallPath\api\wwwroot" | Out-Null
Copy-Item -Recurse -Force web\dist\* "$InstallPath\api\wwwroot\"

Write-Host "==> Publishing the print agent" -ForegroundColor Cyan
dotnet publish src\PrintAgent\PrintAgent.csproj -c Release -o "$InstallPath\printagent"

Write-Host "==> Writing production appsettings" -ForegroundColor Cyan
$jwt = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
@"
{
  "ConnectionStrings": {
    "Default": "Server=$SqlServer;Database=$Database;User Id=$SqlUser;Password=$SqlPassword;TrustServerCertificate=True;Encrypt=False;"
  },
  "Jwt": { "Key": "$jwt", "Issuer": "TabletPOS", "ExpiryHours": 12 },
  "PrintAgent": { "BaseUrl": "http://localhost:5099" },
  "AllowedHosts": "*"
}
"@ | Set-Content "$InstallPath\api\appsettings.Production.json" -Encoding UTF8

Write-Host "==> Registering Windows services" -ForegroundColor Cyan
sc.exe create TabletPosApi binPath= "$InstallPath\api\PosApi.exe" start= auto DisplayName= "TabletPOS API" | Out-Null
sc.exe create TabletPosPrintAgent binPath= "$InstallPath\printagent\PrintAgent.exe" start= auto DisplayName= "TabletPOS Print Agent" | Out-Null

Write-Host "==> Opening the firewall on port 5000" -ForegroundColor Cyan
New-NetFirewallRule -DisplayName "TabletPOS API" -Direction Inbound -LocalPort 5000 -Protocol TCP -Action Allow | Out-Null

Start-Service TabletPosApi
Start-Service TabletPosPrintAgent

Write-Host ""
Write-Host "Deployment complete." -ForegroundColor Green
Write-Host "  Local:    http://localhost:5000"
Write-Host "  Tablets:  http://$env:COMPUTERNAME:5000  (or the server's LAN IP)"
Write-Host ""
Write-Host "Change the seeded passwords immediately: admin/admin123, super/super123, cashier/cashier123" -ForegroundColor Yellow
