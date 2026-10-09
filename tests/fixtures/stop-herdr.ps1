param(
  [Parameter(Mandatory)][int]$ServerPid,
  [Parameter(Mandatory)][string]$HerdrBinary
)

# Preserve Herdr session state and then terminate test-owned survivors.
$ErrorActionPreference = 'Stop'
$root = Get-Process -Id $ServerPid
$null = $root.Handle
$tree = [System.Collections.Generic.HashSet[int]]::new()
$null = $tree.Add([int]$ServerPid)
$snapshot = @(Get-CimInstance Win32_Process)
do {
  $added = $false
  foreach ($entry in $snapshot) {
    if ($tree.Contains([int]$entry.ParentProcessId) -and $tree.Add([int]$entry.ProcessId)) { $added = $true }
  }
} while ($added)
$children = @(
  foreach ($childId in $tree) {
    if ($childId -eq [int]$ServerPid) { continue }
    try {
      $child = Get-Process -Id $childId -ErrorAction Stop
      $null = $child.Handle
      $created = ($snapshot | Where-Object ProcessId -eq $childId).CreationDate
      # CIM timestamps have microsecond precision. Reject a PID reused since enumeration.
      $format = 'yyyy-MM-ddTHH:mm:ss.ffffff'
      if ($child.StartTime.ToUniversalTime().ToString($format) -ne $created.ToUniversalTime().ToString($format)) {
        $child.Dispose()
        continue
      }
      $child
    } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {}
  }
)
$failures = [System.Collections.Generic.List[System.Exception]]::new()
try {
  & $HerdrBinary server stop
  if ($LASTEXITCODE -ne 0) { throw "Herdr stop exited with $LASTEXITCODE" }
  if (-not $root.WaitForExit(8000)) { throw 'Herdr did not finish saving its session' }
} catch { $failures.Add($_.Exception) }
finally { $root.Dispose() }

foreach ($child in $children) {
  try {
    # Each recorded handle identifies one owned process. Do not re-enumerate
    # overlapping trees while their processes are concurrently terminating.
    try {
      if (-not $child.HasExited) { $child.Kill() }
    } catch {
      # Windows can report access denied when termination races with exit.
      # Accept that outcome only after this same process handle signals exit.
      if (-not $child.WaitForExit(5000)) { throw }
    }
    if (-not $child.WaitForExit(5000)) { throw "Test child $($child.Id) did not exit" }
  } catch { $failures.Add($_.Exception) }
  finally { $child.Dispose() }
}
if ($failures.Count) { throw [System.AggregateException]::new('Test-owned Herdr processes did not stop', $failures) }
