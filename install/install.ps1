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
# Optional runtime pack (ffmpeg, ripgrep, fd, jq into <install>\vendor - no
# admin rights, checksum-verified) with -WithRuntime, or from the one-liner,
# which can't pass switches:
#
#   $env:OMNI_RUNTIME = "1"; irm https://omni.globalwarningnetworks.com/install.ps1 | iex
#
# Later, from Omni: /runtime install (or: omni runtime install).
#
# Optional local AI (llama.cpp, pinned and checksum-verified) with -Llama, or
# OMNI_LLAMA from the one-liner:
#   none  (default) nothing - add it later with /llama update
#   cpu   the CPU build, for any PC
#   cuda  the CPU build plus the CUDA 13.4 build for NVIDIA GPUs (~595 MB more,
#         needs NVIDIA driver 580+; RTX 50-series needs this one)
#   auto  the CPU build, plus CUDA only if nvidia-smi finds an NVIDIA GPU
#
#   $env:OMNI_LLAMA = "auto"; irm https://omni.globalwarningnetworks.com/install.ps1 | iex
#
# Later, from Omni: /llama update and /llama update cuda.
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
  # Also install the optional runtime pack (same as OMNI_RUNTIME=1).
  [switch]$WithRuntime,
  # Optional local AI: none | cpu | cuda | auto (same as OMNI_LLAMA).
  [ValidateSet("", "none", "cpu", "cuda", "auto")]
  [string]$Llama = "",
  [switch]$SkipLink,
  # Local GGUF models directory. Default target is C:\models. Pass an explicit
  # path for silent installs; pass "" to skip the create prompt entirely.
  [string]$ModelsDir = "C:\models",
  [switch]$SkipModelsPrompt
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# This file as it was when it started. PowerShell keeps running the copy it
# loaded, so after the update replaces install\install.ps1, the rest of the
# run is still the old installer, bugs and all (3.5.40's .Count failure
# outlived its fix by one update). Compared after the update to hand off to
# the new copy (see Invoke-NewInstaller). No hash when run from memory (the
# web one-liner), which always fetches the latest anyway.
$script:StartHash = if ($PSCommandPath -and (Test-Path $PSCommandPath)) { (Get-FileHash -Algorithm SHA256 $PSCommandPath).Hash } else { $null }

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

# Run an external program and return its exit code. Never throws just because
# the program wrote to stderr.
#
# Windows PowerShell 5.1 (what `powershell.exe` is) turns stderr into a
# terminating error when $ErrorActionPreference is Stop and the caller merges
# it with 2>&1. That includes `$output = & git ... 2>&1` and `2>&1 | Out-Host`,
# and it happens even when the program exits 0. git fetch and git checkout
# write ordinary progress there ("From github.com...", "Switched to branch
# main"), so a successful update died before the fast-forward. npm link does
# the same with its notices. Continue applies only inside this function.
# Lines are written to the host so the caller receives one integer, not the
# captured text mixed in with it.
function Invoke-External([string]$File, [string[]]$ArgList) {
  $ErrorActionPreference = "Continue"
  # PS 7 only. Harmless on 5.1. Stops a profile that opted into "stderr is an error".
  $PSNativeCommandUseErrorActionPreference = $false
  $output = & $File @ArgList 2>&1
  $code = $LASTEXITCODE
  foreach ($line in @($output)) {
    $text = "$line".TrimEnd()
    if ($text.Length -gt 0) { Write-Host "  $text" }
  }
  if ($null -eq $code) { return 1 }
  return $code
}

function Invoke-Git([string[]]$GitArgs) {
  return (Invoke-External "git" $GitArgs)
}
function Update-FromGit([string]$Root) {
  Ensure-Command "git" "Install Git from https://git-scm.com/downloads"
  Push-Location $Root
  try {
    Info "Fetching latest remote refs"
    if ((Invoke-Git @("fetch", "--all", "--prune")) -ne 0) { throw "git fetch failed" }

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
    # Only tracked files count: an untracked folder (a side project dropped in
    # the install dir) used to block every update, and a fast-forward can't
    # lose one anyway - git refuses to overwrite an untracked file.
    $dirty = @(git status --porcelain --untracked-files=no)
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
      if ((Invoke-Git @("checkout", $Branch)) -ne 0) {
        # No local branch of that name yet - create one tracking the remote.
        if ((Invoke-Git @("checkout", "-B", $Branch, "--track", $remoteRef)) -ne 0) {
          throw "could not switch $Root to $Branch"
        }
      }
    }

    # --ff-only: advance to the remote or fail loudly. Never a merge commit,
    # never a half-applied update reported as success.
    Info "Updating working tree to latest $remoteRef"
    if ((Invoke-Git @("merge", "--ff-only", $remoteRef)) -ne 0) {
      if ($Force) {
        Write-Warning "Fast-forward failed - resetting '$Branch' to $remoteRef (-Force)"
        if ((Invoke-Git @("reset", "--hard", $remoteRef)) -ne 0) { throw "git reset --hard $remoteRef failed" }
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
    # Same stderr trap as git: npm writes notices to stderr on a successful link.
    if ((Invoke-External "npm" @("link")) -ne 0) {
      Info "WARNING: npm link failed. You can link it yourself later with: npm link (run from $Root)"
    } else {
      Info "omni command linked"
    }
  }
  finally {
    Pop-Location
  }
}

# The runtime pack is optional: a failed download must not fail the install.
function Install-RuntimePack([string]$Root) {
  # This script always comes fresh from GitHub, but the Omni it runs against
  # may not have updated (local changes, -NoUpdate). Before 3.5.17 there is
  # no `runtime` command, and `omni runtime install` is taken as a one-shot
  # prompt and sent to the model - so only run it where the command exists.
  if (-not (Test-Path (Join-Path $Root "src\cli\runtime-cmd.mjs"))) {
    Write-Warning "Skipping the runtime pack: this Omni ($(Get-LocalVersion $Root)) predates it."
    Write-Warning "Update Omni first (see the messages above), then run: omni runtime install"
    return
  }
  Info "Installing the runtime pack (ffmpeg, ripgrep, fd, jq) into $Root\vendor"
  Push-Location $Root
  try {
    & node ./bin/omni.mjs runtime install
    if ($LASTEXITCODE -ne 0) {
      Info "WARNING: some runtime pack parts did not install - run: omni runtime install"
    }
  }
  finally {
    Pop-Location
  }
}

# Which llama.cpp builds the -Llama / OMNI_LLAMA choice means. "auto" asks
# nvidia-smi: a machine without an NVIDIA GPU never downloads CUDA.
# True when nvidia-smi names at least one GPU. Bounded: a hung driver or
# utility must not stall the install, so after $TimeoutSec it is killed and
# the answer is "no" (CPU only).
function Test-NvidiaGpu([int]$TimeoutSec = 15) {
  $smi = Get-Command nvidia-smi -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $smi) { return $false }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $smi.Source
    $psi.Arguments = "--query-gpu=name --format=csv,noheader"
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
      # The whole tree: a wrapper script's children would otherwise keep
      # running and hold the output pipe open.
      # Started as a bare process, not `& taskkill`, so no stderr reaches
      # PowerShell's streams (see Invoke-External for why that matters on 5.1).
      try { [System.Diagnostics.Process]::Start("taskkill.exe", "/PID $($p.Id) /T /F").WaitForExit(5000) | Out-Null } catch { }
      try { if (-not $p.HasExited) { $p.Kill() } } catch { }
      Write-Warning "nvidia-smi did not answer within $TimeoutSec s - installing the CPU build only"
      return $false
    }
    return ($p.ExitCode -eq 0) -and [bool]($out.Result.Trim())
  }
  catch {
    return $false
  }
}

# Call it as @(Resolve-LlamaBuilds ...): PowerShell unrolls a returned array,
# so `return @()` reaches the caller as $null and `return @("cpu")` as a bare
# string, and under StrictMode Latest their .Count throws ("The property
# 'Count' cannot be found on this object"). That failed every update from
# 3.5.37 to 3.5.40. Do not also return ,@(...): with the caller's @() that
# nests the list, and "none" would then install a build named System.Object[].
function Resolve-LlamaBuilds([string]$Choice) {
  switch ($Choice) {
    "cpu"  { return @("cpu") }
    "cuda" { return @("cpu", "cuda") }
    "auto" {
      if (Test-NvidiaGpu) { return @("cpu", "cuda") }
      return @("cpu")
    }
    default { return @() }
  }
}

# Local AI is optional: a failed download must not fail the install.
function Install-LlamaBuilds([string]$Root, [string[]]$Builds) {
  # The headless `omni llama update` arrived in 3.5.37 (3.5.36 already has the
  # CUDA pins, but not the command). On an Omni without the dispatch the words
  # would be sent to the model as a prompt, so check for the dispatch itself.
  $mainFile = Join-Path $Root "src\cli\main.mjs"
  if (-not ((Test-Path $mainFile) -and (Select-String -Path $mainFile -Pattern 'args\[0\] === "llama"' -Quiet))) {
    Write-Warning "Skipping local AI: this Omni ($(Get-LocalVersion $Root)) predates it. Update Omni, then run: omni llama update"
    return
  }
  Push-Location $Root
  try {
    foreach ($b in $Builds) {
      if ($b -eq "cuda") {
        Info "Installing llama.cpp for NVIDIA GPUs (CUDA 13.4, about 595 MB)"
        & node ./bin/omni.mjs llama update cuda
        if ($LASTEXITCODE -ne 0) { Info "WARNING: the CUDA build did not install - run: omni llama update cuda" }
      } else {
        Info "Installing llama.cpp (CPU build)"
        & node ./bin/omni.mjs llama update
        if ($LASTEXITCODE -ne 0) { Info "WARNING: the CPU build did not install - run: omni llama update" }
      }
    }
  }
  finally {
    Pop-Location
  }
}

# The arguments this run was given, for the new installer: the same choices,
# pointed at the same folder, and -NoUpdate since the update is done.
function Get-HandoffArgs([System.Collections.IDictionary]$Bound, [string]$Root) {
  $list = New-Object System.Collections.Generic.List[string]
  foreach ($k in @($Bound.Keys)) {
    if (@("NoUpdate", "InstallDir") -contains $k) { continue }
    $v = $Bound[$k]
    if ($v -is [System.Management.Automation.SwitchParameter]) { if ($v.IsPresent) { $list.Add("-$k") } }
    elseif ($v -is [bool]) { if ($v) { $list.Add("-$k") } }
    else { $list.Add("-$k"); $list.Add([string]$v) }
  }
  $list.Add("-InstallDir"); $list.Add($Root)
  $list.Add("-NoUpdate")
  return $list.ToArray()
}

# True when the update changed install\install.ps1 from the copy running now.
function Test-InstallerChanged([string]$StartHash, [string]$Root) {
  if (-not $StartHash) { return $false }
  $new = Join-Path $Root "install\install.ps1"
  if (-not (Test-Path $new)) { return $false }
  return (Get-FileHash -Algorithm SHA256 $new).Hash -ne $StartHash
}

# Run the new installer for everything after the update, in the same
# PowerShell, and return its exit code; $null when there is nothing to hand
# off. OMNI_INSTALLER_HANDOFF stops the new one from handing off again.
function Invoke-NewInstaller([string]$Root, [System.Collections.IDictionary]$Bound) {
  if ($env:OMNI_INSTALLER_HANDOFF -eq "1") { return $null }
  if (-not (Test-InstallerChanged $script:StartHash $Root)) { return $null }
  $new = Join-Path $Root "install\install.ps1"
  $exe = (Get-Process -Id $PID).Path
  $handoffArgs = @(Get-HandoffArgs $Bound $Root)
  Info "The update changed the installer - continuing with the new one"
  $env:OMNI_INSTALLER_HANDOFF = "1"
  try {
    # Out-Host: the new installer's lines go to the screen, not into this
    # function's return value, which must be the exit code alone.
    & $exe -NoProfile -ExecutionPolicy Bypass -File $new @handoffArgs | Out-Host
    return [int]$LASTEXITCODE
  }
  finally {
    Remove-Item Env:OMNI_INSTALLER_HANDOFF -ErrorAction SilentlyContinue
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

  # A run handed off from the old installer starts after the update.
  if ($env:OMNI_INSTALLER_HANDOFF -eq "1") { Info "Continuing the update with the new installer" }
  elseif ($effectiveMode -eq "git") { Update-FromGit $root }
  else { Update-FromZip $root }

  # The update brought a different installer: let it do the rest.
  $handoff = Invoke-NewInstaller $root $PSBoundParameters
  if ($null -ne $handoff) { exit $handoff }

  Check-RequiredFiles $root
  Ensure-ModelsDir
  Initialize-Install $root
  $wantRuntime = $WithRuntime -or ($env:OMNI_RUNTIME -eq "1")
  if ($wantRuntime) { Install-RuntimePack $root }
  $llamaChoice = if ($Llama) { $Llama } elseif ($env:OMNI_LLAMA) { $env:OMNI_LLAMA.Trim().ToLower() } else { "none" }
  if (@("none", "cpu", "cuda", "auto") -notcontains $llamaChoice) {
    Write-Warning "OMNI_LLAMA=$llamaChoice is not one of none, cpu, cuda, auto - skipping local AI"
    $llamaChoice = "none"
  }
  $llamaBuilds = @(Resolve-LlamaBuilds $llamaChoice)
  if ($llamaChoice -eq "auto" -and $llamaBuilds -notcontains "cuda") {
    Info "Local AI: no NVIDIA GPU found - installing the CPU build only"
  }
  if ($llamaBuilds.Count) { Install-LlamaBuilds $root $llamaBuilds }

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
  if (-not $wantRuntime) {
    Write-Host "  Optional: omni runtime install  (video tools, faster search - see /runtime)"
  }
  if (-not $llamaBuilds.Count) {
    Write-Host "  Optional: omni llama update     (local AI on this PC; add 'cuda' for an NVIDIA GPU)"
  }
  Write-Host ""
}
catch {
  Info "ERROR: install failed - $($_.Exception.Message)"
  exit 1
}
