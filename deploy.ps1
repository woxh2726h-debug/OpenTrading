# Commit every local change and push it to GitHub.
#
# The Worker is built and deployed by Cloudflare Workers Builds on every push
# to `main` (see README, "Deploy to Cloudflare"), so this script is the deploy
# step for this folder. The same push is repeated by .git/hooks/post-commit,
# which means a plain `git commit` also deploys.
#
#   .\deploy.ps1                       # auto message with the current time
#   .\deploy.ps1 -Message "feat: ..."  # custom message
#   .\deploy.ps1 -NoPush               # commit only, no network

param(
  [string]$Message = "",
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo

$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) {
  $portable = Join-Path (Split-Path -Parent $repo) 'tools\git\cmd\git.exe'
  if (Test-Path $portable) { $git = $portable }
}
if (-not $git) { throw "git not found: install git or keep tools\git next to this folder" }

$branch = (& $git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { throw "current branch is '$branch', deploy expects 'main'" }

$status = & $git status --porcelain
if (-not $status) {
  Write-Host "nothing to deploy: working tree is clean"
  exit 0
}

& $git add -A
if (-not $Message) { $Message = "deploy: " + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
& $git commit -m $Message | Out-Host

if ($NoPush) {
  Write-Host "committed locally, push skipped (-NoPush)"
  exit 0
}

$env:GIT_TERMINAL_PROMPT = '0'
& $git push origin main
if ($LASTEXITCODE -ne 0) {
  throw "push failed (exit $LASTEXITCODE), the commit is kept locally; check credentials and retry"
}
Write-Host "deployed: $Message"
