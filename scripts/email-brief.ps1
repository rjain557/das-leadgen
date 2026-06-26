<#
.SYNOPSIS
  Emails the weekly "Danielian Pursuit Intelligence" Brief via Microsoft Graph.

.DESCRIPTION
  Reads the latest data/output/brief-*.html and sends it as a branded HTML email
  using the Technijian HiringPipeline-Automation app registration. Credentials
  load AT RUNTIME from the OneDrive keys vault (das-leadgen.env, then
  bbc-leadgen.env) — never hardcoded/committed.

  Safe by default: without -Send it performs a DRY RUN (writes nothing, sends
  nothing). DAS_EMAIL_ENABLED=true in the vault also gates real sends.

.USAGE
  powershell -ExecutionPolicy Bypass -File scripts/email-brief.ps1            # dry run
  powershell -ExecutionPolicy Bypass -File scripts/email-brief.ps1 -Send
  powershell -ExecutionPolicy Bypass -File scripts/email-brief.ps1 -BriefPath data/output/brief-2026-06-29.html -Send
#>

param(
    # PHASE-0: set to Deborah Muro (Director of BD) + cc Victor Alvarez-Duran.
    # Defaults to the internal sender so a misfire never reaches the client.
    [string[]]$Recipient = @("RJain@technijian.com"),
    [string[]]$Cc = @(),
    [string]$BriefPath,
    [string]$Subject,
    [switch]$Send
)

$ErrorActionPreference = "Stop"

# ── Load credentials from the vault (KEY=VALUE lines) ──
function Import-VaultEnv {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $k, $v = $line -split "=", 2
            if ($k) { Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim() -ErrorAction SilentlyContinue }
        }
    }
}
$VaultDir = Join-Path $env:USERPROFILE "OneDrive - Technijian, Inc\Documents\VSCODE\keys"
Import-VaultEnv (Join-Path $VaultDir "bbc-leadgen.env")
Import-VaultEnv (Join-Path $VaultDir "das-leadgen.env")   # optional override (not required)

# Resolve Microsoft Graph creds from the canonical vault file (no creds in repo).
function Get-VaultMdValue {
    param([string]$Path, [string]$Label)
    if (-not (Test-Path $Path)) { return $null }
    $m = Select-String -Path $Path -Pattern ("{0}\s*:?\**\s*`?([^`\s]+)" -f [regex]::Escape($Label)) -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value } else { return $null }
}
$GraphMd = Join-Path $VaultDir "m365-graph.md"
$AppClientId  = if ($env:GRAPH_CLIENT_ID)     { $env:GRAPH_CLIENT_ID }     else { Get-VaultMdValue $GraphMd "App Client ID" }
$TenantId     = if ($env:GRAPH_TENANT_ID)     { $env:GRAPH_TENANT_ID }     else { Get-VaultMdValue $GraphMd "Tenant ID" }
$ClientSecret = if ($env:GRAPH_CLIENT_SECRET) { $env:GRAPH_CLIENT_SECRET } else { Get-VaultMdValue $GraphMd "Client Secret" }
$SenderId     = if ($env:GRAPH_SENDER)        { $env:GRAPH_SENDER }        else { "RJain@technijian.com" }

# ── Resolve the Brief HTML ──
$OutputDir = Join-Path $PSScriptRoot "..\data\output"
if (-not $BriefPath) {
    $files = Get-ChildItem -Path $OutputDir -Filter "brief-*.html" -ErrorAction SilentlyContinue | Sort-Object Name -Descending
    if (-not $files -or $files.Count -eq 0) { Write-Error "No brief-*.html found in $OutputDir. Run: npm run brief"; exit 1 }
    $BriefPath = $files[0].FullName
}
Write-Host "Brief: $BriefPath"
$html = Get-Content $BriefPath -Raw
if (-not $Subject) {
    $stamp = (Get-Item $BriefPath).BaseName -replace "brief-", ""
    $Subject = "Danielian Pursuit Intelligence — Weekly Brief ($stamp)"
}

# ── Dry-run gate ──
$emailEnabled = ($env:DAS_EMAIL_ENABLED -eq "true")
if (-not $Send -or -not $emailEnabled) {
    Write-Host "DRY RUN (no email sent)." -ForegroundColor Yellow
    Write-Host "  To:      $($Recipient -join ', ')"
    Write-Host "  Cc:      $($Cc -join ', ')"
    Write-Host "  Subject: $Subject"
    Write-Host "  Gate:    -Send=$Send  DAS_EMAIL_ENABLED=$($env:DAS_EMAIL_ENABLED)"
    if (-not $emailEnabled) { Write-Host "  (Set DAS_EMAIL_ENABLED=true in das-leadgen.env AND pass -Send to actually deliver.)" }
    exit 0
}

if (-not $AppClientId -or -not $TenantId -or -not $ClientSecret) {
    Write-Error "Missing GRAPH_CLIENT_ID / GRAPH_TENANT_ID / GRAPH_CLIENT_SECRET in the vault. Add them to das-leadgen.env (reuse the HiringPipeline-Automation app reg)."
    exit 1
}

# ── Send via Microsoft Graph ──
Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
$secure = ConvertTo-SecureString $ClientSecret -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential($AppClientId, $secure)
Connect-MgGraph -TenantId $TenantId -ClientSecretCredential $cred -NoWelcome

$toList = @($Recipient | ForEach-Object { @{ EmailAddress = @{ Address = $_ } } })
$ccList = @($Cc | ForEach-Object { @{ EmailAddress = @{ Address = $_ } } })
$attachment = @{
    "@odata.type" = "#microsoft.graph.fileAttachment"
    Name = (Split-Path $BriefPath -Leaf)
    ContentType = "text/html"
    ContentBytes = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($html))
}
$params = @{
    Message = @{
        Subject = $Subject
        Body = @{ ContentType = "HTML"; Content = $html }
        ToRecipients = $toList
        CcRecipients = $ccList
        Attachments = @($attachment)
    }
    SaveToSentItems = $true
}
Send-MgUserMail -UserId $SenderId -BodyParameter $params
Write-Host "Sent Danielian Pursuit Intelligence Brief to $($Recipient -join ', ')" -ForegroundColor Green
