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

# Same gradient + mascot as the app's own terminal UI (src/ui.mjs) — this
# script updates an existing local clone; for a fresh-machine one-liner see
# bootstrap.ps1 (deployed at https://omni.globalwarningnetworks.com/install.ps1).
$Gradient = @(@(80, 236, 240), @(168, 96, 240), @(255, 145, 92))
$ESC = [char]27
$UseColor = (-not [Console]::IsOutputRedirected) -and (-not $env:NO_COLOR)
function Rgb([int[]]$c, [string]$text) {
  if (-not $UseColor) { return $text }
  return "$ESC[38;2;$($c[0]);$($c[1]);$($c[2])m$text$ESC[0m"
}

function Write-Info([string]$Message) {
  Write-Host "  $(Rgb $Gradient[0] '(•‿•)')  [Omni Installer] $Message"
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
  Write-Info "No .git folder detected, using GitHub archive update"

  $zipUrl = "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/$DefaultBranch.zip"
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("omni-install-" + [guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tempRoot "repo.zip"
  $extractPath = Join-Path $tempRoot "extract"

  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  New-Item -ItemType Directory -Path $extractPath | Out-Null

  try {
    Write-Info "Downloading latest source from $DefaultBranch"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -Headers @{ "User-Agent" = "omni-installer" }

    Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
    $repoFolder = Get-ChildItem -Path $extractPath -Directory | Select-Object -First 1
    if (-not $repoFolder) {
      throw "Failed to extract repository archive"
    }

    $source = $repoFolder.FullName
    Write-Info "Syncing files from downloaded archive"

    $excludeDirs = @(".git", "agent", "node_modules", "dist", "site/downloads")
    $excludeFiles = @(".env", ".env.local")

    robocopy $source $ProjectRoot /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP /XD $excludeDirs /XF $excludeFiles | Out-Host

    # Robocopy exit codes <= 7 are successful copy variants.
    if ($LASTEXITCODE -gt 7) {
      throw "robocopy failed with exit code $LASTEXITCODE"
    }

    Write-Info "Zip-based update completed"
  }
  finally {
    if (Test-Path $tempRoot) {
      Remove-Item $tempRoot -Recurse -Force
    }
  }
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
Write-Host "  $(Rgb $Gradient[2] '(^‿^)')  Omi: install complete — Omni v$installedVersion"
Write-Info "Run Omni with: npm start (or 'omni' if you've run 'npm link')"
