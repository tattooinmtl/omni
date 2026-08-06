param(
  [string]$RepoOwner = "tattooinmtl",
  [string]$RepoName = "omni",
  [string]$Branch,
  [switch]$WithRouter,
  [switch]$AutoUpdate,
  [switch]$SkipRepoUpdate
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path (Join-Path $ScriptRoot "..")
$RequiredListPath = Join-Path $ScriptRoot "required-files.json"

# This script updates an existing local clone; for a fresh-machine one-liner
# see website/install.ps1 (deployed at https://omni.globalwarningnetworks.com/install.ps1).

function Write-Info([string]$Message) {
  Write-Host "[Omni Installer] $Message"
}

function Ensure-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found. $Hint"
  }
}

function Get-Json([string]$Uri) {
  return Invoke-RestMethod -Uri $Uri -Headers @{ "User-Agent" = "omni-installer" }
}

function Get-RequiredPaths() {
  if (-not (Test-Path $RequiredListPath)) {
    throw "Missing required files list: $RequiredListPath"
  }
  $raw = Get-Content $RequiredListPath -Raw
  return $raw | ConvertFrom-Json
}

function Check-RequiredFiles() {
  Write-Info "Checking required OMNI files"
  $requiredPaths = Get-RequiredPaths
  $missing = @()

  foreach ($relPath in $requiredPaths) {
    $fullPath = Join-Path $ProjectRoot $relPath
    if (-not (Test-Path $fullPath)) {
      $missing += $relPath
    }
  }

  if ($missing.Count -eq 0) {
    Write-Info "Required files check passed"
    return
  }

  Write-Warning "Missing required files detected:"
  $missing | ForEach-Object { Write-Host "  - $_" }
  throw "Required files are missing. Run with -AutoUpdate to refresh from GitHub."
}

function Get-DefaultBranch() {
  if ($Branch) {
    return $Branch
  }
  $repoMeta = Get-Json "https://api.github.com/repos/$RepoOwner/$RepoName"
  if (-not $repoMeta.default_branch) {
    throw "Could not determine default branch from GitHub API"
  }
  return [string]$repoMeta.default_branch
}

function Update-FromGitClone([string]$DefaultBranch) {
  Ensure-Command "git" "Install Git from https://git-scm.com/downloads"
  Push-Location $ProjectRoot
  try {
    Write-Info "Fetching latest remote refs"
    git fetch --all --prune | Out-Host

    $head = (git rev-parse HEAD).Trim()
    $remoteRef = "origin/$DefaultBranch"
    $remoteHead = (git rev-parse $remoteRef).Trim()

    if ($head -eq $remoteHead) {
      Write-Info "Already up to date with $remoteRef"
      return
    }

    if ($AutoUpdate) {
      Write-Info "Updating working tree to latest $remoteRef"
      git pull origin $DefaultBranch | Out-Host
    } else {
      Write-Warning "Update available: local $head vs remote $remoteHead"
      Write-Warning "Re-run with -AutoUpdate to pull latest changes"
    }
  }
  finally {
    Pop-Location
  }
}

function Update-FromZip([string]$DefaultBranch) {
  Write-Info "No .git folder detected — delegating to the canonical fresh-install script"
  # website/install.ps1 is the one canonical "download zip, sync files, link"
  # implementation (it's also the public one-liner deployed at
  # https://omni.globalwarningnetworks.com/install.ps1) — reuse it here
  # instead of keeping a second copy of the same robocopy logic that can
  # (and has) drifted from it. website/ isn't shipped in a normal
  # checkout/zip (it's dev-only, gitignored), so prefer the local copy when
  # this IS an Omni dev checkout (faster, no extra network fetch) and fall
  # back to the deployed URL otherwise.
  # Note: the delegated script calls `exit` on its own failure (it has its
  # own $ErrorActionPreference = "Stop" + try/catch), which — via the call
  # operator below — terminates this whole process with that same failure
  # code. There's nothing meaningful to re-check afterward: on success,
  # $LASTEXITCODE just reflects whatever external command it last ran
  # (e.g. robocopy's own "1-7 all mean success" convention), not overall
  # success/failure, so re-checking it here would be unreliable, not safer.
  $localScript = Join-Path $ProjectRoot "website\install.ps1"
  if (Test-Path $localScript) {
    Write-Info "Using local website/install.ps1"
    & $localScript -InstallDir $ProjectRoot -RepoOwner $RepoOwner -RepoName $RepoName -Branch $DefaultBranch -Force
  } else {
    Write-Info "Fetching canonical installer from omni.globalwarningnetworks.com"
    $scriptContent = Invoke-RestMethod -Uri "https://omni.globalwarningnetworks.com/install.ps1" -Headers @{ "User-Agent" = "omni-installer" }
    $scriptBlock = [ScriptBlock]::Create($scriptContent)
    & $scriptBlock -InstallDir $ProjectRoot -RepoOwner $RepoOwner -RepoName $RepoName -Branch $DefaultBranch -Force
  }
  Write-Info "Zip-based update completed"
}

function Check-RepoUpdates([string]$DefaultBranch) {
  if ($SkipRepoUpdate) {
    Write-Info "Skipping repository update check"
    return
  }

  if (Test-Path (Join-Path $ProjectRoot ".git")) {
    Update-FromGitClone -DefaultBranch $DefaultBranch
    return
  }

  if ($AutoUpdate) {
    Update-FromZip -DefaultBranch $DefaultBranch
  } else {
    Write-Warning "This looks like a zip copy. Re-run with -AutoUpdate to refresh from GitHub."
  }
}

function Run-ProjectSetup() {
  Ensure-Command "node" "Install Node.js 20+ from https://nodejs.org"

  Push-Location $ProjectRoot
  try {
    $nodeVersion = (& node -v).Trim()
    Write-Info "Using Node $nodeVersion"

    if ($WithRouter) {
      & node ./scripts/setup.mjs --with-router
    } else {
      & node ./scripts/setup.mjs
    }

    if ($LASTEXITCODE -ne 0) {
      throw "scripts/setup.mjs failed"
    }
  }
  finally {
    Pop-Location
  }
}

Write-Info "Starting installation bootstrap"
$defaultBranch = Get-DefaultBranch
Write-Info "Default branch: $defaultBranch"

Check-RepoUpdates -DefaultBranch $defaultBranch
Check-RequiredFiles
Run-ProjectSetup

$installedVersion = (Get-Content (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json).version
Write-Host ""
Write-Info "Install complete - Omni v$installedVersion"
Write-Info "Run Omni with: npm start (or 'omni' if you've run 'npm link')"
