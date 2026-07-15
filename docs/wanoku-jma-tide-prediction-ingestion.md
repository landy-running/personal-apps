# Wanoku JMA Tide Prediction Ingestion Orchestrator v1

Phase 3D-2A は、気象庁潮位表テキストデータ版の取得境界から、既存の固定長 parser と Hydro-Coastal Persistence Spine までを接続する純粋な ingestion 境界です。

現時点では Worker runtime、route、Cron、PWA、外部自動取得には接続していません。`workers/wanoku-intel-worker/src/index.js` からも import しません。

## Pipeline

`ingestJmaTidePredictionSource()` は、caller から渡された HTTPS `sourceUrl` を使い、次の順で処理します。

1. input validation
2. `fetchImpl(sourceUrl)`
3. `response.arrayBuffer()` による raw bytes 取得
4. decode 前 raw bytes の SHA-256 計算
5. `TextDecoder` による UTF-8 decode
6. `parseJmaTidePredictionFixedWidth()`
7. `writeHydroCoastalBatch()` による source run / observations 保存
8. structured result 返却

raw response body、decoded source text、`ArrayBuffer`、`Response` object、`Error` object は result や D1 に保存しません。

## Input contract

主な入力は以下です。

```js
{
  db,
  sourceUrl,
  sourceYear,
  forecastIssuedAt,
  sourceName?,
  attribution?,
  fetchImpl?,
  now?,
  runIdFactory?
}
```

- `sourceUrl`: HTTPS のみ。URL credential は拒否します。
- `sourceYear`: 現時点では `2026` のみ対応します。
- `forecastIssuedAt`: caller supplied canonical UTC ISO。fetch 時刻から推測しません。
- `now`: `requestedAt` と `completedAt` をテスト注入するための関数です。
- `db`: Hydro-Coastal Persistence Spine が使う D1 binding です。

入力validationに失敗した場合、DBへは書き込みません。

## Raw-byte SHA-256

`rawHash` は decode 前の exact source bytes から SHA-256 を計算します。

- lowercase hex 64文字
- decoded textから再計算しない
- bodyを複数回readしない
- raw body自体は保存しない

`sourceByteLength` は result へ返しますが、D1 schemaには追加していません。

## Timestamp semantics

- `requestedAt`: fetch開始前に `now()` から取得
- `completedAt`: body取得・hash計算後に `now()` から取得
- `collectedAt`: parserへ `completedAt` として渡す
- `normalizedAt`: parserへ `completedAt` として渡す
- `forecastIssuedAt`: input値をそのまま使用

すべて canonical UTC ISO を要求します。`completedAt < requestedAt` の場合はDBへ書き込みません。

## Run ID

default run id は決定的です。

```text
jma-tide-prediction:<sourceYear>:<requestedAt>:<rawHash-prefix>
```

fetch 失敗など raw hash がない場合は `<rawHash-prefix>` に `nohash` を使います。`Math.random()` には依存しません。

## Status classification

source run status は次の規則で決まります。

- `ok`
  - fetch成功
  - HTTP 2xx
  - decode成功
  - parser errorsなし
  - observations 1件以上
- `partial`
  - parser errorsあり
  - ただし valid observations 1件以上
  - valid observations のみ repository へ渡す
- `failed`
  - fetch失敗
  - HTTP non-2xx
  - body read失敗
  - empty body
  - decode失敗
  - parser throw
  - observations 0件

parser warningのみでは `partial` にしません。

## Failed source run persistence

fetch失敗、HTTP error、decode error、parse failure なども、可能な限り `hydro_coastal_source_runs` へ `failed` source run として保存します。

理由:

- 取得失敗の監査履歴を残す
- raw payloadを保存せずに、`requestedAt` / `completedAt` / HTTP status / rawHash などを追跡する
- 同じ取得試行の重複や衝突を Persistence Spine 側で分類できるようにする

failed run では observations は常に空です。

## Parser connection

既存の以下を再利用します。

- `parseJmaTidePredictionFixedWidth()`
- `getJmaTidePredictionProviderDefinition()`
- `JMA_TIDE_PREDICTION_STATIONS_2026`

parserへ渡す主要context:

- `sourceYear`
- `collectedAt = completedAt`
- `normalizedAt = completedAt`
- `forecastIssuedAt = input.forecastIssuedAt`
- `sourceUrl`
- `sourceName`
- `attribution`

2026年用station fixtureのみが存在するため、別年の自動流用はしません。

## Repository connection

保存は `writeHydroCoastalBatch(db, { sourceRun, observations })` のみに委譲します。

Ingestion layerでは以下を再実装しません。

- D1 INSERT
- atomic batch
- duplicate / conflict classification
- race handling
- revision/as-of semantics

persistence result は隠さず result の `persistence` に保持します。persistence が失敗した場合、ingestion result は `ok=false` になり、`persistence_error` を返します。

## Return contract

result は常に structured object です。

```js
{
  ok,
  partial,
  status,
  sourceRunId,
  sourceUrl,
  sourceYear,
  requestedAt,
  completedAt,
  forecastIssuedAt,
  httpStatus,
  rawHash,
  sourceByteLength,
  parsedObservationCount,
  parserErrorCount,
  parserWarningCount,
  persistence,
  errors,
  warnings
}
```

`ok` は `status === "ok"` かつ `persistence.ok === true` かつ ingestion errors がない場合のみ `true` です。`partial` は保存が成立しても `ok=false` として扱います。

## Error codes

主な machine-readable error code:

- `invalid_input`
- `fetch_error`
- `http_error`
- `body_read_error`
- `empty_body`
- `decode_error`
- `parse_failed`
- `no_observations`
- `persistence_error`

外部由来の `Error.message` はそのまま返さず、詳細な例外objectも保持しません。

## Audit hardening notes

Phase 3D-2A の監査修正後は、外部dependencyの不正動作でも `ingestJmaTidePredictionSource()` が原則rejectせず、structured resultを返します。

### Parser result validation

`parseImpl()` の戻り値はそのまま信用しません。

- non-null object であること
- `observations` が array であること
- `errors` が array であること
- `warnings` が array であること

上記を満たさない場合は `status=failed`、`errorCode=parse_failed`、observations 0件として failed source run を保存します。parser function 自体が throw した場合も同じく structured result を返します。

`sourceFormatVersion` は non-empty string の場合のみ採用します。不正な場合は既定の JMA tide prediction source format version へfallbackし、warningを返します。

### Parser diagnostic redaction

parser の `errors` / `warnings` は専用sanitizeを通します。

- string のみ構造化diagnosticとして扱う
- non-string要素は generic diagnostic へ変換する
- CR/LF/control characters を正規化する
- fixed-width field値など引用された断片は `[redacted]` に置換する
- raw line全体やdecoded source text全体は返さない

例:

```text
line 1 hour 0: invalid hourly tide level field "A1X".
```

は以下のように返します。

```text
line 1 hour 0: invalid hourly tide level field "[redacted]".
```

### HTTP status precedence

HTTP判定は `response.status` をsource of truthにします。

- status は integer かつ `100..599`
- success は `200..299`
- `response.ok` が存在しても、status と矛盾する場合は status を優先し warning を返す

HTTP non-2xx では parser を呼びません。body readとraw hashはbest effortで行いますが、body read失敗やhash失敗があっても primary errorCode は `http_error` のままです。

### Body validation

`response.arrayBuffer()` の戻り値は正しい `ArrayBuffer` である必要があります。`null`、`undefined`、string、plain object などは `body_read_error` として扱い、empty bodyへ黙って変換しません。

HTTP non-2xx時はbody read失敗をwarningとして保持し、primary errorは `http_error` にします。

### D1 binding validation

`db` は事前に以下を満たす必要があります。

- `prepare` function
- `batch` function

どちらかが欠ける場合は `invalid_input` として fetch / parser / persistence を呼びません。

### Persistence boundary

通常は既存の `writeHydroCoastalBatch()` だけを使います。テスト用dependency injection seamとして `persistenceImpl` を渡せますが、production defaultは既存repositoryです。

repository が structured failure を返した場合:

- `persistence` result をそのまま保持
- `persistence_error` を追加
- ingestion result は `ok=false`

repository が throw / reject した場合:

- ingestion function は reject しない
- `persistence=null`
- `persistence_error` を追加
- `Error.message` / stack / Error object は返さない

### BOM handling

UTF-8 decodeでは先頭BOMを明示的に検出し、1回だけ削除します。BOMを削除した場合は `decode_bom` warning を返します。BOMがfixed-width line lengthを壊さないよう、parserへ渡す前に処理します。

### Structured result guarantee

以下のようなdependency failureでも、原則として functionはrejectせずstructured resultを返します。

- parser throw
- parser returns malformed result
- parser diagnostics contain non-string values
- persistence throw
- invalid response shape
- invalid `arrayBuffer()` result
- invalid `now()`
- `runIdFactory` throw

resultには以下を含めません。

- raw source body
- decoded source text
- `ArrayBuffer`
- `Response`
- `Error` object
- stack trace
- credential

## Not connected yet

このPhaseでは以下は未接続です。

- Worker route
- scheduled handler / Cron
- production source download policy
- remote D1 migration
- PWA UI
- Feature Bridge自動実行
- fish model / ranking

次の接続フェーズで Worker route や admin endpoint を追加する場合も、secret、raw payload、remote D1操作の扱いを別途監査してください。
