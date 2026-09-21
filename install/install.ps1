# Omni installer - the one canonical install/update path.
#
# Public one-liner (fresh machine, no clone required):
#
#   irm https://omni.globalwarningnetworks.com/install.ps1 | iex
#
# That URL serves a thin shim (install/web-install.ps1 in this repo) whose only
# job is to fetch THIS file from GitHub and run it. So this script is the single
# source of truth for how Omni installs: push a change here and the public
# installer picks it up on the next run - nothing to redeploy to the website.
#
# From a checkout, run it directly to update and re-run setup:
#
#   .\install\install.ps1              # update this checkout (git pull / zip refresh)
#   .\install\install.ps1 -NoUpdate    # ...or just report whether one exists
#
# Modes:
#   auto (default)  .git present -> git; otherwise -> zip
#   git             fetch and fast-forward the install onto origin/<branch>
#   zip             download the branch archive from GitHub and sync files in
#
# Updating is the DEFAULT. It used to require -AutoUpdate, which the public
# one-liner above physically cannot pass (`irm | iex` takes no arguments), so
# every git-mode install warned "update available" and then stayed on its old
# version forever. Pass -NoUpdate to only check. -AutoUpdate is still accepted
# and now means nothing - it is the default.
#
# What the update will NEVER do: touch a dirty working tree, discard commits
# that aren't on the remote, or create a surprise merge commit. If the install
# has local work it says so and stops instead of updating.
#
# Version comes from package.json on the branch, so this script and the app can
# never drift out of sync - there is no hardcoded version to bump by hand.
#
# Safe to re-run. It never overwrites an existing .env or agent/settings.json:
# your API keys are never touched, and no secret is ever downloaded, generated,
# or required by this script - only .env.example / settings.example.json
# templates are put in place.

param(
  [string]$InstallDir,
  [string]$RepoOwner = "tattooinmtl",
  [string]$RepoName = "omni",
  [string]$Branch = "main",
  [ValidateSet("auto", "git", "zip")]
  [string]$Mode = "auto",
  [switch]$Force,
  # Kept so existing invocations (README, `npm run install:update`) keep
  # working. Updating is the default now, so this switch is a no-op.
  [switch]$AutoUpdate,
  # Check and report only - don't move the working tree.
  [switch]$NoUpdate,
  [switch]$WithRouter,
  [switch]$SkipLink,
  # Local GGUF models directory. Default target is C:\models. Pass an explicit
  # path for silent installs; pass "" to skip the create prompt entirely.
  [string]$ModelsDir = "C:\models",
  [switch]$SkipModelsPrompt
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

# Where does Omni live? The canonical user install dir is always $HOME/.omni.
# The leading dot avoids a name collision with the unrelated "omni" app shipped
# by another vendor - never install to a bare ~/omni. Pass -InstallDir to
# override (e.g. for a development checkout); otherwise the piped one-liner and
# .\install\install.ps1 from anywhere both target $HOME/.omni.
function Resolve-InstallDir() {
  if ($InstallDir) { return (New-Item -ItemType Directory -Path $InstallDir -Force).FullName }
  return (Join-Path $HOME ".omni")
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
    Info "Already on v$latest - nothing to download. Use -Force to resync anyway."
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
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed (exit $LASTEXITCODE)" }

    $remoteRef = "origin/$Branch"
    $remoteHead = (git rev-parse --verify --quiet $remoteRef)
    if (-not $remoteHead) { throw "$remoteRef does not exist on the remote - check -Branch." }
    $remoteHead = $remoteHead.Trim()
    $head = (git rev-parse HEAD).Trim()
    $currentBranch = (git rev-parse --abbrev-ref HEAD).Trim()

    if ($head -eq $remoteHead) {
      Info "Already up to date with $remoteRef"
      return
    }

    if ($NoUpdate) {
      Write-Warning "Update available: local $head vs $remoteRef $remoteHead (-NoUpdate, not applying)"
      return
    }

    # Uncommitted work is the user's. Never move the tree out from under it.
    $dirty = @(git status --porcelain)
    if ($dirty.Count -gt 0 -and -not $Force) {
      Write-Warning "$Root has $($dirty.Count) uncommitted change(s) - NOT updating."
      Write-Warning "Commit or stash them, then re-run. (-Force updates anyway.)"
      return
    }

    # Commits that exist here and nowhere on the remote branch. This is what
    # stranded installs on an unmerged feature branch: the install dir was
    # checked out on one, so every run reported "update available" and no
    # update could ever fast-forward it. Say exactly what would be lost
    # rather than moving the tree and orphaning the work.
    $ahead = @(git log --oneline "$remoteRef..HEAD")
    if ($ahead.Count -gt 0 -and -not $Force) {
      Write-Warning "$Root is on '$currentBranch' with $($ahead.Count) commit(s) not on ${remoteRef}:"
      $ahead | ForEach-Object { Write-Warning "  $_" }
      Write-Warning "NOT updating - those commits would be left behind on '$currentBranch'."
      Write-Warning "Merge or push them first, then re-run. (-Force switches to $Branch anyway; the commits stay on '$currentBranch'.)"
      return
    }

    # The install dir must track the release branch. A checkout parked on
    # another branch can never reach the latest version.
    if ($currentBranch -ne $Branch) {
      Info "Switching install from '$currentBranch' to '$Branch'"
      git checkout $Branch 2>&1 | Out-Host
      if ($LASTEXITCODE -ne 0) {
        git checkout -B $Branch --track $remoteRef 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "could not switch $Root to $Branch" }
      }
    }

    # --ff-only: advance to the remote or fail loudly. Never a merge commit,
    # never a half-applied update reported as success.
    Info "Updating working tree to latest $remoteRef"
    git merge --ff-only $remoteRef 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
      if ($Force) {
        Write-Warning "Fast-forward failed - resetting '$Branch' to $remoteRef (-Force)"
        git reset --hard $remoteRef 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "git reset --hard $remoteRef failed" }
      } else {
        throw "could not fast-forward $Root to $remoteRef - resolve it there, or re-run with -Force."
      }
    }
  }
  finally {
    Pop-Location
  }
}

# C:\models is where /llama-start looks by default. If the folder exists, use
# it silently. If it doesn't, offer to create it (unless -SkipModelsPrompt or
# ModelsDir="" was passed). Never fabricates GGUF files - just the empty dir.
function Ensure-ModelsDir() {
  if ([string]::IsNullOrWhiteSpace($ModelsDir)) {
    Info "Skipping local models directory setup (ModelsDir='')"
    return
  }
  if (Test-Path $ModelsDir) {
    Info "Found $ModelsDir - using it for local GGUF models."
    return
  }
  if ($SkipModelsPrompt -or $Force) {
    New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null
    Info "Created $ModelsDir. Drop .gguf files here to see them in /llama list."
    return
  }
  $ans = Read-Host "Create $ModelsDir for local GGUF models? [Y/n]"
  if ($ans -eq "" -or $ans -match "^[Yy]") {
    New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null
    Info "Created $ModelsDir. Drop .gguf files here to see them in /llama list."
  } else {
    Info "Skipped. Set llama.modelsDir in agent/settings.json (or OMNI_MODELS_DIR env) to point elsewhere."
  }
}

function Initialize-Install([string]$Root) {
  Push-Location $Root
  try {
    # Templates only - never fabricate or fetch real keys.
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
  Ensure-ModelsDir
  Initialize-Install $root

  $installed = Get-LocalVersion $root
  # Don't declare victory on a version that isn't the latest. The old ending
  # printed "Install complete - Omni v<local> is ready" no matter what, so an
  # install that had silently declined to update looked like a successful one.
  $latest = $null
  try { $latest = Get-LatestVersion } catch { $latest = $null }
  if ($latest -and $installed -and $installed -ne $latest) {
    Write-Warning "Omni v$installed is installed, but v$latest is what $Branch has."
    Write-Warning "The update did not apply - see the messages above for why."
    Write-Warning "Install dir: $root"
  } else {
    Info "Install complete - Omni v$installed is ready."
  }

  Write-Host ""
  Write-Host "Next steps:"
  Write-Host "  1. cd into any project folder"
  Write-Host "  2. Set a provider key: omni --set-key nvidia nvapi-xxxx"
  Write-Host "     (free key: https://build.nvidia.com - or edit $root\.env)"
  Write-Host "  3. Run: omni"
  Write-Host ""
}
catch {
  Info "ERROR: install failed - $($_.Exception.Message)"
  exit 1
}
