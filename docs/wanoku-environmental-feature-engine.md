# Wanoku Environmental Feature Engine v1

## 目的

Environmental Feature Engine v1 は、`EnvironmentalSnapshot` と Spatial Habitat Graph を入力にして、各 habitat node の環境状態を再現可能な `NodeEnvironmentalFeatures` へ変換する純粋関数レイヤーです。

このレイヤーは汎用環境特徴量だけを扱います。魚種別好適度、存在確率、釣行ランキング、Worker API endpoint、PWA UI にはまだ接続しません。

## as-of 計算

Feature Engine は `calculatedAt` を固定基準時刻として計算します。

- `calculatedAt` は `YYYY-MM-DDTHH:mm:ss.sssZ` の canonical UTC ISO 形式だけを許可します。
- `calculatedAt` が不正な場合、snapshot と quality report は feature 計算に使用しません。
- snapshot は `observedAt <= calculatedAt` かつ `collectedAt <= calculatedAt` の場合だけ使用します。
- quality report も同じ as-of 条件を満たす場合だけ使用します。
- 未来の `observedAt` または `collectedAt` を持つ入力は計算から除外し、warning に記録します。
- look-ahead data は使用しません。

## source timestamp 互換性

snapshot と quality report の source timestamp は、タイムゾーンを明示した RFC 3339 を許可します。

許可する例:

- `2026-07-13T01:00:00.000Z`
- `2026-07-13T01:00:00Z`
- `2026-07-13T10:00:00+09:00`

拒否する例:

- `2026-07-13`
- `2026-07-13T10:00:00`
- `July 13, 2026`
- `2026-02-30T00:00:00.000Z`

比較、window、provenance では UTC canonical ISO へ正規化します。一方、`environmentalSnapshotKey(snapshot)` による exact match では元snapshotの文字列表現を変更しません。日時比較用の正規化と identity/key 用の元値は分離します。

検証対象:

- snapshot: `observedAt`, `collectedAt`, `forecastIssuedAt`
- quality report: `observedAt`, `collectedAt`, `forecastIssuedAt`

`forecastIssuedAt` は `null` を許可します。

## raw observation との違い

`EnvironmentalSnapshot` は provider から正規化された、予報または観測の対象時刻ごとの値です。

`NodeEnvironmentalFeatures` は、snapshot を node 単位に束ねて以下を明示します。

- 入力総数と実際に使用した snapshot 数
- 除外された snapshot 数
- 使用 provider
- 使用snapshotの最大 `collectedAt`
- raw field と派生 field
- 欠損理由
- provider別 quality
- window統計
- provenance

件数の意味:

- `inputSnapshotCount`: 関数へ渡された入力 snapshot 総数
- `sourceSnapshotCount`: as-of filtering と dedupe/conflict処理の後、実際に feature 計算へ使用した snapshot 数
- `excludedSnapshotCount`: future / invalid datetime / nodeId不一致 / exact duplicate / conflicting duplicate により除外した snapshot 数

## Habitat Graph との結合

結合は `nodeId` の完全一致だけで行います。

- 座標の近似一致はしません。
- `buildNodeEnvironmentalFeatures()` でも `snapshot.nodeId === input.nodeId` の snapshot だけ使用します。
- nodeId が一致しない snapshot は除外し、warning と `excludedSnapshotCount` に反映します。
- 未知 nodeId の snapshot は黙って捨てず、`unmatchedSnapshotNodeIds` と warning で返します。
- snapshot がない habitat node は `nodesWithoutSnapshots` として返します。

## duplicate と conflict

snapshot identity key は以下です。

- `nodeId`
- `source`
- `observedAt`
- `collectedAt`

同一 identity key の扱い:

- 内容が同一なら exact duplicate とみなし、1件だけ使用します。`duplicate-source-snapshot` warning を出しますが、validation error にはしません。
- 内容が異なるなら conflicting duplicate とみなし、該当 identity group 全体を feature 計算から除外します。`conflicting-source-snapshot` error を出し、関連 field の missing reason にも残します。
- 比較は property 順に依存しない stable serialization で行います。
- `null`、`NaN`、`Infinity`、`-Infinity`、finite number は区別します。

## latest 値の選択規則

latest raw value は eligible snapshot だけから選びます。並び順は以下です。

1. `observedAt` が新しいもの
2. `collectedAt` が新しいもの
3. `source` の安定した文字列順

最新候補の値が `null` の場合は、それ以前の最新有効値を使用できます。最新候補が不正値の場合は、error / warning / provenance に記録したうえで、それ以前の最新有効値へfallbackできます。不正値を黙って無視しません。

`windows.latest` も field/provider ごとに同じ考え方で最新有効値を選びます。

## null と missing reason

未取得・算出不能な値は `null` にします。`0` を unknown の代替値として使いません。

主な `MissingReason`:

- `source-missing`
- `insufficient-samples`
- `unsupported-direction-convention`
- `invalid-source-value`
- `no-matching-node`
- `future-source-excluded`
- `conflicting-source-snapshot`
- `zero-denominator`
- `zero-vector-magnitude`
- `multiple-providers-no-aggregation-policy`

`duplicate-source-snapshot` は欠損理由ではなく warning として扱います。

## 単位

Feature field 名には単位を含めます。

- `airTemperatureC`
- `waterTemperatureC`
- `windSpeedMps`
- `windGustMps`
- `windDirectionDeg`
- `waveHeightM`
- `wavePeriodS`
- `waveDirectionDeg`
- `currentSpeedMps`
- `currentDirectionDeg`
- `seaLevelM`
- `pressureHpa`
- `precipitationMm`

## 方向データの convention

方位角から vector を作るには、方向の意味を明示する必要があります。

`DirectionConvention`:

- `toward`: その方向へ向かう
- `from`: その方向から来る
- `unknown`: 意味未確定

`toward` / `from` / `unknown` 以外の runtime 値は error にし、`toward` として扱いません。`directionConventions` が指定されない場合、vector と alignment は `null` になり、`unsupported-direction-convention` を保持します。

## 派生特徴量

安全に定義できる派生値だけを実装します。

- `temperatureDifferenceC = waterTemperatureC - airTemperatureC`
- `gustFactor = windGustMps / windSpeedMps`
- `windVectorEast / windVectorNorth`
- `waveVectorEast / waveVectorNorth`
- `currentVectorEast / currentVectorNorth`
- `windWaveAlignment`
- `windCurrentAlignment`
- `waveCurrentAlignment`

alignment は -1〜1 です。同方向は `1`、直交は `0`、逆方向は `-1` です。

`environmentalVolatility` は恣意的な総合指数を作らず、現時点では `null` です。変数別の window volatility を参照します。

## 時系列 window

対応 window:

- `latest`
- `3h`
- `6h`
- `12h`
- `24h`

`windowHours` は `3h` / `6h` / `12h` / `24h` だけを許可します。不正値は error にし、重複指定は warning として正規化します。

window は `calculatedAt` を起点にします。例: `3h` window は `calculatedAt - 3時間 <= observedAt <= calculatedAt` です。下限・上限とも包含します。

対象 field:

- `airTemperatureC`
- `waterTemperatureC`
- `windSpeedMps`
- `waveHeightM`
- `currentSpeedMps`
- `seaLevelM`
- `pressureHpa`

各 window は以下を保持します。

- `sampleCount`: 統計計算に実際に使用した有効sample数
- `invalidSampleCount`: window内で不正値として除外したsample数
- `providerIds`
- `firstCollectedAt`
- `lastCollectedAt`
- `mean`
- `min`
- `max`
- `change`
- `ratePerHour`
- `volatility`
- `missingReasons`

`volatility` は母標準偏差です。

window内の不正sampleは warning / provenance に記録します。provider別の `invalidSampleCount` と `missingReasons` は分離し、あるproviderの不正値を別providerの missing reason へ混ぜません。

## provider統合方針

同一 field/window に複数 provider が値を供給する場合、v1 では暗黙の等ウェイト平均をしません。

- aggregate window は `null` 統計になり、`multiple-providers-no-aggregation-policy` warning/missing reason を持ちます。
- provider別の window 統計は `providerWindows` に保持します。
- 複数providerの quality から単一の `confidence` / `freshness` は作りません。

## quality report の結合

quality report は `nodeId` だけでは結合しません。

使用条件:

- as-of 条件を満たす
- `report.snapshotKey === environmentalSnapshotKey(snapshot)`
- `report.nodeId` と対応snapshotの `nodeId` が一致する
- report日時と対応snapshot日時がUTC正規化後に一致する
- 対応する snapshot が実際に feature 計算へ使用されている

対応snapshotがない quality report や、不整合な quality report は warning として除外します。

providerごとの quality は `dataQuality.providerQuality` に保持します。複数providerの `confidence`、`freshness`、`missingRate` を平均・加重平均しません。単一値を一意に決められない場合、`NodeEnvironmentalFeatures.confidence` と `freshness` は `null` です。

validationでは provider別quality についても以下を確認します。

- `confidence`: `null` または 0..1
- `freshness`: `null` または 0..1
- `missingRate`: `null` または 0..1
- `qualityReportCount` / `staleCount`: 非負整数

quality report 自体の duplicate/conflict 処理は v1 では未実装です。必要なら次フェーズで追加します。

## provenance

raw field、derived field、window field は可能な範囲で provenance を持ちます。

主な項目:

- `providerId`
- `providerIds`
- `sourceFields`
- `collectedAt`
- `sourceCollectedAts`
- `snapshotSchemaVersion`
- `nodeId`
- `window`
- `sampleCount`
- `invalidSampleCount`
- `firstCollectedAt`
- `lastCollectedAt`
- `missingReasons`

派生値の provenance では、使用した source field、provider、collectedAt、sample数、欠損理由を追跡します。

## 現時点で予測には未使用

今回やらないこと:

- シーバスモデル
- チヌモデル
- `presenceProbability`
- `arrivalProbability` / `departureProbability`
- 公開釣果Evidenceとの接続
- D1保存
- Worker API endpoint
- PWA表示
- provider間の暗黙平均
- 魚種別ランキング
