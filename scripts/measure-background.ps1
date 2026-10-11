param(
    [ValidateRange(5, 60)]
    [int]$Seconds = 20
)

$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\') + '\'
$taskThreads = [int]$env:NUMBER_OF_PROCESSORS

function Get-CompanionProcesses {
    @(Get-Process | Where-Object {
        $_.ProcessName -in @('electron', 'Street Brawl Companion', 'ScreenReader') -and
        $_.Path -and $_.Path.StartsWith($taskWorkspace, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Test-DeadlockRunning {
    # Current installed executable verified locally as deadlock.exe. The old
    # citadel name alone is insufficient. Presence does not establish match data.
    [bool](Get-Process -Name deadlock, citadel -ErrorAction SilentlyContinue)
}

$taskInitial = Get-CompanionProcesses
if ($taskInitial.Count -eq 0) {
    throw 'Open the companion before measuring its background resources.'
}
$taskStartIdentities = @($taskInitial | ForEach-Object { '{0}:{1}' -f $_.Id, $_.StartTime.Ticks } | Sort-Object)
$taskStartCpuSeconds = ($taskInitial | Measure-Object -Property CPU -Sum).Sum
$taskSamples = [Collections.Generic.List[object]]::new()
$taskSetStable = $true
$taskGameThroughout = Test-DeadlockRunning
$taskWatch = [Diagnostics.Stopwatch]::StartNew()
while ($taskWatch.Elapsed.TotalSeconds -lt $Seconds) {
    $taskRemainingMs = [int][math]::Ceiling(($Seconds - $taskWatch.Elapsed.TotalSeconds) * 1000)
    Start-Sleep -Milliseconds ([math]::Min(2000, [math]::Max(1, $taskRemainingMs)))
    $taskCurrent = Get-CompanionProcesses
    $taskIdentities = @($taskCurrent | ForEach-Object { '{0}:{1}' -f $_.Id, $_.StartTime.Ticks } | Sort-Object)
    if (($taskStartIdentities -join ',') -ne ($taskIdentities -join ',')) { $taskSetStable = $false }
    $taskGameThroughout = $taskGameThroughout -and (Test-DeadlockRunning)
    $taskSamples.Add([pscustomobject]@{
        CpuSeconds = ($taskCurrent | Measure-Object -Property CPU -Sum).Sum
        WorkingSetMB = ($taskCurrent | Measure-Object -Property WorkingSet64 -Sum).Sum / 1MB
        PrivateCommittedMB = ($taskCurrent | Measure-Object -Property PrivateMemorySize64 -Sum).Sum / 1MB
    })
}
$taskWatch.Stop()
$taskElapsedSeconds = $taskWatch.Elapsed.TotalSeconds
$taskCpuPercent = $null
if ($taskSetStable -and $taskThreads -gt 0) {
    $taskCpuPercent = [math]::Round(
        100 * [math]::Max(0, ($taskSamples[-1].CpuSeconds - $taskStartCpuSeconds)) / ($taskElapsedSeconds * $taskThreads), 4
    )
}
[pscustomobject]@{
    SchemaVersion = 1
    MeasuredAtUtc = [DateTime]::UtcNow.ToString('o')
    Scope = 'Already-running companion and ScreenReader processes in this workspace; no game frame-rate measurement.'
    DurationSeconds = [math]::Round($taskElapsedSeconds, 2)
    LogicalProcessors = $taskThreads
    CompanionProcessCount = $taskInitial.Count
    ProcessSetStable = $taskSetStable
    DeadlockRunningThroughout = $taskGameThroughout
    AverageTotalCpuPercent = $taskCpuPercent
    PeakSampledWorkingSetSumMB = [math]::Round(($taskSamples | Measure-Object -Property WorkingSetMB -Maximum).Maximum, 1)
    PeakSampledPrivateCommittedSumMB = [math]::Round(($taskSamples | Measure-Object -Property PrivateCommittedMB -Maximum).Maximum, 1)
    MemoryNote = 'Working-set sums may double-count shared pages. Private committed memory is not resident physical RAM.'
    GameFrameRateMeasured = $false
    ReaderProcessPresent = [bool]($taskInitial | Where-Object { $_.ProcessName -eq 'ScreenReader' })
} | ConvertTo-Json
