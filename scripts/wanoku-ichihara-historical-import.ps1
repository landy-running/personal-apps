param(
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$backfillDir = Join-Path $repoRoot ".tmp\wanoku-ichihara-backfill-live"
$manifestPath = Join-Path $backfillDir "manifest.json"
$configPath = Join-Path $repoRoot "workers\wanoku-intel-worker\wrangler.toml"
$database = "wanoku-intel-db"
$facilityId = "ichihara-original-maker"
$providerId = "ichihara-umizuri"
$expectedMonths = @(
  "2025-09", "2025-10", "2025-11", "2025-12",
  "2026-01", "2026-02", "2026-03", "2026-04",
  "2026-05", "2026-06", "2026-07", "2026-08"
)
$script:PreImportBookmark = $null
$script:BookmarkPath = $null

function Show-BookmarkOnFailure {
  if ($script:PreImportBookmark) {
    Write-Host "Pre-import Time Travel bookmark: $($script:PreImportBookmark)"
    Write-Host "Bookmark record: $($script:BookmarkPath)"
    Write-Host "No automatic restore or cleanup was attempted."
  }
}

function Assert-Equal($Actual, $Expected, [string]$Label) {
  if ([string]$Actual -ne [string]$Expected) {
    Show-BookmarkOnFailure
    throw "$Label expected '$Expected', found '$Actual'."
  }
}

function Invoke-D1Row([string]$Sql) {
  $output = & npx wrangler d1 execute $database --remote --config $configPath --command $Sql --json
  if ($LASTEXITCODE -ne 0) {
    Show-BookmarkOnFailure
    $details = ($output -join " ").Trim()
    if ($details.Length -gt 1200) { $details = $details.Substring(0, 1200) }
    throw "Remote read-only D1 query failed with exit code $LASTEXITCODE. $details"
  }
  $payload = ($output -join "`n") | ConvertFrom-Json
  if ($null -eq $payload -or $null -eq $payload[0].results -or $payload[0].results.Count -ne 1) {
    Show-BookmarkOnFailure
    throw "Remote D1 query returned an unexpected JSON shape."
  }
  return $payload[0].results[0]
}

if ((Resolve-Path $repoRoot).Path -ne (Get-Location).Path) {
  Set-Location $repoRoot
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Frozen manifest is missing: $manifestPath" }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Wrangler config is missing: $configPath" }
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { throw "npx is unavailable." }

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
Assert-Equal $manifest.schemaVersion "wanoku-ichihara-fixed-node-backfill.v1" "Manifest schemaVersion"
Assert-Equal $manifest.requestedRange.startDate "2025-09-01" "Manifest start date"
Assert-Equal $manifest.requestedRange.endDate "2026-08-19" "Manifest end date"
Assert-Equal $manifest.artifactCounts.archive 16 "Archive artifact count"
Assert-Equal $manifest.artifactCounts.detail 312 "Detail artifact count"
Assert-Equal $manifest.artifactCounts.robots 1 "Robots artifact count"
Assert-Equal $manifest.artifactCounts.total 329 "Total artifact count"
Assert-Equal $manifest.reportCount 312 "Historical report count"
Assert-Equal $manifest.speciesCount 2496 "Historical species count"
Assert-Equal $manifest.sourceRunCount 12 "Historical source-run count"
Assert-Equal $manifest.rawArtifactAggregateSha256 "87143b1deb720f2a6a077e6b80c42f46b55bc0990fa6e5e0adc3c2c34d7f1fa5" "Raw artifact aggregate hash"
Assert-Equal $manifest.normalizedDatasetSha256 "3865af97bd236e6de1b404af8e332cbcd673d39226857e29209f3c7c2a48407d" "Normalized dataset hash"
Assert-Equal $manifest.validation.logical.ok $true "Logical validation"
Assert-Equal $manifest.validation.localD1.ok $true "Local D1 validation"
Assert-Equal $manifest.validation.localD1.replayedImportFileCount 12 "Local D1 replay count"
Assert-Equal @($manifest.unresolvedRecords).Count 0 "Unresolved record count"
Assert-Equal @($manifest.monthFiles).Count 12 "Import file count"

$importFiles = @()
foreach ($month in $expectedMonths) {
  $entries = @($manifest.monthFiles | Where-Object { $_.sourceMonth -eq $month })
  Assert-Equal $entries.Count 1 "Manifest entry count for $month"
  $entry = $entries[0]
  $expectedName = "import-$month.sql"
  Assert-Equal $entry.file $expectedName "Import filename for $month"
  $filePath = Join-Path $backfillDir $entry.file
  if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { throw "Import file is missing: $filePath" }
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash.ToLowerInvariant()
  Assert-Equal $actualHash $entry.sha256 "Import SHA-256 for $month"
  $sql = Get-Content -Raw -LiteralPath $filePath
  if ($sql -match '(?im)^\s*(?:DELETE|UPDATE|DROP|ALTER|CREATE|REPLACE|PRAGMA|VACUUM|ATTACH|DETACH)\b' -or $sql -match '(?i)INSERT\s+OR\s+(?:IGNORE|REPLACE)') {
    throw "Import file contains a forbidden SQL operation: $expectedName"
  }
  $sourceIndex = $sql.IndexOf("INSERT INTO source_runs")
  $reportIndex = $sql.IndexOf("INSERT INTO fixed_node_daily_reports")
  $speciesIndex = $sql.IndexOf("INSERT INTO fixed_node_species_observations")
  if ($sourceIndex -lt 0 -or $reportIndex -le $sourceIndex -or $speciesIndex -le $reportIndex) {
    throw "Import file is not in FK-safe order: $expectedName"
  }
  $insertCount = [regex]::Matches($sql, '(?im)^INSERT INTO ').Count
  $exactRetryCount = [regex]::Matches($sql, '(?i)WHERE NOT EXISTS \(SELECT 1 FROM ').Count
  Assert-Equal $exactRetryCount $insertCount "Exact-retry guard count for $month"
  if ($sql.Contains("2026-08-20") -or $sql.Contains("fishing:29031")) {
    throw "Import file overlaps the production canary: $expectedName"
  }
  $importFiles += $filePath
}

$wranglerLogDir = Join-Path $backfillDir "wrangler-logs"
New-Item -ItemType Directory -Force -Path $wranglerLogDir | Out-Null
$env:WRANGLER_LOG_PATH = $wranglerLogDir

$baselineSql = "SELECT (SELECT COUNT(*) FROM fixed_node_daily_reports WHERE facility_id = '$facilityId') AS reports, (SELECT COUNT(*) FROM fixed_node_species_observations WHERE facility_id = '$facilityId') AS species, (SELECT MAX(observation_date) FROM fixed_node_daily_reports WHERE facility_id = '$facilityId') AS latest_date, (SELECT COUNT(*) FROM fixed_node_daily_reports WHERE facility_id = '$facilityId' AND observation_date = '2026-08-20' AND source_record_id = 'fishing:29031') AS canary_count;"
$baseline = Invoke-D1Row $baselineSql
Assert-Equal $baseline.reports 1 "Pre-import Ichihara reports"
Assert-Equal $baseline.species 8 "Pre-import Ichihara species"
Assert-Equal $baseline.latest_date "2026-08-20" "Pre-import latest date"
Assert-Equal $baseline.canary_count 1 "Pre-import canary count"

if (-not $Execute) {
  [ordered]@{
    schemaVersion = "wanoku-ichihara-historical-import.v1"
    mode = "READ_ONLY_PREFLIGHT"
    manifest = "PASS"
    sqlFiles = 12
    productionBaseline = "PASS"
    reports = [int]$baseline.reports
    species = [int]$baseline.species
    latestDate = $baseline.latest_date
    remoteWrites = 0
    status = "PASS"
  } | ConvertTo-Json
  exit 0
}

$bookmarkOutput = & npx wrangler d1 time-travel info $database --config $configPath --json
if ($LASTEXITCODE -ne 0) {
  $details = ($bookmarkOutput -join " ").Trim()
  if ($details.Length -gt 1200) { $details = $details.Substring(0, 1200) }
  throw "Unable to obtain the pre-import Time Travel bookmark. $details"
}
$bookmarkResult = ($bookmarkOutput -join "`n") | ConvertFrom-Json
if (-not $bookmarkResult.bookmark) { throw "Time Travel did not return a bookmark." }
$script:PreImportBookmark = [string]$bookmarkResult.bookmark
$bookmarkTimestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$script:BookmarkPath = Join-Path $backfillDir "pre-import-bookmark-$bookmarkTimestamp.json"
$bookmarkRecord = [ordered]@{
  schemaVersion = "wanoku-ichihara-historical-import-bookmark.v1"
  database = $database
  capturedAt = [DateTime]::UtcNow.ToString("o")
  bookmark = $script:PreImportBookmark
  baseline = $baseline
  rawArtifactAggregateSha256 = $manifest.rawArtifactAggregateSha256
  normalizedDatasetSha256 = $manifest.normalizedDatasetSha256
}
$bookmarkTemp = "$($script:BookmarkPath).tmp-$PID"
$bookmarkRecord | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $bookmarkTemp -Encoding UTF8
Move-Item -Force -LiteralPath $bookmarkTemp -Destination $script:BookmarkPath
Write-Host "Pre-import Time Travel bookmark: $($script:PreImportBookmark)"
Write-Host "Bookmark record: $($script:BookmarkPath)"

$completedMonths = 0
foreach ($filePath in $importFiles) {
  Write-Host "Importing $(Split-Path -Leaf $filePath)..."
  & npx wrangler d1 execute $database --remote --file $filePath --config $configPath --yes
  if ($LASTEXITCODE -ne 0) {
    Show-BookmarkOnFailure
    Write-Host "Completed month files before failure: $completedMonths"
    exit $LASTEXITCODE
  }
  $completedMonths += 1
}

$postSql = "SELECT (SELECT COUNT(*) FROM fixed_node_daily_reports WHERE facility_id = '$facilityId') AS reports, (SELECT COUNT(*) FROM fixed_node_species_observations WHERE facility_id = '$facilityId') AS species, (SELECT COUNT(*) FROM fixed_node_daily_reports WHERE facility_id = '$facilityId' AND observation_date <= '2026-08-19') AS historical_reports, (SELECT MAX(observation_date) FROM fixed_node_daily_reports WHERE facility_id = '$facilityId' AND observation_date <= '2026-08-19') AS historical_max_date, (SELECT MAX(observation_date) FROM fixed_node_daily_reports WHERE facility_id = '$facilityId') AS overall_max_date, (SELECT COUNT(*) FROM fixed_node_daily_reports WHERE facility_id = '$facilityId' AND observation_date = '2026-08-20' AND source_record_id = 'fishing:29031') AS canary_count, (SELECT COUNT(*) FROM fixed_node_species_observations s LEFT JOIN fixed_node_daily_reports r ON r.report_id = s.report_id WHERE s.facility_id = '$facilityId' AND r.report_id IS NULL) AS orphan_species, (SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreign_key_violations, (SELECT COUNT(*) FROM (SELECT identity_key, semantic_hash FROM fixed_node_daily_reports WHERE facility_id = '$facilityId' GROUP BY identity_key, semantic_hash HAVING COUNT(*) > 1)) AS duplicate_semantic_reports, (SELECT COUNT(*) FROM (SELECT report_id FROM fixed_node_species_observations WHERE facility_id = '$facilityId' GROUP BY report_id HAVING COUNT(*) != 8 OR COUNT(DISTINCT species_id) != 8)) AS bad_species_bundles, (SELECT COUNT(*) FROM fixed_node_species_observations WHERE facility_id = '$facilityId' AND species_id = 'sardine' AND source_labels_json LIKE '%カタボシイワシ%') AS kataboshi_leaks, (SELECT COUNT(*) FROM source_runs WHERE provider = '$providerId' AND id LIKE 'wanoku-fixed-node-ichihara-backfill:%') AS historical_source_runs;"
$post = Invoke-D1Row $postSql
Assert-Equal $post.reports 313 "Post-import Ichihara reports"
Assert-Equal $post.species 2504 "Post-import Ichihara species"
Assert-Equal $post.historical_reports 312 "Post-import historical reports"
Assert-Equal $post.historical_max_date "2026-08-19" "Post-import historical max date"
Assert-Equal $post.overall_max_date "2026-08-20" "Post-import overall max date"
Assert-Equal $post.canary_count 1 "Post-import canary count"
Assert-Equal $post.orphan_species 0 "Post-import orphan species"
Assert-Equal $post.foreign_key_violations 0 "Post-import FK violations"
Assert-Equal $post.duplicate_semantic_reports 0 "Post-import duplicate semantic reports"
Assert-Equal $post.bad_species_bundles 0 "Post-import bad species bundles"
Assert-Equal $post.kataboshi_leaks 0 "Post-import kataboshi leaks"
Assert-Equal $post.historical_source_runs 12 "Post-import historical source runs"

[ordered]@{
  schemaVersion = "wanoku-ichihara-historical-import.v1"
  mode = "EXECUTE"
  importedMonthFiles = $completedMonths
  preImportBookmark = $script:PreImportBookmark
  bookmarkRecord = $script:BookmarkPath
  reports = [int]$post.reports
  species = [int]$post.species
  status = "PASS"
} | ConvertTo-Json
