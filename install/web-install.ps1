# Omni public installer shim — deployed as:
#
#   https://omni.globalwarningnetworks.com/install.ps1
#   irm https://omni.globalwarningnetworks.com/install.ps1 | iex
#
# This file exists only to hand off to install/install.ps1 on GitHub, which is
# the real installer and the single source of truth. Keeping the deployed copy
# this thin is the whole point: installer behaviour changes ship with a git
# push, and the website never needs redeploying. Deploy this once and leave it.
#
# Change it only to repoint the owner/repo/branch below.

$ErrorActionPreference = "Stop"

$RepoOwner = "tattooinmtl"
$RepoName = "omni"
$Branch = "main"

$src = "https://raw.githubusercontent.com/$RepoOwner/$RepoName/$Branch/install/install.ps1"
Write-Host "[Omni Installer] Fetching installer from $RepoOwner/$RepoName@$Branch"

try {
  $script = Invoke-RestMethod -Uri $src -Headers @{ "User-Agent" = "omni-installer" }
}
catch {
  Write-Host "[Omni Installer] ERROR: could not fetch the installer from GitHub — $($_.Exception.Message)"
  exit 1
}

# Forward any arguments through, so `iex "& { $(irm ...) } -Force"` still works.
& ([ScriptBlock]::Create($script)) -RepoOwner $RepoOwner -RepoName $RepoName -Branch $Branch @args
