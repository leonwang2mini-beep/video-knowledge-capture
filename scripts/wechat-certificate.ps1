param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install", "uninstall")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,

  [Parameter(Mandatory = $true)]
  [string]$WorkingDirectory,

  [Parameter(Mandatory = $true)]
  [string]$DownloadDirectory,

  [Parameter(Mandatory = $true)]
  [string]$LogFile,

  [Parameter(Mandatory = $true)]
  [string]$ResultFile,

  [Parameter(Mandatory = $true)]
  [AllowEmptyString()]
  [string]$Thumbprint
)

$ErrorActionPreference = "Stop"

function Write-ActionResult {
  param([string]$Status, [string]$Message)
  $payload = [ordered]@{ status = $Status; message = $Message } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($ResultFile, $payload, [Text.UTF8Encoding]::new($false))
}

trap {
  Write-ActionResult -Status "error" -Message $_.Exception.Message
  exit 1
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "This certificate action requires an elevated Windows PowerShell process."
}

if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
  throw "wx_channel executable was not found."
}

$certificateCandidates = @(
  (Join-Path $DownloadDirectory "SunnyRoot.cer"),
  (Join-Path $WorkingDirectory "downloads\SunnyRoot.cer")
)

if ($Action -eq "uninstall") {
  if (-not $Thumbprint) {
    throw "SunnyNet certificate thumbprint is unavailable for exact removal."
  }
  & certutil.exe -delstore Root $Thumbprint | Out-Null
  & certutil.exe -user -delstore Root $Thumbprint | Out-Null
  Write-ActionResult -Status "ok" -Message "SunnyNet certificate is absent."
  Write-Output '{"action":"uninstall","certificate":"absent"}'
  exit 0
}

New-Item -ItemType Directory -Path $DownloadDirectory -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $LogFile) -Force | Out-Null
$env:WX_CHANNEL_DOWNLOADS_DIR = $DownloadDirectory
$env:WX_CHANNEL_LOG_FILE = $LogFile
$certificatePath = $certificateCandidates | Where-Object {
  Test-Path -LiteralPath $_ -PathType Leaf
} | Select-Object -First 1

if ($certificatePath) {
  & certutil.exe -addstore -f Root $certificatePath | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "certutil certificate import exited with code $LASTEXITCODE."
  }
  Write-ActionResult -Status "ok" -Message "SunnyNet certificate is present."
  Write-Output '{"action":"install","certificate":"present"}'
  exit 0
}

$process = $null
try {
  $process = Start-Process `
    -FilePath $ExecutablePath `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -PassThru

  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  $serviceReady = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($process.HasExited) {
      throw "wx_channel exited before its local service became ready."
    }
    try {
      $null = Invoke-RestMethod `
        -Uri "http://127.0.0.1:2025/api/health" `
        -Method Get `
        -TimeoutSec 2
      $serviceReady = $true
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $serviceReady) {
    throw "wx_channel did not become ready within 25 seconds."
  }
  Start-Sleep -Seconds 2
  $certificatePath = $certificateCandidates | Where-Object {
    Test-Path -LiteralPath $_ -PathType Leaf
  } | Select-Object -First 1
  if (-not $certificatePath) {
    throw "wx_channel started, but SunnyRoot.cer was not generated."
  }
  & certutil.exe -addstore -f Root $certificatePath | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "certutil certificate import exited with code $LASTEXITCODE."
  }
  Write-ActionResult -Status "ok" -Message "SunnyNet certificate is present."
  Write-Output '{"action":"install","certificate":"present"}'
} finally {
  if ($null -ne $process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
}
