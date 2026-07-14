# Wanoku Hydro-Coastal Data Contracts v1

## 責務

Hydro-Coastal Data Contracts v1 は、潮汐、潮位、河川、沿岸波浪などの公式データを、将来の provider adapter から安全かつ再現可能に受け取るための core 契約です。

今回の範囲は型、validation、identity/revision、as-of選択、stationとhabitat nodeの明示mapping、synthetic fixture です。外部APIアクセス、Web scraping、Worker endpoint、D1保存、魚種別予測、Feature Engineへの自動接続は実装しません。

## Observation

`HydroCoastalObservation` は、単一 station / metric / observedAt の正規化済み値です。

主な項目:

- `schemaVersion`
- `providerId`
- `stationId`
- `metric`
- `observedAt`
- `collectedAt`
- `forecastIssuedAt`
- `value`
- `unit`
- `status`
- `provisional`
- `verticalDatum`
- `provenance`

正規化後の `observedAt`、`collectedAt`、`forecastIssuedAt` は canonical UTC ISO (`YYYY-MM-DDTHH:mm:ss.sssZ`) です。JSTなどのsource側時刻は `provenance.sourceTimestamp` と `provenance.sourceTimezone` に保持できます。JSTをUTCとして誤解釈しません。

## Metric と Unit

metric:

- `predicted-tide-level`
- `observed-tide-level`
- `tide-anomaly`
- `river-stage`
- `river-discharge`
- `river-water-temperature`
- `significant-wave-height`
- `significant-wave-period`
- `wave-direction`
- `coastal-water-temperature`

unit:

- `cm`
- `m`
- `m3/s`
- `celsius`
- `second`
- `degree`

未知単位を `0` や空文字で表しません。metric/unit mismatch は validation error です。

## Station

`HydroCoastalStation` は provider 側の観測点または予報点です。

主な項目:

- `stationId`
- `providerId`
- `name`
- `latitude` / `longitude`
- `stationType`
- `supportedMetrics`
- `timezone`
- `active`
- `verticalDatum`
- `sourceMetadata`

station type:

- `tide-gauge`
- `river-gauge`
- `wave-buoy`
- `coastal-observation`
- `forecast-point`

位置は finite number かつ緯度経度範囲内で検証します。

## Provider

`HydroCoastalProviderDefinition` は provider の authority、accessMode、対応metric、時刻・datum意味論、実装状態を記録します。

`accessMode`:

- `manual-file`
- `documented-download`
- `licensed-distribution`
- `registry-only`

`implementationStatus`:

- `registry-only`
- `adapter-not-implemented`
- `manual-fixture-only`
- `parser-implemented`
- `implemented`

Phase 3Aでは、provider registry はあくまで契約と方針の宣言でした。Phase 3B-1では `jma-tide-prediction` の local fixed-width text parser のみ `parser-implemented` です。download、自動取得、Worker、D1、Cron連携は未実装です。

## Vertical Datum

水位系データでは基準面を明示します。

`VerticalDatum.type`:

- `tide-table-datum`
- `observation-datum`
- `tp`
- `local-river-datum`
- `mean-sea-level`
- `unknown`

規則:

- tide level と river stage には `verticalDatum` が必須です。
- `unknown` は許可しますが、比較・変換可能とは扱いません。
- datumが異なる水位を暗黙に比較、減算、平均しません。
- `offsetToTpM` が両方明確な場合だけ共通基準への変換・比較が可能です。
- `0` を unknown として使いません。

utility:

- `validateVerticalDatum`
- `canCompareVerticalDatums`
- `convertWaterLevelToTp`

## Identity / Revision / as-of

同じ物理的観測値と、後から取得したrevisionを分けます。

identity key:

- `providerId`
- `stationId`
- `metric`
- `observedAt`
- `forecastIssuedAt`

version key:

- identity key
- `collectedAt`

`selectHydroCoastalObservationsAsOf()`:

- `collectedAt <= calculatedAt` のrevisionだけを使用します。
- 同じidentityではas-of時点の最新 `collectedAt` を採用します。
- future revision は使用しません。
- 入力順序に依存しません。
- `calculatedAt` を内部生成しません。
- 同じversion keyで内容が完全一致する場合は exact duplicate として1件にまとめ、warningを返します。
- 同じversion keyで内容が異なる場合は conflict error とし、恣意的に片方を採用しません。

## Habitat Mapping

`HydroCoastalStationNodeMapping` は station と habitat node の関係を明示的に表します。

主な項目:

- `providerId`
- `stationId`
- `habitatNodeId`
- `mappingMethod`
- `distanceKm`
- `confidence`
- `validFrom`
- `validTo`
- `provenance`

`mappingMethod`:

- `explicit`
- `hydrological`
- `manual-reviewed`

規則:

- exact `providerId` + `stationId` で結合します。
- 座標nearest-neighborによる暗黙結合は禁止です。
- 複数nodeへのmappingは許可しますが、必ず明示します。
- `confidence` は根拠なしに設定せず、`null` を許可します。

utility:

- `mapHydroCoastalObservationsToHabitatNodes`
- `findUnmappedHydroCoastalStations`
- `findMappingsWithUnknownHabitatNode`

## Provenance

`HydroCoastalProvenance` には以下を保持できます。

- `sourceName`
- `sourceKind`
- `sourceUrl`
- `sourceTimestamp`
- `sourceTimezone`
- `normalizedAt`
- `parserId`
- `parserVersion`
- `sourceFormatVersion`
- `attribution`
- `notes`

source側の元時刻と正規化時刻を分離し、後からadapterの挙動を検証できるようにします。

## Synthetic Fixture

coreには最小synthetic fixtureを含めます。

- JMA tide prediction station
- JMA tide observation station
- NOWPHAS wave station
- MLIT river station

これらは契約テスト用のsynthetic fixtureです。実在観測値、実在予報値、実在station定義として扱いません。

## Feature Engine / 魚種モデルとは未接続

Hydro-Coastal Data Contracts v1 は Feature Engine へ自動接続しません。魚種別スコア、存在確率、ランキングにも使いません。

将来接続する場合も、datum、metric/unit、identity/revision、as-of選択、明示mappingを維持したまま別レイヤーで統合します。

## commit前最終仕様

### status / metric / time chronology

- `status=predicted` は `metric=predicted-tide-level` のみに許可します。
- `metric=predicted-tide-level` は `forecastIssuedAt` 必須です。
- predicted observation では `forecastIssuedAt <= collectedAt` かつ `forecastIssuedAt <= observedAt` を満たす必要があります。
- observed / reanalyzed observation では `observedAt <= collectedAt` を満たす必要があります。
- `status=missing` と `status=invalid` は `value=null` を要求します。
- 日時比較は canonical UTC ISO validation を通過した値にだけ行います。

### validator の入力境界

以下のvalidatorは provider adapter 由来の untrusted JSON を受け取る前提で、`null`、配列、欠落nested object、非string ID、`supportedMetrics=null` などでも throw せず `HydroCoastalValidationResult` を返します。

- `validateVerticalDatum`
- `validateHydroCoastalObservation`
- `validateHydroCoastalStation`
- `validateHydroCoastalProviderDefinition`
- `validateHydroCoastalStationNodeMapping`

### provider ID

`HydroCoastalProviderId` は既知providerだけの閉じたunionです。将来providerを追加する場合は `HYDRO_COASTAL_PROVIDER_IDS` と provider registry を明示更新します。未知provider IDはvalidation errorです。

### vertical datum

- `type=unknown` は常にTP変換不可です。
- `type=unknown` で `offsetToTpM` が非nullの場合はvalidation errorです。
- `type=tp` では `offsetToTpM=null` または `offsetToTpM=0` のみ許可します。
- `convertWaterLevelToTp()` と `canCompareVerticalDatums()` はvalidation errorのあるdatumを変換・比較可能として扱いません。

### mapping validity

`HydroCoastalStationNodeMapping` は `validFrom` と `validTo` による半開区間 `[validFrom, validTo)` で有効です。`validTo=null` は終了未設定を表します。

`mapHydroCoastalObservationsToHabitatNodes()` はvalidation errorのあるmappingを使用しません。有効期間外のmappingも適用せずwarningへ記録します。座標nearest-neighborによる暗黙mappingは引き続き禁止です。
