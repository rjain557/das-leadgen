<#
.SYNOPSIS
  Creates a Windows Task Scheduler job to run the Danielian Pursuit Intelligence
  pipeline weekly.

.DESCRIPTION
  Registers a scheduled task that runs every Monday at 6:00 AM PT (the Brief
  lands at the start of Deborah's week — spec §10):
    1. Runs the full pipeline + Brief (run-all-layers.js --brief)
    2. Emails the weekly Pursuit Intelligence Brief (email-brief.ps1)

.USAGE
  powershell -ExecutionPolicy Bypass -File scripts/setup-weekly-schedule.ps1
  powershell -ExecutionPolicy Bypass -File scripts/setup-weekly-schedule.ps1 -Remove
#>

param(
    [switch]$Remove,
    [string]$DayOfWeek = "Monday",
    [string]$Time = "06:00"
)

$TaskName = "DAS-LeadGen-Weekly"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task: $TaskName"
    exit 0
}

# Build the command that runs all 3 steps
$script = @"
Set-Location '$ProjectRoot'
Write-Output "=== Danielian Pursuit Intelligence Run: `$(Get-Date) ==="

# Step 1: Run pipeline + build the weekly Brief (report is built inside)
Write-Output "Running pipeline + Brief..."
& node scripts/run-all-layers.js --brief 2>&1 | Tee-Object -FilePath runs/last-scheduled-run.log

# Step 2: Email the weekly Brief (honors DAS_EMAIL_ENABLED + -Send gate)
Write-Output "Sending weekly Brief..."
& powershell -ExecutionPolicy Bypass -File scripts/email-brief.ps1 -Send 2>&1

Write-Output "=== Done: `$(Get-Date) ==="
"@

$scriptPath = Join-Path $ProjectRoot "scripts\weekly-run.ps1"
$script | Out-File -FilePath $scriptPath -Encoding UTF8
Write-Host "Created run script: $scriptPath"

# Parse time
$timeParts = $Time -split ":"
$hour = [int]$timeParts[0]
$minute = [int]$timeParts[1]

# Create trigger: weekly on specified day
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $DayOfWeek -At "${hour}:${minute}"

# Action: run PowerShell with the weekly script
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`"" `
    -WorkingDirectory $ProjectRoot

# Settings
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

# Register
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName $TaskName `
    -Trigger $trigger `
    -Action $action `
    -Settings $settings `
    -Description "Danielian Pursuit Intelligence — weekly pipeline + Brief email" `
    -RunLevel Highest

Write-Host ""
Write-Host "Scheduled task created: $TaskName"
Write-Host "  Schedule: Every $DayOfWeek at $Time"
Write-Host "  Steps: Pipeline + Brief -> Email weekly Brief"
Write-Host ""
Write-Host "To remove: powershell -File scripts/setup-weekly-schedule.ps1 -Remove"
Write-Host "To test now: powershell -File scripts/weekly-run.ps1"
