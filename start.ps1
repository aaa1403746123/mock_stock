$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskCandidates = @(
  (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'),
  (Join-Path $env:LOCALAPPDATA 'nvm\v22.20.0')
)
$taskNode = Get-Command node -ErrorAction SilentlyContinue
if ($taskNode) {
  $taskVersion = & $taskNode.Source -p 'process.versions.node'
  if ([version]$taskVersion -lt [version]'22.13.0') { $taskNode = $null }
}
if (-not $taskNode) {
  foreach ($taskCandidate in $taskCandidates) {
    if (Test-Path -LiteralPath (Join-Path $taskCandidate 'node.exe')) {
      $taskVersion = & (Join-Path $taskCandidate 'node.exe') -p 'process.versions.node'
      if ([version]$taskVersion -ge [version]'22.13.0') {
        $env:Path = $taskCandidate + ';' + $env:Path
        $taskNode = Get-Command node
        break
      }
    }
  }
}
if (-not $taskNode) { throw 'Please install Node.js 22.13+ before starting MarketLab.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\concurrently\dist\bin\concurrently.js'))) { throw 'Dependencies are missing. Run npm install first.' }
Write-Host 'MarketLab: http://localhost:5173' -ForegroundColor Cyan
& $taskNode.Source node_modules/concurrently/dist/bin/concurrently.js -k -n server,web 'node --import tsx --watch server/index.ts' 'node node_modules/vite/bin/vite.js --host 127.0.0.1'
