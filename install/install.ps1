# Omni installer — the one canonical install/update path.
#
# Public one-liner (fresh machine, no clone required):
#
#   irm https://omni.globalwarningnetworks.com/install.ps1 | iex
#
# That URL serves a thin shim (install/web-install.ps1 in this repo) whose only
# job is to fetch THIS file from GitHub and run it. So this script is the single
# source of truth for how Omni installs: push a change here and the public
# installer picks it up on the next run — nothing to redeploy to the website.
#
# From a checkout, run it directly to update and re-run setup:
#
#   .\install\install.ps1              # update this checkout (git pull / zip refresh)
#   .\install\install.ps1 -AutoUpdate  # ...and actually pull without asking
#
# Modes:
#   auto (default)  .git present -> git; otherwise -> zip
#   git             fetch, report ahead/behind, pull only with -AutoUpdate
#   zip             download the branch archive from GitHub and sync files in
#
# Version comes from package.json on the branch, so this script and the app can
# never drift out of sync — there is no hardcoded version to bump by hand.
#
# Safe to re-run. It never overwrites an existing .env or agent/settings.json:
# your API keys are never touched, and no secret is ever downloaded, generated,
# or required by this script — only .env.example / settings.example.json
# templates are put in place.

param(
  [string]$InstallDir,
  [string]$RepoOwner = "tattooinmtl",
  [string]$RepoName = "omni",
  [string]$Branch = "main",
  [ValidateSet("auto", "git", "zip")]
  [string]$Mode = "auto",
  [switch]$Force,
  [switch]$AutoUpdate,
  [switch]$WithRouter,
  [switch]$SkipLink
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Info([string]$Message) {
  Write-Host "[Omni Installer] $Message"
}

function Ensure-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name not found. $Hint"
  }
}

# Where does Omni live? Explicit -InstallDir wins. Otherwise: running from a
# checkout (install\install.ps1) targets that checkout; piped from the web
# ($PSScriptRoot is empty) targets the default user install dir.
function Resolve-InstallDir() {
  if ($InstallDir) { return (New-Item -ItemType Directory -Path $InstallDir -Force).FullName }
  if ($PSScriptRoot) {
    $candidate = Split-Path -Parent $PSScriptRoot
    if (Test-Path (Join-Path $candidate "package.json")) { return $candidate }
  }
  return (Join-Path $HOME "Omni")
}

function Get-LatestVersion() {
  $pkgUrl = "https://raw.githubusercontent.com/$RepoOwner/$RepoName/$Branch/package.json"
  return (Invoke-RestMethod -Uri $pkgUrl -Headers @{ "User-Agent" = "omni-installer" }).version
}

function Get-LocalVersion([string]$Root) {
  $pkg = Join-Path $Root "package.json"
  if (-not (Test-Path $pkg)) { return $null }
  try { return (Get-Content $pkg -Raw | ConvertFrom-Json).version } catch { return $null }
}

# Files without which a copy of Omni is not runnable. A half-synced install is
# worse than an obviously failed one, so a zip refresh is verified before setup.
function Check-RequiredFiles([string]$Root) {
  $listPath = Join-Path $Root "install\required-files.json"
  if (-not (Test-Path $listPath)) { return }
  $missing = @()
  foreach ($rel in (Get-Content $listPath -Raw | ConvertFrom-Json)) {
    if (-not (Test-Path (Join-Path $Root $rel))) { $missing += $rel }
  }
  if ($missing.Count -gt 0) {
    $missing | ForEach-Object { Write-Host "  - $_" }
    throw "install is missing required files (listed above). Re-run with -Force to resync from GitHub."
  }
}

function Update-FromZip([string]$Root) {
  $latest = Get-LatestVersion
  $current = Get-LocalVersion $Root
  Info "Latest version: v$latest"

  if ($current -eq $latest -and -not $Force) {
    Info "Already on v$latest — nothing to download. Use -Force to resync anyway."
    return
  }
  if ($current) { Info "Updating v$current -> v$latest in $Root" }
  else { Info "Installing v$latest to $Root" }

  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("omni-install-" + [guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tempRoot "omni.zip"
  $extractPath = Join-Path $tempRoot "extract"
  New-Item -ItemType Directory -Path $extractPath -Force | Out-Null

  try {
    $zipUrl = "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/$Branch.zip"
    Info "Downloading $zipUrl"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -Headers @{ "User-Agent" = "omni-installer" }

    Info "Extracting archive"
    Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
    $repoFolder = Get-ChildItem -Path $extractPath -Directory | Select-Object -First 1
    if (-not $repoFolder) { throw "archive extracted empty" }

    Info "Installing files to $Root"
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    # Never touch a user's own secrets or local state on an update. robocopy is
    # deliberately not /MIR: anything the user owns in the destination stays.
    $excludeDirs = @(".git", "agent", "node_modules", "dist", "site\downloads")
    $excludeFiles = @(".env", ".env.local")
    robocopy $repoFolder.FullName $Root /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP /XD $excludeDirs /XF $excludeFiles | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "robocopy failed with exit code $LASTEXITCODE" }
    Info "Files installed"
  }
  finally {
    if (Test-Path $tempRoot) { Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

function Update-FromGit([string]$Root) {
  Ensure-Command "git" "Install Git from https://git-scm.com/downloads"
  Push-Location $Root
  try {
    Info "Fetching latest remote refs"
    git fetch --all --prune | Out-Host

    $head = (git rev-parse HEAD).Trim()
    $remoteRef = "origin/$Branch"
    $remoteHead = (git rev-parse $remoteRef).Trim()

    if ($head -eq $remoteHead) {
      Info "Already up to date with $remoteRef"
      return
    }
    if ($AutoUpdate) {
      Info "Updating working tree to latest $remoteRef"
      git pull origin $Branch | Out-Host
    } else {
      Write-Warning "Update available: local $head vs remote $remoteHead"
      Write-Warning "Re-run with -AutoUpdate to pull the latest changes"
    }
  }
  finally {
    Pop-Location
  }
}

function Initialize-Install([string]$Root) {
  Push-Location $Root
  try {
    # Templates only — never fabricate or fetch real keys.
    if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
      Copy-Item ".env.example" ".env"
      Info "Created .env from .env.example"
    }

    Info "Running project setup"
    if ($WithRouter) { & node ./scripts/setup.mjs --with-router }
    else { & node ./scripts/setup.mjs }
    if ($LASTEXITCODE -ne 0) { throw "scripts/setup.mjs exited with code $LASTEXITCODE" }

    if ($SkipLink) {
      Info "Skipping npm link (-SkipLink)"
      return
    }
    Info "Linking the omni command globally"
    $linkOutput = & npm link 2>&1
    if ($LASTEXITCODE -ne 0) {
      Info "WARNING: npm link failed: $linkOutput"
      Info "You can link it yourself later with: npm link (run from $Root)"
    } else {
      Info "omni command linked"
    }
  }
  finally {
    Pop-Location
  }
}

try {
  Ensure-Command "node" "Install Node.js 20+ from https://nodejs.org, then re-run this installer."
  $nodeMajor = [int]((& node -e "console.log(process.versions.node.split('.')[0])").Trim())
  if ($nodeMajor -lt 20) {
    throw "found Node $((& node -v).Trim()), need 20+. Install from https://nodejs.org"
  }

  $root = Resolve-InstallDir
  $effectiveMode = $Mode
  if ($effectiveMode -eq "auto") {
    $effectiveMode = if (Test-Path (Join-Path $root ".git")) { "git" } else { "zip" }
  }
  Info "Target: $root (mode: $effectiveMode)"

  if ($effectiveMode -eq "git") { Update-FromGit $root }
  else { Update-FromZip $root }

  Check-RequiredFiles $root
  Initialize-Install $root

  $installed = Get-LocalVersion $root
  Info "Install complete — Omni v$installed is ready."

  Write-Host ""
  Write-Host "Next steps:"
  Write-Host "  1. cd into any project folder"
  Write-Host "  2. Set a provider key: omni --set-key nvidia nvapi-xxxx"
  Write-Host "     (free key: https://build.nvidia.com — or edit $root\.env)"
  Write-Host "  3. Run: omni"
  Write-Host ""
}
catch {
  Info "ERROR: install failed — $($_.Exception.Message)"
  exit 1
}
