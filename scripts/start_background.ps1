<#
.SYNOPSIS
    Starts the WTNPS Fin monitor server in the background on Windows.

.DESCRIPTION
    Launches `poetry run wtnps-monitor` as a hidden background process,
    redirecting stdout/stderr to logs\wtnps_monitor.log, and opens the
    /monitor page in the default browser once the server is reachable.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\start_background.ps1
#>

[CmdletBinding()]
param(
    [string]$HostName = "127.0.0.1",
    [int]$Port = 8100
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogsDir = Join-Path $RepoRoot "logs"
$LogFile = Join-Path $LogsDir "wtnps_monitor.log"
$PidFile = Join-Path $LogsDir "wtnps_monitor.pid"

New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null

Write-Host "Starting WTNPS Fin monitor in background (host=$HostName port=$Port)..."

$process = Start-Process -FilePath "poetry" `
    -ArgumentList @("run", "wtnps-monitor", "--host", $HostName, "--port", $Port) `
    -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError "$LogFile.err" `
    -PassThru

$process.Id | Out-File -FilePath $PidFile -Encoding ascii -Force

Write-Host "Monitor started. PID=$($process.Id)"
Write-Host "Logs: $LogFile"
Write-Host "Stop it with: scripts\stop_background.ps1"
