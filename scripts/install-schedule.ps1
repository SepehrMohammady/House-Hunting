<#
.SYNOPSIS
  Registers the house finder on this PC, at the times in config.json.

.NOTE
  The scanner normally runs on the web server instead - see scripts/vps-setup.sh.
  This script remains for running it locally, e.g. to test a change.

.DESCRIPTION
  Creates a single Windows Scheduled Task, one trigger per time in config.json.

  Notes on the choices here:
    * Runs as the current user, interactively. Idealista needs a visible browser
      window to clear its bot challenge, which an SYSTEM-level task cannot show.
    * StartWhenAvailable catches up a run the machine slept through - without it
      a laptop that was closed at the scheduled time simply loses that report.
    * No -RunLevel Highest: nothing here needs administrator rights.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1 -Remove
#>

param(
    [switch]$Remove,
    [string]$TaskName = "Genoa House Finder"
)

$ErrorActionPreference = "Stop"

# Project root is the parent of this script's folder.
$ProjectDir = Split-Path -Parent $PSScriptRoot
$RunScript  = Join-Path $ProjectDir "scripts\run.cmd"

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Yellow
    } else {
        Write-Host "No scheduled task named '$TaskName' found." -ForegroundColor Yellow
    }
    return
}

if (-not (Test-Path $RunScript)) {
    throw "Cannot find $RunScript - run this from the project's scripts folder."
}

# Verify node is actually reachable, because a scheduled task failing overnight
# with a silent "file not found" is painful to diagnose after the fact.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "node was not found on PATH. Install Node.js 18+ before scheduling."
}
Write-Host "Using node at $($node.Source)" -ForegroundColor DarkGray

$action = New-ScheduledTaskAction -Execute $RunScript -WorkingDirectory $ProjectDir

# config.json is the single source of truth for run times, shared with the
# server's systemd timer, so the two can never drift apart.
$configPath = Join-Path $ProjectDir "config.json"
$times = (Get-Content $configPath -Raw | ConvertFrom-Json).schedule.times
if (-not $times) { throw "config.json has no schedule.times" }

$triggers = foreach ($t in $times) {
    New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($t, "HH:mm", $null))
}
Write-Host "Times from config.json: $($times -join ', ')" -ForegroundColor DarkGray

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Replacing existing task '$TaskName'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName    $TaskName `
    -Action      $action `
    -Trigger     $triggers `
    -Settings    $settings `
    -Principal   $principal `
    -Description "Scans Italian rental portals for 2-bedroom furnished flats in Genoa and writes an HTML report." | Out-Null

Write-Host ""
Write-Host "Scheduled '$TaskName' at $($times -join ', ') daily." -ForegroundColor Green
Write-Host "  Project : $ProjectDir"
Write-Host "  Reports : $ProjectDir\reports\latest.html"
Write-Host "  Logs    : $ProjectDir\data\run.log"
Write-Host ""
Write-Host "Run it once now to check:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove it later with    :  .\scripts\install-schedule.ps1 -Remove"
