param(
  [string]$WorkerUrl,
  [string]$ConfigPath,
  [string]$Database,
  [int]$ExpectedNodes,
  [double]$SinceHours,
  [switch]$Json,
  [string]$FixtureDir
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeScript = Join-Path $scriptDir "wanoku-audit-environment.mjs"
$argsList = @($nodeScript)

if ($WorkerUrl) {
  $argsList += @("--worker-url", $WorkerUrl)
}
if ($ConfigPath) {
  $argsList += @("--config", $ConfigPath)
}
if ($Database) {
  $argsList += @("--database", $Database)
}
if ($PSBoundParameters.ContainsKey("ExpectedNodes")) {
  $argsList += @("--expected-nodes", [string]$ExpectedNodes)
}
if ($PSBoundParameters.ContainsKey("SinceHours")) {
  $argsList += @("--since-hours", [string]$SinceHours)
}
if ($Json) {
  $argsList += "--json"
}
if ($FixtureDir) {
  $argsList += @("--fixture-dir", $FixtureDir)
}

& node @argsList
exit $LASTEXITCODE
