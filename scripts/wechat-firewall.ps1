param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install", "status", "uninstall")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$PatchedExecutablePath,

  [Parameter(Mandatory = $true)]
  [string]$SourceExecutablePath,

  [Parameter(Mandatory = $true)]
  [string]$ManagedWorkRoot,

  [Parameter(Mandatory = $true)]
  [string]$TempRoot
)

$ErrorActionPreference = "Stop"
$patchedPath = [IO.Path]::GetFullPath($PatchedExecutablePath)
$sourcePath = [IO.Path]::GetFullPath($SourceExecutablePath)
$workRoot = [IO.Path]::GetFullPath($ManagedWorkRoot).TrimEnd('\')
$temporaryRoot = [IO.Path]::GetFullPath($TempRoot).TrimEnd('\')
$managedBufferPrefix = "$workRoot\wx-channel-buffer\"
$ruleNames = @(
  "P0004-WechatSidecar-Patched-LocalOnly",
  "P0004-WechatSidecar-Source-LocalOnly"
)

function Test-P0004WechatProgram {
  param([string]$Program)
  if (-not $Program) { return $false }
  try {
    $resolved = [IO.Path]::GetFullPath($Program)
  } catch {
    return $false
  }
  if ($resolved.Equals($patchedPath, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  if ($resolved.Equals($sourcePath, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  if ($resolved.StartsWith($managedBufferPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    return [IO.Path]::GetFileName($resolved).Equals(
      "wx_channel.exe",
      [StringComparison]::OrdinalIgnoreCase
    )
  }
  if (-not $resolved.StartsWith("$temporaryRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }
  $relative = $resolved.Substring($temporaryRoot.Length + 1)
  $projectTemporary = $relative.StartsWith("p0004-", [StringComparison]::OrdinalIgnoreCase) `
    -or $relative.StartsWith("video-capture-", [StringComparison]::OrdinalIgnoreCase)
  return $projectTemporary -and [IO.Path]::GetFileName($resolved).Equals(
    "wx_channel.exe",
    [StringComparison]::OrdinalIgnoreCase
  )
}

function Get-P0004WechatRules {
  $seen = @{}
  $rules = @()
  $filters = Get-NetFirewallApplicationFilter -PolicyStore PersistentStore -ErrorAction SilentlyContinue
  foreach ($filter in $filters) {
    if (-not (Test-P0004WechatProgram -Program $filter.Program)) { continue }
    $associated = Get-NetFirewallRule `
      -AssociatedNetFirewallApplicationFilter $filter `
      -PolicyStore PersistentStore `
      -ErrorAction SilentlyContinue
    foreach ($rule in $associated) {
      if ($seen.ContainsKey($rule.Name)) { continue }
      $seen[$rule.Name] = $true
      $rules += $rule
    }
  }
  return $rules
}

if ($Action -ne "status") {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This firewall action requires an elevated Windows PowerShell process."
  }
}

$removedCount = 0
if ($Action -eq "install") {
  $legacyRules = @(Get-P0004WechatRules)
  $legacyNames = @($legacyRules | Select-Object -ExpandProperty Name -Unique)
  if ($legacyNames.Count -gt 0) {
    Remove-NetFirewallRule -Name $legacyNames -PolicyStore PersistentStore
    $removedCount = $legacyNames.Count
  }
  New-NetFirewallRule `
    -Name $ruleNames[0] `
    -DisplayName "P0004 WeChat sidecar local-only (patched)" `
    -Group "P0004 Video Knowledge Capture" `
    -Direction Inbound `
    -Action Block `
    -Enabled True `
    -Profile Any `
    -Program $patchedPath `
    -EdgeTraversalPolicy Block | Out-Null
  New-NetFirewallRule `
    -Name $ruleNames[1] `
    -DisplayName "P0004 WeChat sidecar local-only (source)" `
    -Group "P0004 Video Knowledge Capture" `
    -Direction Inbound `
    -Action Block `
    -Enabled True `
    -Profile Any `
    -Program $sourcePath `
    -EdgeTraversalPolicy Block | Out-Null
}

if ($Action -eq "uninstall") {
  foreach ($name in $ruleNames) {
    $rule = Get-NetFirewallRule -Name $name -PolicyStore PersistentStore -ErrorAction SilentlyContinue
    if ($rule) {
      Remove-NetFirewallRule -Name $name -PolicyStore PersistentStore
      $removedCount += 1
    }
  }
}

$installed = @()
foreach ($name in $ruleNames) {
  $rule = Get-NetFirewallRule -Name $name -PolicyStore PersistentStore -ErrorAction SilentlyContinue
  if (-not $rule) { continue }
  $filter = Get-NetFirewallApplicationFilter `
    -AssociatedNetFirewallRule $rule `
    -PolicyStore PersistentStore
  $installed += [ordered]@{
    name = $rule.Name
    enabled = $rule.Enabled.ToString()
    direction = $rule.Direction.ToString()
    action = $rule.Action.ToString()
    profile = $rule.Profile.ToString()
    program = $filter.Program
  }
}

[ordered]@{
  action = $Action
  removedRules = $removedCount
  installedRules = $installed
} | ConvertTo-Json -Depth 5 -Compress
