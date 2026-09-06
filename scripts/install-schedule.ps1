<#
.SYNOPSIS
  Registers the house finder to run at 06:00, 12:00 and 18:00 every day.

.DESCRIPTION
  Creates a single Windows Scheduled Task with three daily triggers.

  Notes on the choices here:
    * Runs as the current user, interactively. Idealista needs a visible browser
      window to clear its bot challenge, which an SYSTEM-level task cannot show.
    * StartWhenAvailable catches up a run the machine slept through - without it
      a laptop that was closed at 06:00 simply loses that report.
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

# Verify node is actually reachable, because a scheduled task failing at 06:00
# with a silent "file not found" is painful to diagnose after the fact.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "node was not found on PATH. Install Node.js 18+ before scheduling."
}
Write-Host "Using node at $($node.Source)" -ForegroundColor DarkGray

$action = New-ScheduledTaskAction -Execute $RunScript -WorkingDirectory $ProjectDir

$triggers = @(
    New-ScheduledTaskTrigger -Daily -At 6am
    New-ScheduledTaskTrigger -Daily -At 12pm
    New-ScheduledTaskTrigger -Daily -At 6pm
)

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
Write-Host "Scheduled '$TaskName' at 06:00, 12:00 and 18:00 daily." -ForegroundColor Green
Write-Host "  Project : $ProjectDir"
Write-Host "  Reports : $ProjectDir\reports\latest.html"
Write-Host "  Logs    : $ProjectDir\data\run.log"
Write-Host ""
Write-Host "Run it once now to check:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Remove it later with    :  .\scripts\install-schedule.ps1 -Remove"
