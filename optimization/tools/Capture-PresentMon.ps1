# Offline authoring verified only. Running this script performs a user-requested ETW capture.
# No game launch, input, game memory reading, injection, mods, driver or registry writes.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')][string]$Profile,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')][string]$RunId,
    [Parameter(Mandatory = $true)][ValidateLength(1, 128)][string]$ScenarioId,
    [Parameter(Mandatory = $true)][string]$MatchingMetadataPath,
    [Parameter(Mandatory = $true)][switch]$ForegroundConfirmed,
    [Parameter(Mandatory = $true)][switch]$SceneConfirmed,
    [string]$PresentMonPath,
    [switch]$Download,
    [switch]$ShaderCacheWarm,
    [switch]$FrameGenerationDisabled,
    [ValidateRange(30, 1800)][int]$Seconds = 130,
    [ValidateRange(0, 600)][int]$WarmupSeconds = 10,
    [ValidateRange(0, 60)][int]$DelaySeconds = 10,
    [ValidateRange(0, 2147483647)][int]$GameProcessId = 0,
    [ValidateSet('deadlock.exe')][string]$ProcessName = 'deadlock.exe',
    [string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'PresentMon capture requires Windows.' }
if (-not $ForegroundConfirmed -or -not $SceneConfirmed) { throw 'Explicit -ForegroundConfirmed and -SceneConfirmed declarations are required.' }
if ($Seconds - $WarmupSeconds -lt 30) { throw 'Leave at least 30 seconds after the declared analysis warmup.' }
if ($Download -and $PresentMonPath) { throw 'Choose either -Download or an explicit -PresentMonPath.' }

$captureToolVersion = '2.6.0'
$captureToolSha = 'b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af'
$captureToolUri = 'https://github.com/GameTechDev/PresentMon/releases/download/v2.6.0/PresentMon-2.6.0-x64.exe'
$captureProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
function Get-CaptureProperty {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { if ($Object.Contains($Name)) { return $Object[$Name] }; return $null }
    $captureProperty = $Object.PSObject.Properties[$Name]
    if ($null -ne $captureProperty) { return $captureProperty.Value }; return $null
}
function Assert-CaptureObject {
    param($Object, [string]$Name)
    if ($null -eq $Object -or $Object -is [Array] -or $Object -is [string] -or $Object -is [ValueType]) { throw "$Name must be a JSON object." }
}
function Set-CaptureProperty {
    param($Object, [string]$Name, $Value)
    if ($Object -is [System.Collections.IDictionary]) { $Object[$Name] = $Value }
    else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force }
}
function Get-CaptureSha {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Write-CaptureUtf8 {
    param([string]$Path, [string]$Text)
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}
function Quote-CapturePowerShell {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}
function Remove-CaptureTemporaryFile {
    param([string]$Path, [string]$ExpectedDirectory)
    $captureAbsoluteTemporary = [IO.Path]::GetFullPath($Path)
    if (-not [String]::Equals([IO.Path]::GetDirectoryName($captureAbsoluteTemporary), [IO.Path]::GetFullPath($ExpectedDirectory).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Temporary cleanup path is outside its expected directory.' }
    if (Test-Path -LiteralPath $captureAbsoluteTemporary) { Remove-Item -LiteralPath $captureAbsoluteTemporary }
}
function Get-CaptureAnalysisMinimumSeconds {
    param([int]$DurationSeconds)
    if ($DurationSeconds -lt 30) { throw 'Analysis requires at least 30 declared seconds.' }
    return [Math]::Min($DurationSeconds, 60)
}
function Get-CaptureTimestampUnit {
    param($DeclaredUnit)
    # Pinned CommandLine.cpp selects MilliSeconds; this wrapper does not use QPC/date flags.
    if ($null -ne $DeclaredUnit -and $DeclaredUnit -cne 'milliseconds') { throw 'Pinned v2 capture emits milliseconds; matching timestampUnit conflicts with the actual CLI schema.' }
    return 'milliseconds'
}
function Test-CaptureCollectorDeadline {
    param([double]$ElapsedSeconds, [double]$DeadlineSeconds)
    return $ElapsedSeconds -ge $DeadlineSeconds
}
function Get-CaptureEtwLossCounters {
    param([string]$ToolLog)
    $captureCounters = [ordered]@{ etwEventsLost = $null; etwBuffersLost = $null; overflowedPresents = $null }
    foreach ($captureCounter in @(@('etwEventsLost', 'EventsLost=(\d+)'), @('etwBuffersLost', 'BuffersLost=(\d+)'), @('overflowedPresents', 'OverflowedPresents=(\d+)'))) {
        $captureCounterMatches = [regex]::Matches($ToolLog, $captureCounter[1])
        if ($captureCounterMatches.Count -gt 0) { $captureCounters[$captureCounter[0]] = [long](($captureCounterMatches | ForEach-Object { [long]$_.Groups[1].Value } | Measure-Object -Maximum).Maximum) }
    }
    # Pinned MainThread.cpp says "overflowed present events", not "overflowed presents".
    foreach ($captureWarningCounter in @(@('etwEventsLost', '(\d+) ETW events were lost'), @('etwBuffersLost', '(\d+) ETW buffers were lost'), @('overflowedPresents', '(\d+)\s+overflowed (?:presents|present events)'))) {
        $captureCounterMatches = [regex]::Matches($ToolLog, $captureWarningCounter[1], [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($captureCounterMatches.Count -gt 0) {
            $captureMaximum = [long](($captureCounterMatches | ForEach-Object { [long]$_.Groups[1].Value } | Measure-Object -Maximum).Maximum)
            if ($null -eq $captureCounters[$captureWarningCounter[0]] -or $captureMaximum -gt $captureCounters[$captureWarningCounter[0]]) { $captureCounters[$captureWarningCounter[0]] = $captureMaximum }
        }
    }
    return $captureCounters
}
function Assert-CaptureCollectorIdentity {
    param([int]$ActualId, [long]$ActualStartTicks, [string]$ActualExecutable,
        [int]$ExpectedId, [long]$ExpectedStartTicks, [string]$ExpectedExecutable)
    if ($ExpectedId -lt 1 -or $ExpectedStartTicks -lt 1 -or [String]::IsNullOrWhiteSpace($ExpectedExecutable)) { throw 'Collector ownership was not recorded.' }
    if ($ActualId -ne $ExpectedId -or $ActualStartTicks -ne $ExpectedStartTicks -or
        -not [String]::Equals([IO.Path]::GetFullPath($ActualExecutable), [IO.Path]::GetFullPath($ExpectedExecutable), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Collector identity changed; refusing termination.'
    }
}
function Stop-CaptureOwnedCollector {
    param([Diagnostics.Process]$Process, [int]$ExpectedId, [long]$ExpectedStartTicks, [string]$ExpectedExecutable)
    if ($null -eq $Process) { throw 'No wrapper-owned collector process.' }
    $Process.Refresh()
    if ($Process.HasExited) { return $true }
    Assert-CaptureCollectorIdentity -ActualId $Process.Id -ActualStartTicks $Process.StartTime.ToUniversalTime().Ticks -ActualExecutable $Process.MainModule.FileName -ExpectedId $ExpectedId -ExpectedStartTicks $ExpectedStartTicks -ExpectedExecutable $ExpectedExecutable
    # Terminate only this Start-Process instance after PID/lifetime/executable checks.
    # No PID/name lookup, process tree termination, game or unrelated session control.
    $Process.Kill()
    return $Process.WaitForExit(5000)
}

$captureMetadataPath = (Resolve-Path -LiteralPath $MatchingMetadataPath).Path
$captureMatching = Get-Content -LiteralPath $captureMetadataPath -Raw | ConvertFrom-Json
Assert-CaptureObject $captureMatching 'Matching metadata'
$captureDeclaredCollector = Get-CaptureProperty $captureMatching 'collector'
if ($null -ne $captureDeclaredCollector) { Assert-CaptureObject $captureDeclaredCollector 'collector' }
$captureTimestampUnit = Get-CaptureTimestampUnit (Get-CaptureProperty $captureDeclaredCollector 'timestampUnit')
$captureContext = Get-CaptureProperty $captureMatching 'comparisonContext'
Assert-CaptureObject $captureContext 'comparisonContext'
foreach ($captureKey in @('machineId', 'gameBuildId', 'driverVersion', 'scenarioId')) {
    $captureValue = Get-CaptureProperty $captureContext $captureKey
    if ($null -eq $captureValue -or [String]::IsNullOrWhiteSpace([string]$captureValue) -or [string]$captureValue -eq 'unknown') { throw "comparisonContext requires an explicit $captureKey." }
}
if ([string](Get-CaptureProperty $captureContext 'scenarioId') -ne $ScenarioId) { throw 'ScenarioId must match comparisonContext.scenarioId.' }
$captureEnvironment = Get-CaptureProperty $captureMatching 'environment'
if ($null -eq $captureEnvironment) { $captureEnvironment = [pscustomobject]@{} }; Assert-CaptureObject $captureEnvironment 'environment'
$captureScenario = Get-CaptureProperty $captureMatching 'scenario'
if ($null -eq $captureScenario) { $captureScenario = [pscustomobject]@{} }; Assert-CaptureObject $captureScenario 'scenario'
Set-CaptureProperty $captureScenario 'id' $ScenarioId
# Absent switches remain unknown. Prior metadata cannot silently supply these per-run declarations.
Set-CaptureProperty $captureEnvironment 'shaderCacheWarm' $(if ($ShaderCacheWarm) { $true } else { $null })
Set-CaptureProperty $captureEnvironment 'frameGenerationDisabled' $(if ($FrameGenerationDisabled) { $true } else { $null })
Set-CaptureProperty $captureEnvironment 'sceneConfirmed' $true

if (-not $OutputDirectory) { $OutputDirectory = Join-Path (Join-Path $captureProjectRoot 'local\captures') $RunId }
$captureOutput = [IO.Path]::GetFullPath($OutputDirectory)
$captureCsvPath = Join-Path $captureOutput 'capture.csv'
$captureJsonPath = Join-Path $captureOutput 'capture.json'
$captureLogPath = Join-Path $captureOutput 'tool-log.txt'
$captureStdoutPath = Join-Path $captureOutput 'tool-stdout.tmp'
$captureStderrPath = Join-Path $captureOutput 'tool-stderr.tmp'
foreach ($capturePath in @($captureCsvPath, $captureJsonPath, $captureLogPath, $captureStdoutPath, $captureStderrPath)) {
    if (Test-Path -LiteralPath $capturePath) { throw "Capture output already exists: $capturePath. Use a new RunId/output directory." }
    if ([String]::Equals($capturePath, $captureMetadataPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Capture output must not overwrite matching metadata.' }
}
New-Item -ItemType Directory -Path $captureOutput -Force | Out-Null

if ($Download) {
    $captureToolsDirectory = Join-Path $captureProjectRoot 'local\tools'
    New-Item -ItemType Directory -Path $captureToolsDirectory -Force | Out-Null
    $PresentMonPath = Join-Path $captureToolsDirectory 'PresentMon-2.6.0-x64.exe'
    if (-not (Test-Path -LiteralPath $PresentMonPath)) {
        $captureDownloadPath = Join-Path $captureToolsDirectory ('PresentMon-' + [Guid]::NewGuid().ToString('N') + '.download')
        try {
            Invoke-WebRequest -Uri $captureToolUri -OutFile $captureDownloadPath -UseBasicParsing
            if ((Get-CaptureSha $captureDownloadPath) -ne $captureToolSha) { throw 'Official release SHA256 mismatch. Downloaded binary will not run.' }
            Move-Item -LiteralPath $captureDownloadPath -Destination $PresentMonPath
        } finally { Remove-CaptureTemporaryFile $captureDownloadPath $captureToolsDirectory }
    }
}
if (-not $PresentMonPath) { throw 'Provide -PresentMonPath for the pinned official executable, or explicitly choose -Download.' }
$captureExecutable = (Resolve-Path -LiteralPath $PresentMonPath).Path
if ((Get-CaptureSha $captureExecutable) -ne $captureToolSha) { throw 'PresentMon SHA256 mismatch. Only the pinned official v2.6.0 x64 release is supported.' }

$captureGameProcesses = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ProcessName)) -ErrorAction SilentlyContinue)
if ($GameProcessId -ne 0) { $captureGameProcesses = @($captureGameProcesses | Where-Object { $_.Id -eq $GameProcessId }) }
if ($captureGameProcesses.Count -ne 1) { throw 'Expected one running deadlock.exe. For multiple instances, pass -GameProcessId. This script does not launch the game.' }
$captureGame = $captureGameProcesses[0]
$captureGameId = $captureGame.Id
$captureGameStartTicks = $captureGame.StartTime.ToUniversalTime().Ticks
$captureLogicalProcessors = [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
if ($captureLogicalProcessors -lt 1) { throw 'Could not determine logical processor count.' }

if (-not ('DeadlockBenchmarkWindowProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeadlockBenchmarkWindowProbe {
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    public static uint ForegroundProcessId() {
        uint processId = 0;
        GetWindowThreadProcessId(GetForegroundWindow(), out processId);
        return processId;
    }
}
'@
}
function Get-CaptureResourceSnapshot {
    $captureSnapshotWarnings = @()
    $captureOs = $null; $captureMemory = $null; $captureCpu = $null; $captureProcess = $null
    try { $captureOs = Get-CimInstance Win32_OperatingSystem } catch { $captureSnapshotWarnings += 'OS memory counters unavailable.' }
    try { $captureMemory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory } catch { $captureSnapshotWarnings += 'Commit counters unavailable.' }
    try { $captureCpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" } catch { $captureSnapshotWarnings += 'Aggregate CPU utilization unavailable.' }
    try {
        $captureCurrentGame = Get-Process -Id $captureGameId -ErrorAction Stop
        if ($captureCurrentGame.StartTime.ToUniversalTime().Ticks -ne $captureGameStartTicks) { throw 'Game PID was reused.' }
        $captureProcess = [ordered]@{ processId = $captureGameId; cpuSeconds = $captureCurrentGame.TotalProcessorTime.TotalSeconds; workingSetBytes = $captureCurrentGame.WorkingSet64; privateCommittedBytes = $captureCurrentGame.PrivateMemorySize64 }
    } catch { $captureSnapshotWarnings += 'Original game process no longer available.' }
    return [ordered]@{
        capturedUtc = [DateTime]::UtcNow.ToString('o')
        system = [ordered]@{
            logicalProcessors = $captureLogicalProcessors
            cpuLoadPercent = Get-CaptureProperty $captureCpu 'PercentProcessorTime'
            availablePhysicalBytes = $(if ($null -ne $captureOs) { [long]$captureOs.FreePhysicalMemory * 1024 } else { $null })
            totalPhysicalBytes = $(if ($null -ne $captureOs) { [long]$captureOs.TotalVisibleMemorySize * 1024 } else { $null })
            committedBytes = Get-CaptureProperty $captureMemory 'CommittedBytes'
            commitLimitBytes = Get-CaptureProperty $captureMemory 'CommitLimit'
            percentCommitUsed = Get-CaptureProperty $captureMemory 'PercentCommittedBytesInUse'
        }
        game = $captureProcess; warnings = $captureSnapshotWarnings
    }
}

$captureSessionName = 'DeadlockBench-' + $RunId + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$captureArguments = @('--process_id', [string]$captureGameId, '--output_file', $captureCsvPath,
    '--v2_metrics', '--track_frame_type', '--track_etw_status', '--no_track_input',
    '--delay', [string]$DelaySeconds, '--timed', [string]$Seconds,
    '--terminate_after_timed', '--no_console_stats', '--session_name', $captureSessionName)
# Start-Process joins ArgumentList; explicitly quote the one path argument containing spaces.
$captureNativeArguments = @($captureArguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
$capturePre = Get-CaptureResourceSnapshot
Write-Host "PresentMon will record deadlock.exe after $DelaySeconds seconds for $Seconds seconds."
Write-Host 'Return to the declared scene and keep the game in the foreground. No gameplay input is automated.'
$captureWatch = [Diagnostics.Stopwatch]::StartNew()
$captureForegroundSamples = 0; $captureOtherForegroundSamples = 0; $captureProbeFailed = $false
$captureCollectorProcess = $null; $captureFailure = $null; $captureExitCode = $null
$captureCollectorId = 0; $captureCollectorStartTicks = 0; $captureCollectorExited = $true
$captureWatchdogGraceSeconds = 30; $captureCollectorDeadlineSeconds = $DelaySeconds + $Seconds + $captureWatchdogGraceSeconds
$captureWatchdogExpired = $false; $captureTerminationAttempted = $false
try {
    $captureCollectorProcess = Start-Process -FilePath $captureExecutable -ArgumentList $captureNativeArguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $captureStdoutPath -RedirectStandardError $captureStderrPath
    # Retain the returned process handle and creation time before any deadline action.
    $null = $captureCollectorProcess.Handle
    $captureCollectorId = $captureCollectorProcess.Id
    $captureCollectorStartTicks = $captureCollectorProcess.StartTime.ToUniversalTime().Ticks
    while (-not $captureCollectorProcess.WaitForExit(500)) {
        if (Test-CaptureCollectorDeadline -ElapsedSeconds $captureWatch.Elapsed.TotalSeconds -DeadlineSeconds $captureCollectorDeadlineSeconds) {
            $captureWatchdogExpired = $true
            $captureFailure = "PresentMon exceeded the $captureCollectorDeadlineSeconds-second wall deadline; capture is incomplete."
            $captureTerminationAttempted = $true
            if (-not (Stop-CaptureOwnedCollector -Process $captureCollectorProcess -ExpectedId $captureCollectorId -ExpectedStartTicks $captureCollectorStartTicks -ExpectedExecutable $captureExecutable)) {
                $captureFailure += ' Wrapper-owned collector did not exit within the 5-second cleanup wait.'
            }
            break
        }
        if ($captureWatch.Elapsed.TotalSeconds -ge $DelaySeconds -and $captureWatch.Elapsed.TotalSeconds -le $DelaySeconds + $Seconds) {
            try {
                $captureForegroundSamples++
                if ([DeadlockBenchmarkWindowProbe]::ForegroundProcessId() -ne $captureGameId) { $captureOtherForegroundSamples++ }
            } catch { $captureProbeFailed = $true }
        }
    }
    if ($captureCollectorProcess.HasExited) { $captureExitCode = $captureCollectorProcess.ExitCode }
} catch {
    if ($null -eq $captureFailure) { $captureFailure = $_.Exception.Message } else { $captureFailure += ' ' + $_.Exception.Message }
    # On another wrapper error, cleanup remains restricted to the owned collector.
    if ($null -ne $captureCollectorProcess) {
        try {
            if (-not $captureCollectorProcess.HasExited) {
                $captureTerminationAttempted = $true
                if (-not (Stop-CaptureOwnedCollector -Process $captureCollectorProcess -ExpectedId $captureCollectorId -ExpectedStartTicks $captureCollectorStartTicks -ExpectedExecutable $captureExecutable)) { $captureFailure += ' Collector cleanup wait expired.' }
            }
        } catch { $captureFailure += ' Collector cleanup failed: ' + $_.Exception.Message }
    }
}
finally {
    if ($null -ne $captureCollectorProcess) {
        try { $captureCollectorExited = $captureCollectorProcess.HasExited; if ($captureCollectorExited) { $captureExitCode = $captureCollectorProcess.ExitCode } } catch { $captureCollectorExited = $false }
    }
    $captureWatch.Stop()
}
$capturePost = Get-CaptureResourceSnapshot
$captureStdout = ''; $captureStderr = ''; $captureStdoutRead = $true; $captureStderrRead = $true
try { if (Test-Path -LiteralPath $captureStdoutPath) { $captureStdout = [IO.File]::ReadAllText($captureStdoutPath) } } catch { $captureStdoutRead = $false; $captureFailure += ' STDOUT is unavailable; original output file retained.' }
try { if (Test-Path -LiteralPath $captureStderrPath) { $captureStderr = [IO.File]::ReadAllText($captureStderrPath) } } catch { $captureStderrRead = $false; $captureFailure += ' STDERR is unavailable; original output file retained.' }
$captureToolLog = "STDOUT`n" + $captureStdout + "`nSTDERR`n" + $captureStderr + "`nWRAPPER STATUS`n" + $captureFailure
Write-CaptureUtf8 $captureLogPath $captureToolLog
if ($captureCollectorExited) {
    if ($captureStdoutRead) { Remove-CaptureTemporaryFile $captureStdoutPath $captureOutput }
    if ($captureStderrRead) { Remove-CaptureTemporaryFile $captureStderrPath $captureOutput }
}
$captureEtw = Get-CaptureEtwLossCounters $captureToolLog
$captureCsvExists = Test-Path -LiteralPath $captureCsvPath
$captureCsvBytes = $(if ($captureCsvExists) { (Get-Item -LiteralPath $captureCsvPath).Length } else { 0 })
$captureCompleted = $null -eq $captureFailure -and $captureCollectorExited -and -not $captureWatchdogExpired -and $captureExitCode -eq 0 -and $captureCsvBytes -gt 0 -and $captureWatch.Elapsed.TotalSeconds -ge ($DelaySeconds + $Seconds - 1)
$captureFocusValid = -not $captureProbeFailed -and $captureForegroundSamples -gt 0 -and $captureOtherForegroundSamples -eq 0
Set-CaptureProperty $captureEnvironment 'foregroundVerifiedDuringCapture' $captureFocusValid
$captureWarnings = @()
if ($captureWatchdogExpired) { $captureWarnings += 'Collector wall deadline expired; this trace is incomplete and cannot enter analysis/comparison.' }
if (-not $captureCollectorExited) { $captureWarnings += 'Collector exit could not be confirmed. Original stdout/stderr temporary files are retained; no unrelated process was terminated.' }
if (-not $captureFocusValid) { $captureWarnings += 'Foreground sampling failed or the game lost focus during the planned recording interval. Recapture this run.' }
if (-not $ShaderCacheWarm) { $captureWarnings += 'Shader/asset cache warmup was not declared. Treat as exploratory only.' }
if (-not $FrameGenerationDisabled) { $captureWarnings += 'Frame generation was not declared disabled. Treat as exploratory only.' }
foreach ($captureSnapshot in @($capturePre, $capturePost)) {
    if ($null -ne $captureSnapshot.system.availablePhysicalBytes -and $captureSnapshot.system.availablePhysicalBytes -lt 2GB) { $captureWarnings += 'Available RAM below 2 GiB at a snapshot; memory pressure may confound comparison.' }
    if ($null -ne $captureSnapshot.system.percentCommitUsed -and $captureSnapshot.system.percentCommitUsed -ge 90) { $captureWarnings += 'Commit usage at least 90% at a snapshot; memory pressure may confound comparison.' }
    if ($null -ne $captureSnapshot.system.cpuLoadPercent -and $captureSnapshot.system.cpuLoadPercent -ge 90) { $captureWarnings += 'Aggregate CPU load at least 90% at a snapshot; background pressure may confound comparison.' }
    $captureWarnings += $captureSnapshot.warnings
}
$captureLifetimeStable = $null -ne $capturePre.game -and $null -ne $capturePost.game
$captureCpuPercent = $null
$captureResourceSeconds = ([DateTime]::Parse($capturePost.capturedUtc) - [DateTime]::Parse($capturePre.capturedUtc)).TotalSeconds
if ($captureLifetimeStable -and $captureResourceSeconds -gt 0) { $captureCpuPercent = 100 * ($capturePost.game.cpuSeconds - $capturePre.game.cpuSeconds) / $captureResourceSeconds / $captureLogicalProcessors }
$captureReport = [ordered]@{
    schemaVersion = 1; evidenceType = 'local-etw-capture'; createdUtc = [DateTime]::UtcNow.ToString('o')
    runId = $RunId; profile = [ordered]@{ id = $Profile }; scenario = $captureScenario
    machine = Get-CaptureProperty $captureMatching 'machine'; environment = $captureEnvironment; comparisonContext = $captureContext
    collector = [ordered]@{
        name = 'PresentMon standalone ETW CLI'; version = $captureToolVersion; sha256 = $captureToolSha
        sourceUri = $captureToolUri; executablePath = $captureExecutable; arguments = $captureArguments
        timestampUnit = $captureTimestampUnit; timestampUnitEvidence = 'PresentMon v2.6.0 CommandLine.cpp default MilliSeconds + CsvOutput.cpp CPUStartTime writer; foreground runtime schema corroborated.'
        targetProcessId = $captureGameId; targetApplication = $ProcessName; sessionName = $captureSessionName
        expectedRecordedSeconds = $Seconds; delaySeconds = $DelaySeconds; wallSeconds = $captureWatch.Elapsed.TotalSeconds
        completed = $captureCompleted; exitCode = $captureExitCode; failure = $captureFailure
        watchdogGraceSeconds = $captureWatchdogGraceSeconds; wallDeadlineSeconds = $captureCollectorDeadlineSeconds; watchdogExpired = $captureWatchdogExpired
        ownedProcessId = $captureCollectorId; ownedProcessExited = $captureCollectorExited; ownedProcessTerminationAttempted = $captureTerminationAttempted
        etwEventsLost = $captureEtw.etwEventsLost; etwBuffersLost = $captureEtw.etwBuffersLost; overflowedPresents = $captureEtw.overflowedPresents
    }
    analysisWindow = [ordered]@{ warmupSeconds = $WarmupSeconds; durationSeconds = $Seconds - $WarmupSeconds }
    validity = [ordered]@{
        sceneDeclaredComparable = [bool]$SceneConfirmed; foregroundDeclared = [bool]$ForegroundConfirmed
        foregroundSamples = $captureForegroundSamples; otherForegroundSamples = $captureOtherForegroundSamples; foregroundProbeFailed = $captureProbeFailed
        foregroundSamplingPeriodMs = 500; targetLifetimeStable = $captureLifetimeStable
        limitation = 'Focus is sampled every 500 ms; brief focus changes and scene/camera equivalence are not automatically proven.'
    }
    resources = [ordered]@{ pre = $capturePre; post = $capturePost; intervalSeconds = $captureResourceSeconds; gameCpuNormalizedPercent = $captureCpuPercent; limitation = 'Pre/post snapshots do not establish sustained thermals, GPU utilization, paging activity or zero background overhead.' }
    files = [ordered]@{ csvPath = $captureCsvPath; csvBytes = $captureCsvBytes; csvSha256 = $(if ($captureCsvExists -and $captureCollectorExited) { Get-CaptureSha $captureCsvPath } else { $null }); toolLogPath = $captureLogPath; matchingMetadataSha256 = Get-CaptureSha $captureMetadataPath }
    warnings = @($captureWarnings | Select-Object -Unique)
}
Write-CaptureUtf8 $captureJsonPath (($captureReport | ConvertTo-Json -Depth 16) + "`n")
$captureAnalyzer = Join-Path $PSScriptRoot 'analyze-presentmon.mjs'
$captureAnalysisPath = Join-Path $captureOutput 'analysis.json'
$captureAnalysisDurationSeconds = $Seconds - $WarmupSeconds
$captureAnalysisMinimumSeconds = Get-CaptureAnalysisMinimumSeconds $captureAnalysisDurationSeconds
$captureAnalyzeCommand = 'node ' + (Quote-CapturePowerShell $captureAnalyzer) + ' analyze ' + (Quote-CapturePowerShell $captureCsvPath) + ' --metadata ' + (Quote-CapturePowerShell $captureJsonPath) + ' --profile ' + (Quote-CapturePowerShell $Profile) + ' --run-id ' + (Quote-CapturePowerShell $RunId) + ' --warmup ' + $WarmupSeconds + ' --duration ' + $captureAnalysisDurationSeconds + ' --min-seconds ' + $captureAnalysisMinimumSeconds + ' --out ' + (Quote-CapturePowerShell $captureAnalysisPath)
Write-Host "Saved capture metadata and tool log: $captureOutput"
Write-Host 'Analyze the finished CSV with the offline Node tool:'
Write-Host $captureAnalyzeCommand
if (-not $captureCompleted) { throw 'PresentMon capture was incomplete. Retained metadata/logs explain the failure.' }
if (-not $captureFocusValid -or -not $captureLifetimeStable) { Write-Warning 'Capture is not comparable because focus/target lifetime validation failed.' }
foreach ($captureWarning in $captureReport.warnings) { Write-Warning $captureWarning }
