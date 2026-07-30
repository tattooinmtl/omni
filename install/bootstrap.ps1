# Omni bootstrap installer — the public one-liner entry point:
#
#   irm https://omni.globalwarningnetworks.com/install.ps1 | iex
#
# Works on a completely fresh machine: no existing clone required. Checks the
# latest version straight from package.json on the default branch (so this
# script and the app version can never drift out of sync — there's no
# hardcoded version number to update by hand), downloads the source archive
# with a real byte-tracked progress bar, and wires up the global `omni`
# command via `npm link`. Safe to re-run: it skips the download entirely when
# you're already on the latest version, and never overwrites an existing
# .env or agent/settings.json (your keys are never touched).
#
# No secrets are downloaded, generated, or required by this script — only
# .env.example / settings.example.json templates are put in place.

param(
  [string]$InstallDir = (Join-Path $HOME "Omni"),
  [string]$RepoOwner = "tattooinmtl",
  [string]$RepoName = "omni",
  [string]$Branch = "main",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# ── mascot + color, matching the terminal app's own banner/UI (src/ui.mjs) ──

$Gradient = @(
  @(80, 236, 240), @(107, 202, 247), @(136, 150, 255),
  @(168, 96, 240), @(206, 86, 218), @(238, 129, 176), @(255, 145, 92)
)
$ESC = [char]27
$UseColor = (-not [Console]::IsOutputRedirected) -and (-not $env:NO_COLOR)

$Robot = @("(o_O)?", "(?_?) ")
$RobotHappy = "(^‿^)"
$RobotSad = "(>_<)"
$FunnyWords = @(
  "Tenderising", "Summarising", "Synthesising", "Optimising", "Philosophising",
  "Fantasising", "Improvising", "Advertising", "Surmising", "Revising",
  "Supervising", "Categorising", "Prioritising", "Visualising", "Energising",
  "Mesmerising", "Philanthropising", "Bamboozlising", "Frobnicising", "Pixelising",
  "Noodleising", "Confabulising", "Wobblising", "Sarcasmising", "Marinising",
  "Percolising", "Spelunkising", "Doodleising", "Snacklising", "Ponderising"
)

function Rgb([int[]]$c, [string]$text) {
  if (-not $UseColor) { return $text }
  return "$ESC[38;2;$($c[0]);$($c[1]);$($c[2])m$text$ESC[0m"
}

function GradientText([string]$text) {
  if (-not $UseColor -or $text.Length -eq 0) { return $text }
  $n = $text.Length
  $span = $Gradient.Count - 1
  $sb = New-Object System.Text.StringBuilder
  for ($i = 0; $i -lt $n; $i++) {
    $t = if ($n -gt 1) { $i / [double]($n - 1) } else { 0 }
    $scaled = $t * $span
    $a = [Math]::Floor($scaled)
    $b = [Math]::Min($a + 1, $span)
    $localT = $scaled - $a
    $r = [Math]::Round($Gradient[$a][0] + ($Gradient[$b][0] - $Gradient[$a][0]) * $localT)
    $g = [Math]::Round($Gradient[$a][1] + ($Gradient[$b][1] - $Gradient[$a][1]) * $localT)
    $bl = [Math]::Round($Gradient[$a][2] + ($Gradient[$b][2] - $Gradient[$a][2]) * $localT)
    [void]$sb.Append("$ESC[38;2;$r;$g;${bl}m$($text[$i])")
  }
  if ($UseColor) { [void]$sb.Append("$ESC[0m") }
  return $sb.ToString()
}

function RandomWord { $FunnyWords | Get-Random }

function Write-Banner {
  $lines = @(
    " ██████╗ ███╗   ███╗███╗   ██╗██╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
    "██╔═══██╗████╗ ████║████╗  ██║██║    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
    "██║   ██║██╔████╔██║██╔██╗ ██║██║    ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
    "██║   ██║██║╚██╔╝██║██║╚██╗██║██║    ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
    "╚██████╔╝██║ ╚═╝ ██║██║ ╚████║██║    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
    " ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   "
  )
  Write-Host ""
  for ($i = 0; $i -lt $lines.Count; $i++) {
    Write-Host "  $(Rgb $Gradient[$i] $lines[$i])"
  }
  Write-Host "  $(GradientText 'Omni-present harness for agents')"
  Write-Host ""
}

# One-line "step" report: robot + label, overwritten in place, ending in a
# colored checkmark/cross so a fast terminal doesn't just look frozen.
function Step-Start([string]$Label) {
  Write-Host -NoNewline "`r  $(Rgb $Gradient[0] $Robot[0])  $Label...  "
}
function Step-Done([string]$Label, [string]$Note = "") {
  $suffix = if ($Note) { "  $(Rgb @(140,140,140) $Note)" } else { "" }
  Write-Host "`r  $(Rgb @(120,255,150) '✓')  $Label$suffix$(' ' * 20)"
}
function Step-Fail([string]$Label, [string]$Message) {
  Write-Host "`r  $(Rgb @(255,90,90) 'x')  $Label$(' ' * 20)"
  Write-Host "  $(Rgb @(255,90,90) $RobotSad)  Omi: well, that didn't work — $Message"
}

# A real, byte-tracked download progress bar in the app's gradient, with the
# mascot blinking through its two frames as it fills.
function Get-FileWithBar([string]$Url, [string]$OutFile, [string]$Label) {
  $width = 32
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add("User-Agent", "omni-installer")
  $script:_dlPct = 0
  $script:_dlDone = $false
  $script:_dlError = $null

  $progressSub = Register-ObjectEvent -InputObject $wc -EventName DownloadProgressChanged -Action {
    $script:_dlPct = $Event.SourceEventArgs.ProgressPercentage
  }
  $completeSub = Register-ObjectEvent -InputObject $wc -EventName DownloadFileCompleted -Action {
    if ($Event.SourceEventArgs.Error) { $script:_dlError = $Event.SourceEventArgs.Error }
    $script:_dlDone = $true
  }

  try {
    $wc.DownloadFileAsync([Uri]$Url, $OutFile)
    $frame = 0
    $word = RandomWord
    while (-not $script:_dlDone) {
      $pct = [Math]::Max(0, [Math]::Min(100, $script:_dlPct))
      $filled = [Math]::Round($width * $pct / 100)
      $bar = ("█" * $filled) + ("░" * ($width - $filled))
      $bot = $Robot[$frame % $Robot.Count]
      Write-Host -NoNewline ("`r  $(Rgb $Gradient[0] $bot)  $Label — $word  [$(GradientText $bar)] {0,3}%   " -f $pct)
      Start-Sleep -Milliseconds 100
      $frame++
    }
    if ($script:_dlError) { throw $script:_dlError }
    $bar = "█" * $width
    Write-Host ("`r  $(Rgb @(120,255,150) '✓')  $Label  [$(GradientText $bar)] 100%   ")
  }
  finally {
    Unregister-Event -SourceIdentifier $progressSub.Name -ErrorAction SilentlyContinue
    Unregister-Event -SourceIdentifier $completeSub.Name -ErrorAction SilentlyContinue
    Remove-Job -Name $progressSub.Name -ErrorAction SilentlyContinue
    Remove-Job -Name $completeSub.Name -ErrorAction SilentlyContinue
    $wc.Dispose()
  }
}

function Ensure-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Step-Fail $Name "not found. $Hint"
    exit 1
  }
}

# ── start ─────────────────────────────────────────────────────────────────

Write-Banner
Write-Host "  $(Rgb $Gradient[0] $Robot[0])  Omi: let's get you set up. $(RandomWord) the installer..."
Write-Host ""

try {
  Ensure-Command "node" "Install Node.js 20+ from https://nodejs.org, then re-run this installer."
  $nodeMajor = [int]((& node -e "console.log(process.versions.node.split('.')[0])").Trim())
  if ($nodeMajor -lt 20) {
    Step-Fail "Node version" "found Node $((& node -v).Trim()), need 20+. Install from https://nodejs.org"
    exit 1
  }

  Step-Start "Checking the latest version"
  $pkgUrl = "https://raw.githubusercontent.com/$RepoOwner/$RepoName/$Branch/package.json"
  $latest = (Invoke-RestMethod -Uri $pkgUrl -Headers @{ "User-Agent" = "omni-installer" }).version
  Step-Done "Checking the latest version" "v$latest"

  $existingPkg = Join-Path $InstallDir "package.json"
  $currentVersion = $null
  if (Test-Path $existingPkg) {
    try { $currentVersion = (Get-Content $existingPkg -Raw | ConvertFrom-Json).version } catch {}
  }

  if ($currentVersion -eq $latest -and -not $Force) {
    Write-Host ""
    Write-Host "  $(Rgb @(120,255,150) $RobotHappy)  Omi: already on v$latest — nothing to do. Use -Force to reinstall anyway."
  }
  else {
    if ($currentVersion) {
      Write-Host "  $(Rgb $Gradient[2] '↻')  Updating v$currentVersion -> v$latest in $InstallDir"
    }
    else {
      Write-Host "  $(Rgb $Gradient[2] '+')  Installing v$latest to $InstallDir"
    }
    Write-Host ""

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("omni-install-" + [guid]::NewGuid().ToString("N"))
    $zipPath = Join-Path $tempRoot "omni.zip"
    $extractPath = Join-Path $tempRoot "extract"
    New-Item -ItemType Directory -Path $extractPath -Force | Out-Null

    try {
      $zipUrl = "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/$Branch.zip"
      Get-FileWithBar -Url $zipUrl -OutFile $zipPath -Label "Downloading Omni"

      Step-Start "Extracting archive"
      Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
      $repoFolder = Get-ChildItem -Path $extractPath -Directory | Select-Object -First 1
      if (-not $repoFolder) { throw "archive extracted empty" }
      Step-Done "Extracting archive"

      Step-Start "Installing files"
      New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
      # Never touch a user's own secrets or local state on an update.
      $excludeDirs = @(".git", "agent", "node_modules", "dist", "site\downloads")
      $excludeFiles = @(".env", ".env.local")
      robocopy $repoFolder.FullName $InstallDir /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP /XD $excludeDirs /XF $excludeFiles | Out-Null
      if ($LASTEXITCODE -gt 7) { throw "robocopy failed with exit code $LASTEXITCODE" }
      Step-Done "Installing files"
    }
    finally {
      if (Test-Path $tempRoot) { Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }

    Push-Location $InstallDir
    try {
      # Templates only — never fabricate or fetch real keys.
      Step-Start "Placing config templates"
      if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
        Copy-Item ".env.example" ".env"
      }
      Step-Done "Placing config templates" ".env.example -> .env, settings.example.json kept as-is"

      Write-Host ""
      Write-Host "  $(Rgb $Gradient[1] '▸')  Running project setup:"
      & node ./scripts/setup.mjs
      if ($LASTEXITCODE -ne 0) { throw "scripts/setup.mjs exited with code $LASTEXITCODE" }
      Write-Host ""

      Step-Start "Linking the omni command globally"
      $linkOutput = & npm link 2>&1
      if ($LASTEXITCODE -ne 0) {
        Step-Fail "Linking the omni command globally" "$linkOutput"
        Write-Host "  $(Rgb @(140,140,140) 'You can link it yourself later with: npm link (run from ' + $InstallDir + ')')"
      }
      else {
        Step-Done "Linking the omni command globally"
      }
    }
    finally {
      Pop-Location
    }

    Write-Host ""
    Write-Host "  $(Rgb @(120,255,150) $RobotHappy)  Omi: nailed it. Omni v$latest is ready."
  }

  Write-Host ""
  Write-Host "  $(GradientText 'Next steps:')"
  Write-Host "    1. cd into any project folder"
  Write-Host "    2. Set a provider key: " -NoNewline; Write-Host "omni --set-key nvidia nvapi-xxxx" -ForegroundColor Cyan
  Write-Host "       (free key: https://build.nvidia.com — or edit $InstallDir\.env)"
  Write-Host "    3. Run: " -NoNewline; Write-Host "omni" -ForegroundColor Cyan
  Write-Host ""
}
catch {
  Write-Host ""
  Write-Host "  $(Rgb @(255,90,90) $RobotSad)  Omi: install failed — $($_.Exception.Message)"
  exit 1
}
