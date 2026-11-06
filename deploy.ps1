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
#   .\deploy.ps1 -PushOnly             # push what is already committed (hook)

param(
  [string]$Message = "",
  [switch]$NoPush,
  [switch]$PushOnly
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

$env:GIT_TERMINAL_PROMPT = '0'

if ($PushOnly) {
  for ($i = 1; $i -le 3; $i++) {
    & $git push origin main
    if ($LASTEXITCODE -eq 0) { exit 0 }
    Start-Sleep -Seconds 2
  }
  exit 1
}

$status = & $git status --porcelain
if (-not $status) {
  Write-Host "nothing to commit; pushing current state"
} else {
  & $git add -A
  if (-not $Message) { $Message = "deploy: " + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
  & $git commit -m $Message | Out-Host
}

if ($NoPush) {
  Write-Host "push skipped (-NoPush)"
  exit 0
}

for ($i = 1; $i -le 3; $i++) {
  & $git push origin main
  if ($LASTEXITCODE -eq 0) { Write-Host "deployed"; exit 0 }
  Start-Sleep -Seconds 2
}
throw "push failed after 3 attempts, the commit is kept locally; check credentials"
