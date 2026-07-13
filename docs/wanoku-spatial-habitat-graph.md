# Wanoku Spatial Habitat Graph v1

## 目的

Spatial Habitat Graph v1 は、東京湾奥〜内房の12環境ノードを、独立した観測地点ではなく、環境変化や魚の移動仮説を将来重ねられる空間グラフとして表現するための基盤です。

現時点では、魚種別スコア、存在確率、ランキング、PWA表示には使いません。まずはノード、エッジ、検証、距離ベースの基本 utility を分離し、後続フェーズで地形・水深・底質・公開釣果 Evidence を安全に統合できる形にします。

## Node の意味

`HabitatNode` は、`workers/wanoku-intel-worker/src/environment-nodes.js` の環境ノードをもとに作られる空間上の代表ノードです。

保持する主な情報:

- `id`
- `displayName`
- `latitude` / `longitude`
- `region`
- `waterBodyType`
- `habitatTypes`
- `bayPosition`
- `depthBand`
- `riverInfluence` などの0〜1数値属性
- `confidence`
- `dataSources`
- `notes`

座標とIDは `environment-nodes.js` を source of truth とし、Habitat fixture 側で手作業の重複定義をしません。

## Edge の意味

`HabitatEdge` は、2つの `HabitatNode` 間にある大まかな空間接続を表します。

保持する主な情報:

- `fromNodeId`
- `toNodeId`
- `distanceKm`
- `connectionType`
- `directionality`
- `hydrologicalConnectivity`
- `migrationCost`
- `exposureContinuity`
- `freshwaterContinuity`
- `confidence`
- `dataSources`
- `notes`

`distanceKm` は緯度経度から haversine で計算します。手入力の固定距離は使いません。

## 確定情報と provisional 情報

v1で比較的確定して扱う情報:

- 既存環境ノードのID
- 既存環境ノードの座標
- 既存環境ノードの表示名
- 地名・ノード名・`waterType` から明白な大分類
- ノード間の距離

v1で provisional として扱う情報:

- ノードの habitat 分類
- `bayPosition`
- 大まかな edge 接続
- edge の `connectionType`

`confidence: null` は「未評価」を意味します。根拠のない信頼度を `0` や仮の数値で埋めません。

## unknown を 0 や bay として扱わない

`riverInfluence`、`freshwaterInfluence`、`tidalExposure`、`waveExposure`、`currentExposure`、`structureDensity`、`shallowAreaRatio`、`baitHoldingPotential`、`migrationCost` などの数値属性は0〜1で表します。

ただし、未確定値は `null` または未設定にします。`0` は「値がない」ではなく「確かに0」と解釈されるため、unknown の代替値として使いません。

`WaterBodyType` には `unknown` を持たせます。不明な `waterType` を `bay` にフォールバックしません。

## 連結性の意味

`connectedComponent` は edge の向きを無視した弱連結性の検査です。空間グラフとして一つながりかどうかを確認するために使います。

一方で、`directionality` を尊重した到達可能性は別の validation warning として検査します。たとえば `a -> b` だけがある場合、弱連結 component は1つですが、`b` から `a` へは到達不能です。

不正な `directionality` は暗黙に `from-to` として扱いません。validation error として返し、探索 utility では例外として拒否します。

## provenance

node の `dataSources`:

- `workers/wanoku-intel-worker/src/environment-nodes.js`

edge の `dataSources`:

- `workers/wanoku-intel-worker/src/environment-nodes.js`
  - 座標と node 定義の根拠
- `docs/wanoku-spatial-habitat-graph.md`
  - provisional topology design の根拠

edge 接続関係そのものが `environment-nodes.js` に由来するように見せないため、座標ソースと暫定 topology ソースを分けます。

edge の `distanceKm` だけが座標から算出された値です。`hydrologicalConnectivity`、`migrationCost`、`exposureContinuity`、`freshwaterContinuity` は未検証であり、魚や環境変化の移動可能性を保証しません。

## 魚種別モデルとの分離

Spatial Habitat Graph v1 は、シーバス、チヌ、アジ、メバル等の魚種別スコアとは分離しています。

このグラフは「空間構造」を表す土台であり、魚種別の存在確率、移動確率、到着・離脱確率をまだ計算しません。魚種モデルは、地形、環境、Evidence、バックテストがそろってから別レイヤーとして追加します。

## 初期 Edge

初期 edge は、地理的に明らかな大区分の接続だけに限定します。

- `sumida-arakawa-mouth-01` ↔ `tokyo-inner-bay-01`
- `tama-river-mouth-01` ↔ `keihin-canal-01`
- `keihin-canal-01` ↔ `tokyo-inner-bay-01`
- `tokyo-inner-bay-01` ↔ `bay-center-north-01`
- `funabashi-inner-01` ↔ `makuhari-shallow-01`
- `funabashi-inner-01` ↔ `bay-center-north-01`
- `makuhari-shallow-01` ↔ `bay-center-north-01`
- `bay-center-north-01` ↔ `bay-center-south-01`
- `bay-center-south-01` ↔ `kisarazu-north-01`
- `kisarazu-north-01` ↔ `futtsu-cape-01`
- `futtsu-cape-01` ↔ `kanaya-uchibo-01`
- `kanaya-uchibo-01` ↔ `tateyama-north-01`

距離以外の edge 重みは未確定のため `null` のままにします。

## validation

validation では error と warning を分けます。

error:

- `generatedAt` が空、不正な日時、または `Date.prototype.toISOString()` が生成する canonical UTC ISO 形式（例: `2026-07-13T00:00:00.000Z`）ではない
- node id重複
- edge id重複
- 緯度経度範囲外
- 数値属性の0〜1範囲外
- `waterBodyType` が定義済み列挙値ではない
- `habitatTypes` の要素が定義済み列挙値ではない
- `bayPosition` が定義済み列挙値ではない
- `depthBand` が定義済み列挙値ではない
- habitatTypes重複
- displayName空文字
- edgeの未知node参照
- self-loop
- `distanceKm <= 0`
- `connectionType` が定義済み列挙値ではない
- `directionality` が定義済み列挙値ではない
- 同一方向・同一connectionTypeの重複edge

warning:

- 孤立node
- disconnected component
- directionalityを尊重した到達不能node

## 今後の統合候補

将来候補:

- 水深データ
- 底質データ
- 護岸・橋脚・明暗・常夜灯などの構造物データ
- 河川流入・運河接続の実測または公的データ
- EvidenceEvent との空間関連付け
- Environmental Spine の時系列特徴量との接続
- バックテスト結果に基づく confidence 更新

## 今回やらないこと

今回のv1基盤では、以下は実装しません。

- シーバスモデル
- チヌモデル
- `presenceProbability`
- `arrivalProbability` / `departureProbability`
- 公開釣果 Evidence との接続
- D1保存
- Worker API endpoint
- PWA表示
- 距離以外の edge 重み
- habitat 数値属性の推測入力
- 魚種別ランキング
- 自動釣行判断への反映
