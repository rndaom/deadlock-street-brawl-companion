# Read-only inventory collection. Writes only the audit report beside this script.
[CmdletBinding()]
param([string]$OutputPath = (Join-Path $PSScriptRoot 'hardware-audit.json'))

$ErrorActionPreference = 'Stop'

function Read-RegistryValue {
    param([string]$Path, [string]$Name)
    try {
        $key = Get-Item -LiteralPath $Path
        if ($key.GetValueNames() -contains $Name) {
            return [pscustomobject]@{Path=$Path; Name=$Name; Present=$true; Value=$key.GetValue($Name)}
        }
    } catch {}
    return [pscustomobject]@{Path=$Path; Name=$Name; Present=$false; Value=$null}
}

$displaySource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
public static class DeadlockHardwareDisplayAudit {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct DD {
  public int cb;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)]public string name;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)]public string description;
  public int flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)]public string id;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)]public string key;
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct DM {
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)]public string device;
  public ushort spec,version,size,extra;
  public uint fields;public int x,y;
  public uint orientation,fixedOutput;
  public short color,duplex,resolution,option,collate;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)]public string form;
  public ushort logPixels;
  public uint bpp,width,height,flags,frequency,icmMethod,icmIntent,mediaType,ditherType,reserved1,reserved2,panningWidth,panningHeight;
 }
 public class Entry {
  public string Device,Adapter,Monitor,HardwareModelId;
  public bool Attached,Primary,ModeRead;
  public uint Width,Height,RefreshHz,Orientation;
  public int X,Y;
 }
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool EnumDisplayDevices(string device,uint index,ref DD info,uint flags);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool EnumDisplaySettings(string device,int number,ref DM info);
 public static Entry[] Read(){
  var entries=new List<Entry>();
  for(uint i=0;i<64;i++){
   DD d=new DD();d.cb=Marshal.SizeOf(typeof(DD));
   if(!EnumDisplayDevices(null,i,ref d,0))break;
   DM m=new DM();m.size=(ushort)Marshal.SizeOf(typeof(DM));
   bool modeRead=EnumDisplaySettings(d.name,-1,ref m);
   DD c=new DD();c.cb=Marshal.SizeOf(typeof(DD));
   EnumDisplayDevices(d.name,0,ref c,0);
   var match=Regex.Match(c.id??"",@"(?:DISPLAY|MONITOR)\\([^\\]+)",RegexOptions.IgnoreCase);
   entries.Add(new Entry{
    Device=d.name,Adapter=d.description,Attached=(d.flags&1)!=0,
    Primary=(d.flags&4)!=0,Monitor=c.description,
    HardwareModelId=match.Success?match.Groups[1].Value:null,
    ModeRead=modeRead,Width=m.width,Height=m.height,RefreshHz=m.frequency,
    X=m.x,Y=m.y,Orientation=m.orientation
   });
  }
  return entries.ToArray();
 }
}
'@
if (-not ('DeadlockHardwareDisplayAudit' -as [type])) { Add-Type -TypeDefinition $displaySource }

$os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture, TotalVisibleMemorySize, FreePhysicalMemory, LastBootUpTime
$cpu = Get-CimInstance Win32_Processor | Select-Object @{Name='Name';Expression={$_.Name.Trim()}}, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, LoadPercentage
$ram = @(Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity, ConfiguredClockSpeed, Speed, Manufacturer, PartNumber, DeviceLocator)
$gpuWmi = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, DriverDate, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate)
$displayClass = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
$gpuRegistry = @(foreach ($entry in Get-ChildItem -LiteralPath $displayClass -ErrorAction SilentlyContinue) {
    if ($entry.PSChildName -notmatch '^\d{4}$') { continue }
    $key = Get-Item -LiteralPath $entry.PSPath
    [pscustomobject]@{
        Description=$key.GetValue('DriverDesc'); Provider=$key.GetValue('ProviderName')
        DriverVersion=$key.GetValue('DriverVersion'); DriverDate=$key.GetValue('DriverDate')
        DedicatedMemoryBytes=$key.GetValue('HardwareInformation.qwMemorySize')
    }
})
$monitors = @(foreach ($monitor in Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID) {
    $modelMatch = [regex]::Match($monitor.InstanceName, '^DISPLAY\\([^\\]+)')
    [pscustomobject]@{
        Active=$monitor.Active
        Manufacturer=(-join ($monitor.ManufacturerName | Where-Object {$_ -gt 0} | ForEach-Object {[char]$_}))
        FriendlyName=(-join ($monitor.UserFriendlyName | Where-Object {$_ -gt 0} | ForEach-Object {[char]$_}))
        HardwareModelId=if ($modelMatch.Success) {$modelMatch.Groups[1].Value} else {$null}
    }
})
$allDisplays = @([DeadlockHardwareDisplayAudit]::Read())
$activeDisplays = @(foreach ($display in $allDisplays | Where-Object Attached) {
    $matched = @($monitors | Where-Object {$_.HardwareModelId -eq $display.HardwareModelId})
    [pscustomobject]@{
        Device=$display.Device; Adapter=$display.Adapter; Primary=$display.Primary
        Width=$display.Width; Height=$display.Height; RefreshHz=$display.RefreshHz
        PositionX=$display.X; PositionY=$display.Y; Orientation=$display.Orientation
        FriendlyName=if ($matched.Count) {$matched[0].FriendlyName} else {$display.Monitor}
        HardwareModelId=$display.HardwareModelId; Source='EnumDisplayDevices / EnumDisplaySettings + WmiMonitorID model mapping'
    }
})
$registryStates = @(
    Read-RegistryValue 'HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers' 'HwSchMode'
    Read-RegistryValue 'HKCU:\Software\Microsoft\GameBar' 'AutoGameModeEnabled'
    Read-RegistryValue 'HKCU:\Software\Microsoft\GameBar' 'AllowAutoGameMode'
    Read-RegistryValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR' 'AppCaptureEnabled'
    Read-RegistryValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR' 'HistoricalCaptureEnabled'
    Read-RegistryValue 'HKCU:\System\GameConfigStore' 'GameDVR_Enabled'
    Read-RegistryValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\GameDVR' 'AllowGameDVR'
    Read-RegistryValue 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' 'DisplayVersion'
    Read-RegistryValue 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' 'UBR'
    Read-RegistryValue 'HKLM:\SOFTWARE\AMD\CN' 'CNVersion'
    Read-RegistryValue 'HKLM:\SOFTWARE\AMD\CN' 'DriverVersion'
)
$powerPlan = (& powercfg /getactivescheme | Out-String).Trim()
$gameScheduling = @(Get-Process deadlock -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{Name=$_.ProcessName; Id=$_.Id; PriorityClass=$_.PriorityClass.ToString(); AffinityMask=$_.ProcessorAffinity.ToInt64()}
})
$cpuCount = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$before = @{}
Get-Process | ForEach-Object {$before[$_.Id]=$_.CPU}
$sampleStarted = [DateTime]::UtcNow
Start-Sleep -Seconds 3
$elapsed = ([DateTime]::UtcNow - $sampleStarted).TotalSeconds
$processes = @(Get-Process | ForEach-Object {
    $delta=0
    if ($before.ContainsKey($_.Id) -and $null -ne $_.CPU -and $null -ne $before[$_.Id]) {$delta=[Math]::Max(0,$_.CPU-$before[$_.Id])}
    [pscustomobject]@{Name=$_.ProcessName; WorkingSetBytes=$_.WorkingSet64; PrivateBytes=$_.PrivateMemorySize64; CPUPercent=100*$delta/$elapsed/$cpuCount}
})
$aggregate = @($processes | Group-Object Name | ForEach-Object {
    [pscustomobject]@{
        Name=$_.Name; ProcessCount=$_.Count
        WorkingSetMiB=[Math]::Round(($_.Group | Measure-Object WorkingSetBytes -Sum).Sum / 1MB,1)
        PrivateMiB=[Math]::Round(($_.Group | Measure-Object PrivateBytes -Sum).Sum / 1MB,1)
        CPUPercent=[Math]::Round(($_.Group | Measure-Object CPUPercent -Sum).Sum,1)
    }
})
$memoryCounters = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object AvailableMBytes, CommittedBytes, CommitLimit, PercentCommittedBytesInUse, PagesInputPersec, PageReadsPersec
$pagefiles = @(Get-CimInstance Win32_PageFileUsage | Select-Object Name, AllocatedBaseSize, CurrentUsage, PeakUsage)

$libraryFile = 'C:\Program Files (x86)\Steam\steamapps\libraryfolders.vdf'
$gameStorage = @()
if (Test-Path -LiteralPath $libraryFile) {
    $libraryText=Get-Content -LiteralPath $libraryFile -Raw
    $libraryPaths=[regex]::Matches($libraryText,'"path"\s+"([^"]+)"') | ForEach-Object {$_.Groups[1].Value.Replace('\\','\')}
    $gameStorage = @(foreach ($libraryPath in $libraryPaths) {
        $manifestPath=Join-Path $libraryPath 'steamapps\appmanifest_1422450.acf'
        if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
        $manifest=Get-Content -LiteralPath $manifestPath -Raw
        $directory=[regex]::Match($manifest,'"installdir"\s+"([^"]+)"').Groups[1].Value
        $driveRoot=[IO.Path]::GetPathRoot($libraryPath).TrimEnd('\')
        $volume=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$driveRoot'"
        $physical=Get-Partition -DriveLetter $driveRoot.Substring(0,1) | Get-Disk | Select-Object Number,FriendlyName,BusType,Size,PartitionStyle,HealthStatus,OperationalStatus
        [pscustomobject]@{
            InstallDirectory=Join-Path $libraryPath ('steamapps\common\'+$directory)
            Volume=$volume.DeviceID; FileSystem=$volume.FileSystem
            CapacityGiB=[Math]::Round($volume.Size/1GB,1); FreeGiB=[Math]::Round($volume.FreeSpace/1GB,1)
            PhysicalDisk=$physical
        }
    })
}

$report = [ordered]@{
    SchemaVersion=1
    CapturedUtc=[DateTime]::UtcNow.ToString('o')
    Method='Read-only CIM, registry reads, Win32 display APIs, powercfg query, process resource sample; no machine/game/driver settings changed'
    CPU=$cpu
    MemoryModules=$ram
    PhysicalMemoryBytes=($ram | Measure-Object Capacity -Sum).Sum
    OS=$os
    GPUs=$gpuRegistry
    WmiGpuDisplayFields=$gpuWmi
    ActiveDisplays=$activeDisplays
    DetachedVirtualDisplayOutputs=@($allDisplays | Where-Object {$_.Adapter -match 'Virtual' -and -not $_.Attached} | Select-Object Device, Adapter)
    Monitors=$monitors
    PowerPlan=$powerPlan
    RegistryStates=$registryStates
    GameStorage=$gameStorage
    RunningGame=$gameScheduling
    ResourceSample=[ordered]@{
        SampleStartedUtc=$sampleStarted.ToString('o'); SampleSeconds=[Math]::Round($elapsed,3)
        MemoryCounters=$memoryCounters; Pagefiles=$pagefiles
        TopProcessesByPrivateBytes=@($aggregate | Sort-Object PrivateMiB -Descending | Select-Object -First 20)
        TopProcessesByCPU=@($aggregate | Sort-Object CPUPercent -Descending | Select-Object -First 10)
        GamingCaptureProcessNames=@($aggregate | Where-Object {$_.Name -match 'deadlock|steam|gameoverlay|obs|amd|radeon|replay|parsec|sunshine|moonlight'} | Select-Object Name,ProcessCount)
    }
    Interpretation=[ordered]@{
        HAGS='Registry configured enabled (HwSchMode=2); runtime activation after reboot not independently confirmed'
        GameMode='Configured enabled (AutoGameModeEnabled=1)'
        WindowsCapture='AppCaptureEnabled=0, HistoricalCaptureEnabled=0, GameDVR_Enabled=0'
        GPUVideoMemory='Registry qwMemorySize reports approximately 16 GiB; legacy WMI AdapterRAM is truncated and deliberately excluded'
        ProcessMemory='Private bytes approximate per-process committed private virtual memory. Working sets include shared pages and are not additive physical-memory accounting.'
        CPU='Three-second process CPU deltas divided by all logical CPUs; transient sample affected by game activity and collection overhead'
        BackgroundPressure='Current workload can materially confound FPS and frame-time comparisons. Page-input counters are a snapshot, not a measured causal diagnosis of stutter.'
    }
    Unverified=@('FreeSync/VRR enabled state','AMD Chill/FRTC/Boost/Anti-Lag/Enhanced Sync profile settings','AMD Instant Replay enabled state','GPU clock/voltage/temperature/power limits','CPU memory-controller clock and timings','Rendering bottleneck and measured FPS gains')
}
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Output $OutputPath
