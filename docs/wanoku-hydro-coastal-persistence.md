# Wanoku Hydro-Coastal Persistence Spine v1

## Purpose

Hydro-Coastal Persistence Spine v1 stores normalized `HydroCoastalObservation` records in Cloudflare D1 without losing identity, revision, forecast-vintage, or as-of semantics.

This phase adds only migration, repository code, tests, and documentation. It is not connected to Worker routes, scheduled collection, external acquisition, D1 production migration, PWA UI, or fish-species scoring.

## Why this is separate from environmental snapshots

Hydro-coastal data has different domain semantics from `environmental_snapshots`.

- Tide, river, and wave observations are station-based.
- Forecast vintage is part of the identity.
- Later revisions for the same physical target time must coexist.
- Vertical datum and provenance are required for safe interpretation.

For that reason, hydro-coastal observations are stored in dedicated tables and are not mixed into `environmental_snapshots`.

## D1 tables

### `hydro_coastal_source_runs`

One row represents one caller-supplied ingestion or parser run.

Important columns:

- `id`: caller-supplied run id.
- `provider_id`: known hydro-coastal provider id.
- `requested_at`: caller-supplied canonical UTC timestamp.
- `completed_at`: caller-supplied canonical UTC timestamp or `NULL`.
- `status`: `ok`, `partial`, or `failed`.
- `raw_hash`: hash of the source material, not the raw payload itself.
- `parser_id`, `parser_version`, `source_format_version`: parser provenance.
- `normalized_schema_version`: expected to match `HYDRO_COASTAL_SCHEMA_VERSION`.
- `run_json`: stable canonical JSON for the source-run metadata.
- `created_at`: DB audit timestamp only.

`created_at` is not used for domain revision selection.

### `hydro_coastal_observations`

One row represents one normalized observation revision.

Important columns:

- `version_key`: unique key from `hydroCoastalObservationVersionKey()`.
- `identity_key`: logical identity from `hydroCoastalObservationIdentityKey()`.
- `source_run_id`: foreign key to `hydro_coastal_source_runs.id`.
- `provider_id`, `station_id`, `metric`.
- `observed_at`: target observation or forecast time.
- `collected_at`: time Wanoku obtained or normalized this revision.
- `forecast_issued_at`: forecast vintage when present.
- `value`, `unit`, `status`, `provisional`.
- `vertical_datum_json`: canonical JSON copy of the datum object.
- `normalized_json`: canonical JSON for the full `HydroCoastalObservation`.
- `created_at`: DB audit timestamp only.

Raw provider payloads are not stored.

## Identity, version, and revisions

`identity_key` is:

```text
providerId | stationId | metric | observedAt | forecastIssuedAt
```

`version_key` is:

```text
identity_key | collectedAt
```

The same identity with a different `collectedAt` is a revision and is preserved. It is not a conflict.

The same `version_key` with identical canonical `normalized_json` is an exact duplicate. It is skipped with a warning.

The same `version_key` with different canonical `normalized_json` is a conflict. The repository does not overwrite the existing row and does not hide the conflict with `OR IGNORE`.

## Source run semantics

`sourceRun.id` is caller-supplied. The repository does not generate timestamps or ids from current time.

- `ok`: if any invalid or conflicting observation exists, the run and observations are not written.
- `partial`: valid, non-conflicting observations may be written; rejected observations remain visible in errors.
- `failed`: may be written only with zero observations.

If a source run id already exists:

- identical `run_json`: duplicate warning, not a conflict.
- different `run_json`: source-run conflict; observations are not written.

`OR REPLACE` is not used.

## Atomic write unit

Writes use Cloudflare D1 `db.batch()` as the atomic unit.

One write attempt contains:

- source-run `INSERT` when the source run is new.
- chunked observation `INSERT` statements for new observations.

The repository uses plain `INSERT`. It does not use `INSERT OR REPLACE` or `INSERT OR IGNORE`.

If `db.batch()` is unavailable, the repository returns an explicit error and does not fall back to non-atomic writes. A source run is not committed before observations, and observations are not committed without their source run in the same write attempt.

Each SQL statement remains under the 90 bound-parameter budget.

## Race classification and retry

If an atomic batch fails, the repository assumes the attempt was rolled back and re-reads the relevant source-run id and observation version keys.

Source-run race:

- same `run_json`: exact duplicate source run; warning only.
- different `run_json`: source-run conflict; write stops.
- still missing after retry attempts: classification error.

Observation race:

- same `version_key` and same canonical `normalized_json`: exact duplicate.
- same `version_key` and different canonical `normalized_json`: conflict.
- missing after re-read: still pending and eligible for the next retry attempt.

Retries are finite: at most 3 write attempts.

`insertedCount`, `duplicateCount`, and `conflictCount` are mutually exclusive for each observation `version_key` classified during DB write/race handling. Input-level exact duplicate rows are counted separately as ignored duplicate input rows.

For `status=ok`, any conflict or unclassified race leaves no source run or observations from that call. For `status=partial`, non-conflicting pending rows can be retried and saved atomically after conflicting rows are excluded.

`partial` in the write result follows `sourceRun.status=partial`; a clean partial run can return `ok=true` and `partial=true`, while a partial run with rejected or conflicting rows returns `ok=false` and `partial=true`.

## Canonical JSON

`run_json`, `vertical_datum_json`, and `normalized_json` use stable canonical JSON:

- object keys are sorted.
- array order is preserved.
- `undefined` object properties are omitted.
- array `undefined` entries are stored as `null`.
- `null` is preserved.
- top-level `undefined`, functions, symbols, bigint values, and non-finite numbers (`NaN`, `Infinity`, `-Infinity`) are rejected.

This makes duplicate/conflict classification independent of JavaScript object property order.

On hydration, `normalized_json` is parsed, validated, re-canonicalized, and compared with the stored text. A row whose `normalized_json` is valid JSON but not canonical is excluded with `normalized_json is not canonical`.

## History query

`readHydroCoastalHistory()` returns all matching revisions. It does not perform as-of selection.

Supported filters:

- `providerId`
- `stationId`
- `metric`
- `observedStart` inclusive
- `observedEnd` exclusive
- `collectedStart` inclusive
- `collectedEnd` exclusive
- `forecastIssuedAt`
- `limit`

Timestamps must be canonical UTC ISO. Invalid queries are rejected before SQL execution. All filters use parameter binding.

## As-of query

`readHydroCoastalObservationsAsOf()` returns the latest eligible revision per identity.

Rules:

- `collected_at <= calculatedAt`
- `observed_at` in `[observedStart, observedEnd)`
- forecast vintage is included in the identity and is not mixed.
- latest revision is selected by `collected_at`, then `version_key` for deterministic tie-breaking.
- `created_at` is not used.
- limit is applied after latest-per-identity selection.

The repository behavior is tested against core `selectHydroCoastalObservationsAsOf()` semantics.

## Corrupt row handling

Read operations hydrate `normalized_json` back to `HydroCoastalObservation` and validate it.

Rows are excluded if:

- `normalized_json` is malformed.
- validation fails.
- DB columns do not match canonical keys or JSON fields.

A corrupt row does not prevent healthy rows from being returned. Errors are reported to the caller. DB columns are not used to overwrite normalized JSON, and `created_at` is never used as a fallback for `collectedAt`.

## Bound parameter and D1 safety

The repository chunks lookups and inserts so each statement stays at or below 90 bound parameters.

It does not create invalid `IN ()` queries or empty `VALUES` inserts.

SQL table and column names are code constants. User filters are parameter-bound.

## Current integration status

The repository can feed Hydro-Coastal Feature Bridge by reading as-of observations and passing them to `buildHydroCoastalFeatureSet()`.

Not connected yet:

- Worker route
- scheduled collection
- external fetch/download
- remote D1 migration
- PWA UI
- fish scoring

Remote migration has not been applied by this documentation.
