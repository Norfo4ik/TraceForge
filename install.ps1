<#
.SYNOPSIS
  Installs TraceForge (on-device AI CLI for Azure DevOps) on Windows.

.DESCRIPTION
  One command does everything: it installs Node.js LTS and Git with winget if they are missing, installs TraceForge
  from the latest GitHub release, makes sure the "traceforge" command is on PATH, and offers to start it. The AI model
  itself (and the NPU/GPU runtimes) are downloaded by TraceForge on first start, with your consent.

  Install:  irm https://raw.githubusercontent.com/Norfo4ik/TraceForge/master/install.ps1 | iex
  Options:  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Norfo4ik/TraceForge/master/install.ps1))) -NoLaunch

.PARAMETER Source
  Tarball or URL to install instead of the latest release (also: $env:TRACEFORGE_SOURCE).

.PARAMETER NoLaunch
  Do not offer to start TraceForge at the end (also: $env:TRACEFORGE_NO_LAUNCH=1).

.PARAMETER SkipGit
  Do not install Git when it is missing. TraceForge then works on plain folders only, without commit history.

.PARAMETER NoPathUpdate
  Do not add npm's global folder to your PATH when it is missing from it.
#>
[CmdletBinding()]
param(
  [string]$Source = $env:TRACEFORGE_SOURCE,
  [switch]$NoLaunch,
  [switch]$SkipGit,
  [switch]$NoPathUpdate
)

$ErrorActionPreference = 'Stop'
$ReleaseUrl = 'https://github.com/Norfo4ik/TraceForge/releases/latest/download/traceforge.tgz'
$MinNodeMajor = 20
if (-not $Source) { $Source = $ReleaseUrl }
if ($env:TRACEFORGE_NO_LAUNCH) { $NoLaunch = $true }

function Write-Step([string]$Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }
function Write-Note([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }

# A tool installed by winget is not on PATH for the window that ran the installer until PATH is re-read.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Get-NodeMajor {
  try {
    $version = & node --version 2>$null
    if ($version -match '^v(\d+)') { return [int]$Matches[1] }
  } catch { }
  return 0
}

function Install-WithWinget([string]$Id, [string]$Name) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return $false }
  Write-Note "Installing $Name with winget (this can take a minute)..."
  & winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Update-SessionPath
  return $true
}

Write-Host ''
Write-Host 'TraceForge installer' -ForegroundColor Cyan
Write-Host 'On-device AI for tracing Azure DevOps work items to code.'

# --- Node.js ---------------------------------------------------------------------------------------------------------
Write-Step 'Checking Node.js'
if ((Get-NodeMajor) -lt $MinNodeMajor) {
  $installed = Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
  if (-not $installed) {
    throw "Node.js $MinNodeMajor or newer is required, and winget is not available to install it. Install Node.js LTS from https://nodejs.org, then run this command again."
  }
  if ((Get-NodeMajor) -lt $MinNodeMajor) {
    throw 'Node.js was installed but is not visible in this window yet. Open a new PowerShell window and run the install command again.'
  }
}
Write-Ok "Node.js $(& node --version)"

# --- Git (optional but recommended) --------------------------------------------------------------------------------
Write-Step 'Checking Git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if ($SkipGit) {
    Write-Note 'Git is not installed; skipping (TraceForge will work on plain folders, without commit history).'
  } else {
    [void](Install-WithWinget 'Git.Git' 'Git')
  }
}
if (Get-Command git -ErrorAction SilentlyContinue) {
  Write-Ok (& git --version)
} elseif (-not $SkipGit) {
  Write-Note 'Git could not be installed automatically. TraceForge still works on plain folders; install Git from https://git-scm.com for commit history.'
}

# --- TraceForge ------------------------------------------------------------------------------------------------------
Write-Step 'Installing TraceForge'
Write-Note "From $Source"
& npm install --global --no-fund --no-audit $Source
if ($LASTEXITCODE -ne 0) {
  throw "npm could not install TraceForge from $Source (exit code $LASTEXITCODE). If the address returned 'not found', no release has been published there yet."
}

# The npm global folder normally is on PATH already; when it is not, "traceforge" would be 'not recognized'.
$npmBin = (& npm prefix --global).Trim()
$onPath = ($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $npmBin.TrimEnd('\') }
if (-not $onPath) {
  if ($NoPathUpdate) {
    Write-Note "npm's global folder ($npmBin) is not on your PATH; add it to run 'traceforge' from anywhere."
  } else {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $npmBin) | Where-Object { $_ }) -join ';'), 'User')
    $env:Path = "$env:Path;$npmBin"
    Write-Ok "Added $npmBin to your PATH (new windows pick it up)"
  }
}

# Call the .cmd shim explicitly: PowerShell prefers the .ps1 shim, which a restrictive execution policy can block.
$shim = Join-Path $npmBin 'traceforge.cmd'
if (-not (Test-Path $shim)) { $shim = 'traceforge' }
$installedVersion = & $shim --version
if ($LASTEXITCODE -ne 0) { throw 'TraceForge installed but did not start. Run "traceforge doctor" for details.' }
Write-Ok "TraceForge $installedVersion"

$policy = Get-ExecutionPolicy -Scope CurrentUser
if ($policy -eq 'Restricted' -or ($policy -eq 'Undefined' -and (Get-ExecutionPolicy) -eq 'Restricted')) {
  Write-Note 'PowerShell blocks scripts on this account, which can stop "traceforge" from starting in PowerShell.'
  Write-Note 'If it does, run once:  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'
}

Write-Host ''
Write-Host 'Done. Next:' -ForegroundColor Green
Write-Host '  1. cd into a project (a git repository or any code folder)'
Write-Host '  2. run: traceforge'
Write-Host '  First start offers to enable the NPU and download a model; Azure DevOps can be connected from the menu (Connect).'
Write-Host '  Update later with: traceforge update'

if (-not $NoLaunch -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  Write-Host ''
  $answer = Read-Host 'Start TraceForge now? [Y/n]'
  if ($answer -eq '' -or $answer -match '^[Yy]') { & $shim }
}
