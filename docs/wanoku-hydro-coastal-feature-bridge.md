# Wanoku Hydro-Coastal Feature Bridge v1

## 目的

Hydro-Coastal Feature Bridge v1 は、`HydroCoastalObservation` と明示的な station-to-habitat mapping を使い、正時の潮位予測を Habitat Node 単位の feature に変換する純粋な core 層です。

この段階では Worker、D1、Cron、PWA、Environmental Feature Engine 本体には接続しません。魚種別スコア、存在確率、ランキングも生成しません。

## Pipeline

1. `selectHydroCoastalObservationsAsOf(observations, calculatedAt)` で as-of selection を行う。
2. `mapHydroCoastalObservationsToHabitatNodes()` で明示 mapping だけを使って observation を Habitat Node へ結合する。
3. `targetAt` に exact match する `predicted-tide-level` を node feature にする。
4. 同じ forecast vintage の `targetAt - 1h / 3h / 6h` だけを使い、change/rate を計算する。
5. 12 node すべてについて feature record を出力する。

## calculatedAt と targetAt

- `calculatedAt`
  - as-of cutoff。
  - `collectedAt <= calculatedAt` の revision だけを使用する。
  - canonical UTC ISO (`YYYY-MM-DDTHH:mm:ss.sssZ`) が必須。
  - 内部で現在時刻を生成しない。

- `targetAt`
  - feature の予測対象時刻。
  - canonical UTC ISO が必須。
  - Phase 3C-1 では正時のみ許可する。
  - `targetAt` は `calculatedAt` より未来でも過去でもよい。将来予測とbacktestの両方で使うため。

## exact-hour only

Phase 3C-1 は正時の値だけを扱います。

- 前後時刻から線形補間しない。
- 隣接する潮位から対象正時の値を推測しない。
- 欠測時は `null` と missing reason を返す。

## forecast vintage

同じ station/provider/targetAt に複数の `forecastIssuedAt` がある場合は、as-of時点で最も新しい `forecastIssuedAt` を採用します。

lookback値は target observation と完全に同じ `providerId`、`stationId`、`forecastIssuedAt` の observation だけを使います。古い forecast vintage の値で穴埋めしません。

## unit normalization

`predicted-tide-level` は `cm` と `m` を受け付けます。

- `cm`: そのまま使用。
- `m`: `value * 100` で cm に正規化。
- 負潮位は許可。
- 未対応単位は `unsupported-unit` として `null` にする。

## TP換算

target observation の `tideLevelM` と `verticalDatum` を使い、`convertWaterLevelToTp()` で TP 換算を行います。

- `offsetToTpM` が明確な場合だけ `tideLevelTpM` を生成する。
- datum不明またはoffset不明の場合は `tideLevelTpM=null`。
- offset不明を `0` として扱わない。
- change/rateは同一station・同一datum内の差分なので、TP換算できなくても計算可能。

## 1h / 3h / 6h change と trend

- `changeNhCm = target level cm - lookback level cm`
- `rateNhCmPerHour = changeNhCm / N`
- `trend1h`
  - `change1hCm > 0`: `rising`
  - `change1hCm < 0`: `falling`
  - `change1hCm === 0`: `steady`
  - 欠測: `unknown`

潮止まり、上げ何分、下げ何分、満干潮接近などの意味付けはまだ行いません。

## mappingなしnode

Habitat Graphの全nodeについて feature record を出力します。

mappingがないnodeは:

- `providerId=null`
- `stationId=null`
- 潮位fieldはすべて `null`
- `missingReasons` に `no-active-mapping`

node間propagation、nearest-neighbor mapping、複数station平均は実装しません。

## Data quality

`requiredObservationCount` は target + 1h + 3h + 6h の4件です。

- `availableObservationCount`: 同一forecast vintageで利用できた件数。
- `missingRate`: `(required - available) / required`
- `confidence`: v1では `null`。根拠のない信頼度は生成しない。

## provenance

fieldごとに以下を追跡します。

- provider/station/node
- targetAt
- forecastIssuedAt
- collectedAt
- observation identity/version key
- mapping method / distance / source / reviewedAt
- lookback observation key
- window hours
- TP変換のdatum type / offset
- missing reasons

## 未接続範囲

- Environmental Feature Engineとの融合
- Worker route
- D1保存
- Cron収集
- PWA表示
- 魚種別モデル
- fishing score / ranking
- tide phase / high-low inference
- node間propagation

## Audit update: diagnostic attribution

Result-level errors and warnings remain available on `BuildHydroCoastalFeatureSetResult`, but node-level `missingReasons` are only assigned when the diagnostic can be safely attributed to that node.

For `future-revision-excluded` and `conflicting-observation`, the bridge parses the hydro-coastal observation version key and only attaches the reason when all of the following are true:

- metric is `predicted-tide-level`
- observedAt is `targetAt`, `targetAt - 1h`, `targetAt - 3h`, or `targetAt - 6h`
- providerId/stationId maps explicitly to that Habitat Node

Diagnostics for unrelated stations, unrelated times, malformed keys, or unknown habitat mappings stay at result level and are not copied to every feature.

## Audit update: mapping conflicts

Mapping diagnostics are intentionally separated:

- `conflicting-mapping`: same provider/station/node pair has multiple different active mappings at `targetAt`; the bridge excludes that pair instead of choosing one.
- `multiple-active-stations`: different provider/station keys are active for the same node; the bridge does not average or choose by distance.
- exact duplicate mappings are deduped with a warning and can still produce features.
