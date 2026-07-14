# Wanoku JMA Tide Prediction Station-to-Habitat Mapping v1

## 目的

JMA Tide Prediction Station-to-Habitat Mapping v1 は、2026年の気象庁潮位予測station 5地点を、現在の12-node Spatial Habitat Graphへ明示的な primary anchor として結合するためのfixtureです。

これは釣り場ランキングではありません。距離だけでnearest-neighborを選ぶ処理でもありません。潮位stationをどのhabitat nodeの水位系入力として扱うかを、人間が理由付きで監査できるようにするためのmappingです。

## version / validity

- mappingVersion: `jma-tide-prediction-habitat-mapping.2026.v1`
- validFrom: `2025-12-31T15:00:00.000Z`
- validTo: `2026-12-31T15:00:00.000Z`

これはJSTの `[2026-01-01 00:00, 2027-01-01 00:00)` に対応します。

## mapping一覧

| station | station名 | habitat node | distanceKm | rationale | proxy |
|---|---|---|---:|---|---:|
| `TK` | 東京 | `tokyo-inner-bay-01` | 5.862 | Tokyo inner-bay primary tide anchor。河口固有の意味を避けるため、距離的に近い可能性があっても `sumida-arakawa-mouth-01` にはしない。 | false |
| `CB` | 千葉港 | `makuhari-shallow-01` | 6.708 | eastern inner-bay / Makuhari shallow anchor。 | false |
| `KZ` | 木更津 | `kisarazu-north-01` | 3.546 | northern Uchibo / Kisarazu anchor。 | false |
| `QS` | 横浜 | `keihin-canal-01` | 11.407 | western urban-bay provisional proxy。現行graphに横浜専用nodeがないため。 | true |
| `TT` | 館山 | `tateyama-north-01` | 2.065 | Tateyama / southern Uchibo anchor。 | false |

## distanceKmの意味

`distanceKm` はstation座標とhabitat node座標から `haversineDistanceKm()` と `roundDistanceKm()` で計算します。

ただし距離はmapping選択ロジックではありません。先に定義したmanual-reviewed targetの監査metadataです。distanceが近いnodeへ自動的にfallbackしたり、複数nodeへ伝播したりしません。

## confidence

`confidence` は全mappingで `null` です。

理由は、このmappingが潮位stationとhabitat nodeのprimary anchorを定めるための暫定設計であり、現時点では数値confidenceを支える検証データ、潮位補間誤差、地形・水路接続の評価が未整備だからです。根拠なしに0や1を入れません。

## validation

builderは以下を検証します。

- `reviewedAt` がcanonical UTC ISOであること
- station IDが存在すること
- station IDが重複しないこと
- station.providerIdが `jma-tide-prediction` であること
- habitat node IDがgraphに存在すること
- habitat node IDがgraph内で重複しないこと
- target定義にstation重複がないこと
- target定義に同じstation/node pair重複がないこと
- 生成mappingが `validateHydroCoastalStationNodeMapping()` を通ること

不正がある場合、nearest nodeへfallbackしません。結果の `errors` に記録し、mappingを採用しません。

## 未接続の範囲

今回のmapping fixtureは以下へ接続しません。

- Feature Engine
- Worker route
- D1 / migration
- Cron
- download処理
- graph propagation
- 潮位補間
- 魚種スコア
- 釣り場ランキング

## 再監査条件

以下が変わった場合はmappingを再監査します。

- JMA station metadataの年次更新
- 2026年以外の潮位表を扱う場合
- Spatial Habitat Graphのnode追加・座標変更
- 横浜専用nodeの追加
- station datumやTP offsetの更新
- tide interpolation / propagationを導入する場合

## Phase 3C-1 での利用状況

このmappingは `Hydro-Coastal Feature Bridge v1` から、JMA潮位予測stationをHabitat Nodeへ結合するために使用します。

ただし、これはまだEnvironmental Feature Engine本体との融合ではありません。node間propagation、複数station平均、釣行スコア、魚種別モデル、Worker/D1/PWA接続は未実装です。
