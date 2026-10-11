# Offline tests only: parse the authoring source and evaluate its small pure helpers.
# Does not start PresentMon, download a binary, enumerate the game, or record ETW.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$captureTestPath = Join-Path $PSScriptRoot '..\tools\Capture-PresentMon.ps1'
$captureTestTokens = $null; $captureTestErrors = $null
$captureTestAst = [Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($captureTestPath), [ref]$captureTestTokens, [ref]$captureTestErrors)
if ($captureTestErrors.Count -ne 0) { throw ($captureTestErrors | ForEach-Object { $_.Message } | Out-String) }
$captureTestCommands = @($captureTestAst.FindAll({ param($a) $a -is [Management.Automation.Language.CommandAst] }, $true))
$captureTestForbidden = @('Stop-Process', 'Suspend-Process', 'Set-ItemProperty', 'Remove-ItemProperty', 'Start-Service', 'Restart-Service')
foreach ($captureTestCommand in $captureTestCommands) {
    if ($captureTestCommand.GetCommandName() -in $captureTestForbidden) { throw ('Forbidden mutation: ' + $captureTestCommand.GetCommandName()) }
}
$captureTestStarts = @($captureTestCommands | Where-Object { $_.GetCommandName() -eq 'Start-Process' })
if ($captureTestStarts.Count -ne 1 -or $captureTestStarts[0].Extent.Text -notmatch '-FilePath \$captureExecutable\b' -or $captureTestStarts[0].Extent.Text -notmatch '-WindowStyle Hidden') { throw 'Only the pinned collector may launch, hidden.' }
foreach ($captureTestFunctionName in @('Get-CaptureProperty', 'Quote-CapturePowerShell', 'Remove-CaptureTemporaryFile', 'Get-CaptureAnalysisMinimumSeconds', 'Test-CaptureCollectorDeadline', 'Assert-CaptureCollectorIdentity', 'Get-CaptureEtwLossCounters', 'Get-CaptureTimestampUnit')) {
    $captureTestFunction = $captureTestAst.Find({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $captureTestFunctionName }, $true)
    . ([ScriptBlock]::Create($captureTestFunction.Extent.Text))
}
if ($null -ne (Get-CaptureProperty ([pscustomobject]@{}) 'absent')) { throw 'Missing metadata must remain null.' }
if ((Get-CaptureProperty ([pscustomobject]@{ available = 0 }) 'available') -ne 0) { throw 'Zero is different from unavailable.' }
if ((Quote-CapturePowerShell "C:\a'b\file.csv") -ne "'C:\a''b\file.csv'") { throw 'PowerShell path quoting failed.' }
$captureTestRejected = $false
try { Remove-CaptureTemporaryFile 'C:\out-of-scope-never-delete.tmp' 'C:\intended-directory' } catch { $captureTestRejected = $true }
if (-not $captureTestRejected) { throw 'Cleanup must reject a path outside its expected directory.' }

# A short permitted window must produce a matching minimum, retaining the 30s floor.
if ((Get-CaptureAnalysisMinimumSeconds 30) -ne 30 -or (Get-CaptureAnalysisMinimumSeconds 50) -ne 50 -or (Get-CaptureAnalysisMinimumSeconds 120) -ne 60) { throw 'Printed analysis minimum does not match the permitted window.' }
$captureTestRejected = $false
try { Get-CaptureAnalysisMinimumSeconds 29 | Out-Null } catch { $captureTestRejected = $true }
if (-not $captureTestRejected) { throw 'The 30-second analysis floor must remain enforced.' }
if ((Get-CaptureTimestampUnit $null) -cne 'milliseconds' -or (Get-CaptureTimestampUnit 'milliseconds') -cne 'milliseconds') { throw 'Actual pinned timestamp units must be recorded even without input metadata.' }
$captureTestRejected = $false
try { Get-CaptureTimestampUnit 'seconds' | Out-Null } catch { $captureTestRejected = $true }
if (-not $captureTestRejected) { throw 'Conflicting inherited timestamp units must not override the pinned collector schema.' }
if ((Test-CaptureCollectorDeadline 129.99 130) -or -not (Test-CaptureCollectorDeadline 130 130) -or -not (Test-CaptureCollectorDeadline 135 130)) { throw 'Watchdog deadline boundary is incorrect.' }
$captureTestLoss = Get-CaptureEtwLossCounters ''
if ($null -ne $captureTestLoss.etwEventsLost -or $null -ne $captureTestLoss.etwBuffersLost -or $null -ne $captureTestLoss.overflowedPresents) { throw 'Missing collector counters must remain unknown.' }
$captureTestStatus = '[ETW Status] BufferFillPct=0.0% BuffersInUse=0 TotalBuffers=1 EventsLost=0 BuffersLost=0, OverflowedPresents=0'
$captureTestLoss = Get-CaptureEtwLossCounters $captureTestStatus
if ($captureTestLoss.etwEventsLost -ne 0 -or $captureTestLoss.etwBuffersLost -ne 0 -or $captureTestLoss.overflowedPresents -ne 0) { throw 'Observed zero counters should remain known zero.' }
$captureTestLoss = Get-CaptureEtwLossCounters ($captureTestStatus + "`nwarning: 9 ETW events were lost.`nwarning: 4 ETW buffers were lost.`nwarning: 7 overflowed present events detected. This could be due to a high-fps application.")
if ($captureTestLoss.etwEventsLost -ne 9 -or $captureTestLoss.etwBuffersLost -ne 4 -or $captureTestLoss.overflowedPresents -ne 7) { throw 'Actual source final warnings must override earlier zero status.' }

# Test ownership matching without starting or terminating any process.
Assert-CaptureCollectorIdentity -ActualId 71 -ActualStartTicks 123456 -ActualExecutable 'C:\Pinned\PresentMon.exe' -ExpectedId 71 -ExpectedStartTicks 123456 -ExpectedExecutable 'c:\pinned\presentmon.exe'
foreach ($captureTestIdentity in @(
    @{ ActualId = 72; ActualStartTicks = 123456; ActualExecutable = 'C:\Pinned\PresentMon.exe'; ExpectedId = 71; ExpectedStartTicks = 123456; ExpectedExecutable = 'C:\Pinned\PresentMon.exe' },
    @{ ActualId = 71; ActualStartTicks = 654321; ActualExecutable = 'C:\Pinned\PresentMon.exe'; ExpectedId = 71; ExpectedStartTicks = 123456; ExpectedExecutable = 'C:\Pinned\PresentMon.exe' },
    @{ ActualId = 71; ActualStartTicks = 123456; ActualExecutable = 'C:\Game\deadlock.exe'; ExpectedId = 71; ExpectedStartTicks = 123456; ExpectedExecutable = 'C:\Pinned\PresentMon.exe' },
    @{ ActualId = 71; ActualStartTicks = 123456; ActualExecutable = 'C:\Pinned\PresentMon.exe'; ExpectedId = 0; ExpectedStartTicks = 0; ExpectedExecutable = 'C:\Pinned\PresentMon.exe' }
)) {
    $captureTestRejected = $false
    try { Assert-CaptureCollectorIdentity @captureTestIdentity } catch { $captureTestRejected = $true }
    if (-not $captureTestRejected) { throw 'A changed/unrecorded collector identity must refuse termination.' }
}

# The single termination site must use the guarded returned process object.
$captureTestCalls = @($captureTestAst.FindAll({ param($a) $a -is [Management.Automation.Language.InvokeMemberExpressionAst] }, $true))
$captureTestKills = @($captureTestCalls | Where-Object { $_.Member.Value -eq 'Kill' })
$captureTestStopFunction = $captureTestAst.Find({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Stop-CaptureOwnedCollector' }, $true)
if ($captureTestKills.Count -ne 1 -or $captureTestKills[0].Extent.Text -ne '$Process.Kill()' -or $captureTestStopFunction.Extent.Text.IndexOf('Assert-CaptureCollectorIdentity') -gt $captureTestStopFunction.Extent.Text.IndexOf('$Process.Kill()')) { throw 'Collector termination must follow the ownership guard in its single helper.' }
foreach ($captureTestCall in ($captureTestCalls | Where-Object { $_.Member.Value -eq 'WaitForExit' })) {
    if ($captureTestCall.Arguments.Count -eq 0) { throw 'Collector waits must be bounded.' }
}
$captureTestStopCalls = @($captureTestCommands | Where-Object { $_.GetCommandName() -eq 'Stop-CaptureOwnedCollector' })
if ($captureTestStopCalls.Count -ne 2 -or @($captureTestStopCalls | Where-Object { $_.Extent.Text -notmatch '-Process \$captureCollectorProcess\b' -or $_.Extent.Text -notmatch '-ExpectedExecutable \$captureExecutable\b' }).Count -ne 0) { throw 'Cleanup may only target the wrapper-created collector and pinned executable.' }
$captureTestSource = $captureTestAst.Extent.Text
if ($captureTestSource -notmatch [regex]::Escape("' --min-seconds ' + `$captureAnalysisMinimumSeconds") -or $captureTestSource -notmatch '\$captureWatchdogGraceSeconds = 30' -or $captureTestSource -notmatch 'watchdogExpired = \$captureWatchdogExpired') { throw 'Duration/watchdog metadata wiring is missing.' }
[pscustomobject]@{ passed = $true; parserErrors = 0; checks = 21; captureExecuted = $false; binaryDownloaded = $false; processTerminated = $false } | ConvertTo-Json
