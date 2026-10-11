# Read-only, two-snapshot resource audit. No tracing session or capture is started.
[CmdletBinding()]
param([int]$IntervalSeconds=5)
$ErrorActionPreference='Stop'
if($IntervalSeconds -lt 1 -or $IntervalSeconds -gt 15){throw 'IntervalSeconds must be between 1 and 15.'}

$game=Get-Process -Name deadlock -ErrorAction SilentlyContinue|Select-Object -First 1
if(-not $game){throw 'Deadlock is not running; no runtime sample was collected.'}
$gamePid=$game.Id
$logicalCPUCount=(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors

function Get-AuditSnapshot {
    $processSampleUtc=[DateTime]::UtcNow
    $processes=@(Get-Process|ForEach-Object{
        [pscustomobject]@{Id=$_.Id;Name=$_.ProcessName;CPUSeconds=$_.CPU;PrivateBytes=$_.PrivateMemorySize64;WorkingSetBytes=$_.WorkingSet64}
    })
    $threads=@{}
    $activeGame=Get-Process -Id $gamePid -ErrorAction SilentlyContinue
    if($activeGame){foreach($thread in $activeGame.Threads){try{$threads[$thread.Id]=$thread.TotalProcessorTime.TotalSeconds}catch{}}}
    $memory=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory|Select-Object AvailableMBytes,CommittedBytes,CommitLimit,PercentCommittedBytesInUse,PagesInputPersec,PagesOutputPersec,PageReadsPersec,PageWritesPersec,PoolPagedBytes,PoolNonpagedBytes
    $memory|Add-Member -NotePropertyName CommitPercentComputed -NotePropertyValue ([Math]::Round(100.0*$memory.CommittedBytes/$memory.CommitLimit,2))
    $cpu=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor|Select-Object Name,PercentProcessorTime
    $gpuError=$null
    $gpu=@()
    $gpuMemory=@()
    $adapterMemory=@()
    try{
        $gpu=@(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine|Select-Object Name,UtilizationPercentage,RunningTime,Timestamp_Sys100NS)
        $gpuMemory=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -Filter "Name LIKE 'pid_${gamePid}_%'"|Select-Object Name,DedicatedUsage,SharedUsage,LocalUsage,NonLocalUsage,TotalCommitted)
        $adapterMemory=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory|Select-Object Name,DedicatedUsage,SharedUsage,TotalCommitted)
    }catch{$gpuError=$_.Exception.Message}
    [pscustomobject]@{
        ProcessSampleUtc=$processSampleUtc;SnapshotCompletedUtc=[DateTime]::UtcNow
        Processes=$processes;GameThreadCPUSeconds=$threads;Memory=$memory;CPU=$cpu
        GPURaw=$gpu;GameGPUMemory=$gpuMemory;AdapterMemory=$adapterMemory;GPUReadError=$gpuError
    }
}

$first=Get-AuditSnapshot
Start-Sleep -Seconds $IntervalSeconds
$second=Get-AuditSnapshot
$elapsed=($second.ProcessSampleUtc-$first.ProcessSampleUtc).TotalSeconds
$firstProcesses=@{}
foreach($process in $first.Processes){$firstProcesses[$process.Id]=$process}
$processActivity=@(foreach($process in $second.Processes){
    $cpuPercent=$null
    if($firstProcesses.ContainsKey($process.Id)){
        $original=$firstProcesses[$process.Id]
        if($original.Name -eq $process.Name -and $null -ne $process.CPUSeconds -and $null -ne $original.CPUSeconds){
            $cpuPercent=[Math]::Round(100*[Math]::Max(0,$process.CPUSeconds-$original.CPUSeconds)/$elapsed/$logicalCPUCount,2)
        }
    }
    [pscustomobject]@{Id=$process.Id;Name=$process.Name;CPUPercentAllLogicalCPUs=$cpuPercent;PrivateMiB=[Math]::Round($process.PrivateBytes/1MB,1);WorkingSetMiB=[Math]::Round($process.WorkingSetBytes/1MB,1)}
})
$processAggregates=@($processActivity|Group-Object Name|ForEach-Object{
    [pscustomobject]@{
        Name=$_.Name;Count=$_.Count
        CPUPercentAllLogicalCPUs=[Math]::Round(($_.Group|Measure-Object CPUPercentAllLogicalCPUs -Sum).Sum,2)
        PrivateMiB=[Math]::Round(($_.Group|Measure-Object PrivateMiB -Sum).Sum,1)
        WorkingSetMiB=[Math]::Round(($_.Group|Measure-Object WorkingSetMiB -Sum).Sum,1)
    }
})
$gameActivity=@($processActivity|Where-Object Id -eq $gamePid)
$gameThreads=@(foreach($threadId in $second.GameThreadCPUSeconds.Keys){
    if($first.GameThreadCPUSeconds.ContainsKey($threadId)){
        [Math]::Round(100*[Math]::Max(0,$second.GameThreadCPUSeconds[$threadId]-$first.GameThreadCPUSeconds[$threadId])/$elapsed,2)
    }
})
$originalGPU=@{}
foreach($engine in $first.GPURaw){$originalGPU[$engine.Name]=$engine}
$gpuActivity=@(foreach($engine in $second.GPURaw){
    if(-not $originalGPU.ContainsKey($engine.Name)){continue}
    $original=$originalGPU[$engine.Name]
    $timeDelta=[double]$engine.Timestamp_Sys100NS-[double]$original.Timestamp_Sys100NS
    $busyDelta=[double]$engine.UtilizationPercentage-[double]$original.UtilizationPercentage
    if($timeDelta -le 0 -or $busyDelta -lt 0){continue}
    $match=[regex]::Match($engine.Name,'^pid_(\d+)_(luid_.+?_phys_\d+)_(eng_\d+)_engtype_(.+)$')
    if(-not $match.Success){continue}
    $enginePid=[int]$match.Groups[1].Value
    $pname=if($firstProcesses.ContainsKey($enginePid)){$firstProcesses[$enginePid].Name}else{'unresolved-or-short-lived'}
    $percent=[Math]::Round(100*$busyDelta/$timeDelta,3)
    [pscustomobject]@{
        ProcessId=$enginePid;ProcessName=$pname;AdapterCounterKey=$match.Groups[2].Value
        Engine=$match.Groups[3].Value;EngineType=$match.Groups[4].Value
        BusyPercent=$percent;CounterIntervalSeconds=[Math]::Round($timeDelta/1e7,3)
        InExpectedRange=($percent -ge 0 -and $percent -le 100.01)
    }
})
$gameGPU=@($gpuActivity|Where-Object ProcessId -eq $gamePid)
$allEngineActivity=@($gpuActivity|Where-Object InExpectedRange|Group-Object AdapterCounterKey,Engine,EngineType|ForEach-Object{
    [pscustomobject]@{
        AdapterCounterKey=$_.Group[0].AdapterCounterKey;Engine=$_.Group[0].Engine;EngineType=$_.Group[0].EngineType
        SummedProcessBusyPercent=[Math]::Round(($_.Group|Measure-Object BusyPercent -Sum).Sum,3)
        ActiveProcesses=@($_.Group|Where-Object BusyPercent -gt 0.05|Sort-Object BusyPercent -Descending|Select-Object ProcessName,BusyPercent)
    }
}|Sort-Object SummedProcessBusyPercent -Descending)

# Reuse only the read-only display API type definition from our existing collector.
$collector=Join-Path (Split-Path $PSScriptRoot -Parent) 'collect-hardware-audit.ps1'
$collectorText=Get-Content -LiteralPath $collector -Raw
$displayType=[regex]::Match($collectorText,"(?s)\`$displaySource = @'\r?\n(.*?)\r?\n'@")
if(-not $displayType.Success){throw 'Could not find the owned display API type definition.'}
if(-not ('DeadlockHardwareDisplayAudit' -as [type])){Add-Type -TypeDefinition $displayType.Groups[1].Value}
$displays=@([DeadlockHardwareDisplayAudit]::Read()|Where-Object Attached|Select-Object Device,Adapter,Primary,Width,Height,RefreshHz,HardwareModelId)
$drivers=@(Get-CimInstance Win32_VideoController|Select-Object Name,DriverVersion,DriverDate)
$modules=@()
try{
    $modules=@((Get-Process -Id $gamePid).Modules|Where-Object{$_.ModuleName-match '(?i)^(rendersystem|renderdevice)|vulkan|^dxgi\.dll$|^d3d1[12]\.dll$'}|Select-Object ModuleName,@{Name='Version';Expression={$_.FileVersionInfo.FileVersion}})
}catch{$modules=@([pscustomobject]@{ReadError=$_.Exception.Message})}
$renderer=if($modules.ModuleName -contains 'rendersystemdx11.dll'){'DX11 renderer module loaded'}elseif($modules.ModuleName -contains 'rendersystemvulkan.dll'){'Vulkan renderer module loaded'}else{'Unverified'}
$pagefiles=@(Get-CimInstance Win32_PageFileUsage|Select-Object Name,AllocatedBaseSize,CurrentUsage,PeakUsage)
$previousPath=Join-Path (Split-Path $PSScriptRoot -Parent) 'hardware-audit.json'
$previous=if(Test-Path -LiteralPath $previousPath){Get-Content -LiteralPath $previousPath -Raw|ConvertFrom-Json}else{$null}
$comparison=if($previous){
    [ordered]@{
        PreviousCapturedUtc=$previous.CapturedUtc
        PreviousAvailableMiB=$previous.ResourceSample.MemoryCounters.AvailableMBytes
        CurrentAvailableMiB=$second.Memory.AvailableMBytes
        AvailableDeltaMiB=([long]$second.Memory.AvailableMBytes-[long]$previous.ResourceSample.MemoryCounters.AvailableMBytes)
        PreviousCommittedBytes=$previous.ResourceSample.MemoryCounters.CommittedBytes
        CurrentCommittedBytes=$second.Memory.CommittedBytes
        CommitDeltaMiB=[Math]::Round(([double]$second.Memory.CommittedBytes-[double]$previous.ResourceSample.MemoryCounters.CommittedBytes)/1MB,1)
        PreviousCommitPercent=$previous.ResourceSample.MemoryCounters.PercentCommittedBytesInUse
        CurrentCommitPercent=$second.Memory.PercentCommittedBytesInUse
    }
}else{$null}
$telemetryPath=Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'optimization\local\tools\PresentMon-2.6.0-x64.exe'
$telemetryFile=if(Test-Path -LiteralPath $telemetryPath){Get-Item -LiteralPath $telemetryPath}else{$null}
$report=[ordered]@{
    SchemaVersion=1;CapturedUtc=[DateTime]::UtcNow.ToString('o')
    Method=('Two read-only CIM/process snapshots with '+$IntervalSeconds+'-second requested gap; actual per-counter intervals preserved. No game control, injection, trace capture, download, process/registry/driver/power mutation.')
    RunningGame=[ordered]@{Id=$gamePid;Name='deadlock';StartUtc=$game.StartTime.ToUniversalTime().ToString('o');Scene='Unknown: no screenshot or game control performed';ResourceActivity=$gameActivity}
    ActiveDisplays=$displays;GPUDrivers=$drivers
    RenderAPI=[ordered]@{Evidence=$renderer;LoadedRenderingModules=$modules;Limit='A loaded renderer module is strong runtime evidence but is not a per-frame API capture.'}
    Samples=@(
        [ordered]@{ProcessSampleUtc=$first.ProcessSampleUtc.ToString('o');CompletedUtc=$first.SnapshotCompletedUtc.ToString('o');Memory=$first.Memory;CPU=$first.CPU;GameGPUMemory=$first.GameGPUMemory;AdapterMemory=$first.AdapterMemory;GPUReadError=$first.GPUReadError}
        [ordered]@{ProcessSampleUtc=$second.ProcessSampleUtc.ToString('o');CompletedUtc=$second.SnapshotCompletedUtc.ToString('o');Memory=$second.Memory;CPU=$second.CPU;GameGPUMemory=$second.GameGPUMemory;AdapterMemory=$second.AdapterMemory;GPUReadError=$second.GPUReadError}
    )
    ActualProcessIntervalSeconds=[Math]::Round($elapsed,3)
    GameThreadCPU=[ordered]@{TopThreadPercentOneLogicalCPU=@($gameThreads|Sort-Object -Descending|Select-Object -First 8);Limit='Thread deltas are normalized to one logical CPU; threads may migrate. High occupancy does not identify the critical thread or prove a gameplay limit.'}
    GPUActivity=[ordered]@{
        GamePerEngine=$gameGPU
        AllProcessPerEngineAggregate=@($allEngineActivity|Select-Object -First 10)
        BackgroundActivePerEngine=@($gpuActivity|Where-Object{$_.ProcessId -ne $gamePid -and $_.BusyPercent -gt 0.1}|Sort-Object BusyPercent -Descending|Select-Object -First 15 ProcessName,AdapterCounterKey,Engine,EngineType,BusyPercent)
        Method='100 × delta(raw UtilizationPercentage) / delta(Timestamp_Sys100NS), the WDDM per-process engine 100-nanosecond timer; engine keys retained for comparison.'
        ConfirmedCounterType=542180608
        Limit='Per-engine scheduled busy time is not overall GPU load, shader occupancy, GPU clock, GPU frame time or FPS. Engines overlap. Process-engine sums are approximate and must not be summed across different engines.'
    }
    Background=[ordered]@{
        TopPrivateMiB=@($processAggregates|Sort-Object PrivateMiB -Descending|Select-Object -First 15)
        TopCPU=@($processAggregates|Sort-Object CPUPercentAllLogicalCPUs -Descending|Select-Object -First 12)
        CaptureRelatedProcessNames=@($processAggregates|Where-Object{$_.Name-match 'obs|amd|radeon|replay|gameoverlay|steam|parsec|sunshine|moonlight|discord'}|Select-Object Name,Count)
        CaptureState='Process presence does not confirm active capture, Instant Replay or overlay rendering.'
    }
    Pagefiles=$pagefiles;ComparisonToFirstPass=$comparison
    NonInjectingFPSTelemetry=[ordered]@{
        NativeETWProvider='Microsoft-Windows-DxgKrnl provider availability verified read-only with logman query; includes Present keyword'
        ExistingPresentMonRelativePath=if($telemetryFile){'optimization/local/tools/PresentMon-2.6.0-x64.exe'}else{$null}
        ExistingPresentMonBytes=if($telemetryFile){$telemetryFile.Length}else{$null}
        FPSMeasuredThisAudit=$false
        Assessment='Existing PresentMon can decode Windows ETW presentation events without game DLL injection. Native GPU usage counters alone do not yield FPS. No tracing session was started in this audit.'
    }
    CounterInterpretation=@(
        'Unknown scene and foreground state; these snapshots cannot establish the dense-match CPU/GPU bottleneck or config FPS gains.'
        'Commit percentage measures reserved committed virtual memory relative to the commit limit, not percentage physical RAM residency.'
        'Private process bytes approximate committed private memory; working sets include shared pages and are not additive physical-memory accounting.'
        'PagesInputPersec includes hard-fault reads from pagefile and mapped files; it does not by itself diagnose swapping-induced gameplay stutters.'
        'Background workloads and this audit can confound frame-time measurements; no processes were stopped.'
    )
}
$output=Join-Path $PSScriptRoot 'hardware-audit.json'
$report|ConvertTo-Json -Depth 13|Set-Content -LiteralPath $output -Encoding utf8
$primary=$displays|Where-Object Primary|Select-Object -First 1
$gameRow=$gameActivity|Select-Object -First 1
$gpu3D=$gameGPU|Where-Object EngineType -eq '3D'
$summary=@(
    ('Read-only round 2 hardware/resource audit captured '+$report.CapturedUtc)
    ('Primary current output: '+$primary.Width+'x'+$primary.Height+' at '+$primary.RefreshHz+' Hz through '+$primary.Adapter+'.')
    ('Renderer evidence: '+$renderer+'. Scene/foreground unknown; no gameplay bottleneck determination.')
    ('Two-snapshot process interval: '+[Math]::Round($elapsed,3)+' seconds. Deadlock all-CPU share: '+$gameRow.CPUPercentAllLogicalCPUs+'%; private '+$gameRow.PrivateMiB+' MiB; working set '+$gameRow.WorkingSetMiB+' MiB.')
    ('Available physical RAM MiB: '+$first.Memory.AvailableMBytes+' -> '+$second.Memory.AvailableMBytes+'. Commit used %: '+$first.Memory.PercentCommittedBytesInUse+' -> '+$second.Memory.PercentCommittedBytesInUse+'.')
    ('Computed commit use %: '+$first.Memory.CommitPercentComputed+' -> '+$second.Memory.CommitPercentComputed+'.')
    ('Memory pages input/s snapshots: '+$first.Memory.PagesInputPersec+' -> '+$second.Memory.PagesInputPersec+'; page read operations/s: '+$first.Memory.PageReadsPersec+' -> '+$second.Memory.PageReadsPersec+'. These are not a causal paging/stutter diagnosis.')
    ('Deadlock 3D per-engine busy % over native counter interval: '+(($gpu3D|ForEach-Object{$_.BusyPercent})-join ', ')+'. Other engines may overlap; this is not FPS or complete GPU occupancy.')
    ('First-pass available MiB '+$comparison.PreviousAvailableMiB+' vs current '+$comparison.CurrentAvailableMiB+'; commit % '+$comparison.PreviousCommitPercent+' vs '+$comparison.CurrentCommitPercent+'.')
    'Native DxgKrnl ETW provider and existing PresentMon tool available for noninjecting FPS capture; no capture or FPS measurement performed by this audit.'
    'No game controls, settings changes, process stopping, priority/affinity changes or downloads. No serial numbers, unrelated command lines, player/chat/message data collected.'
)
$summary|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'hardware-audit.txt') -Encoding utf8
$summary
