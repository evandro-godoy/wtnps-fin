<#
.SYNOPSIS
    Stops the WTNPS Fin monitor background process started by
    scripts\start_background.ps1.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $RepoRoot "logs\wtnps_monitor.pid"

if (-not (Test-Path $PidFile)) {
    Write-Warning "No PID file found at $PidFile. Is the monitor running?"
    exit 1
}

$processId = Get-Content $PidFile | Select-Object -First 1

try {
    Stop-Process -Id $processId -ErrorAction Stop
    Write-Host "Monitor process (PID=$processId) stopped."
} catch {
    Write-Warning "Could not stop process $processId. It may have already exited."
} finally {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
}
