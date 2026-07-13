# Wanoku Environmental Spine v1

最終更新: 2026-07-12  
対象: `packages/wanoku-core`, `workers/wanoku-intel-worker`

## 目的

Environmental Spine v1 は、東京湾奥〜内房の環境場を時系列として保存し、魚の現在位置・移動方向・将来存在確率の推論とバックテストに使うための基盤です。

これは釣果実績ポイントのランキングではありません。各地点は「実在スポット」ではなく、風・雨・波・水温・流れなどの環境場を推定する観測ノードです。

## データ源

初期実装のprovider:

| provider | 用途 | 接続先 |
|---|---|---|
| `open-meteo-weather` | 気温、風、突風、気圧、降水 | Open-Meteo Weather API |
| `open-meteo-marine` | 波、風波、うねり、SST、海流、海面高度モデル | Open-Meteo Marine API |

Open-MeteoのWeather APIは、地点座標とhourly変数を指定して気象時系列を返します。Marine APIは、波、うねり、SST、海流、海面高度などのhourly変数を返します。

## 項目対応表

| Wanoku normalized field | Weather API | Marine API | 備考 |
|---|---|---|---|
| `observedAt` | `hourly.time[]` | `hourly.time[]` | 予報対象時刻。実測とは限らない |
| `collectedAt` | Worker取得時刻 | Worker取得時刻 | Wanoku Workerがproviderレスポンスを取得した時刻。保存時は必須 |
| `forecastIssuedAt` | 原則 `null` | 原則 `null` | providerが真のモデルラン時刻または発表時刻を明示する場合のみ設定 |
| `latitude` / `longitude` | response座標 | response座標 | grid cell座標の場合がある |
| `coordinateDistanceKm` | request nodeとresponse座標の距離 | request nodeとresponse座標の距離 | D1専用columnは作らずnormalized JSONに保存 |
| `windSpeed` | `wind_speed_10m` | - | m/s指定 |
| `windDirection` | `wind_direction_10m` | - | 0/360境界をcore側で考慮 |
| `windGust` | `wind_gusts_10m` | - | m/s指定 |
| `pressure` | `pressure_msl` | - | hPa |
| `pressureTrend` | `pressure_msl`差分 | - | 直前hourとの差分 |
| `precipitation` | `precipitation` | - | mm |
| `accumulatedRain` | `precipitation`累積 | - | 現在は直近最大24点累積 |
| `airTemperature` | `temperature_2m` | - | ℃ |
| `waveHeight` / `waveDirection` / `wavePeriod` | - | `wave_*` | m / degree / sec |
| `windWaveHeight` / `windWaveDirection` / `windWavePeriod` | - | `wind_wave_*` | 風波とうねり比率に使う |
| `swellHeight` / `swellDirection` / `swellPeriod` | - | `swell_wave_*` | m / degree / sec |
| `seaSurfaceTemperature` | - | `sea_surface_temperature` | ℃ |
| `oceanCurrentVelocity` / `oceanCurrentDirection` | - | `ocean_current_*` | 海流ベクトル化に使う |
| `seaLevelHeightMsl` | - | `sea_level_height_msl` | 沿岸潮位の真値として扱わない |
| `source` | adapterで付与 | adapterで付与 | raw responseはPWAへ返さない |
| `model` | 原則未設定 | 原則未設定 | `timezone` / `timezone_abbreviation` / `utc_offset_seconds` はモデル識別子として扱わない |
| `confidence` / `freshness` / `missingFields` | adapter/coreで算出 | adapter/coreで算出 | 合成スコアではなく品質情報 |

## Attribution

Open-Meteo利用時は、Open-Meteoおよび基盤モデル提供元への明確な帰属表示が必要です。UIに本格接続するときは、画面または設定/情報ページでattributionを表示します。

参考:

- [Open-Meteo Weather Forecast API](https://open-meteo.com/en/docs)
- [Open-Meteo Marine Weather API](https://open-meteo.com/en/docs/marine-weather-api)

## 取得頻度

初期Cron:

```text
0 */3 * * *
```

3時間ごとに全観測ノードを対象に、Weather / Marine providerをそれぞれ取得します。一部providerや一部nodeが失敗しても、全体を破棄せず、node/provider単位の `source_runs` として記録します。

## 欠測・鮮度・信頼度方針

- 欠測は `missingFields` として保持し、勝手に0埋めしない。
- `confidence` はprovider基準値から欠測数に応じて下げる。
- `freshness` は予報対象時刻と取得時刻から指数減衰で算出する。
- 古い予報、欠測が多いsnapshot、provider間で矛盾するsnapshotは、推論側で重みを下げる。
- `windGust < windSpeed` のようなprovider元データ上の逆転は値を丸めず、quality warning `wind_gust_below_sustained_wind` として露出する。
- 外部API失敗は通常ケースとして扱い、`timeout`, `http_error`, `malformed_response`, `network_error`, `validation`, `unknown` に分類する。
- APIレスポンスをそのままPWAへ渡さず、Worker側で正規化したsnapshotだけを返す。

## 海面高度の注意

`seaLevelHeightMsl` はOpen-Meteo Marineの海面高度モデル出力です。沿岸の実測潮位、港湾内潮位、釣り場ピンポイントの潮位真値として扱いません。

特に運河、河口、堤防内側、浅場では、地形・河川流量・風・気圧・水門運用などにより実際の水位と乖離します。Wanokuでは「広域環境場の特徴量」として扱い、潮汐表や実測潮位の代替にはしません。

## D1 / KV の責務分離

Environmental Spine v1 の保存先はD1です。

- D1
  - `source_runs`
  - `environmental_snapshots`
  - `prediction_snapshots`
  - `evidence_events`
  - `backtest_results`
- KV
  - 今回は使用しない
  - 将来、低頻度の設定・cache metadata・rate-limit補助に限定して検討

大きなraw API responseを長期保存する設計にはしていません。raw responseはhash化して `rawHash` として追跡します。

## D1 schema

Migration:

```text
workers/wanoku-intel-worker/migrations/0001_environmental_spine.sql
workers/wanoku-intel-worker/migrations/0002_source_runs_node_id.sql
```

主要テーブル:

- `source_runs`
  - provider実行単位
  - `provider`, `node_id`, `requested_at`, `completed_at`, `status`, `http_status`, `error_code`, `model_version`, `raw_hash`, `normalized_schema_version`
- `environmental_snapshots`
  - node/provider/timeごとの正規化snapshot
  - `node_id`, `observed_at`, `collected_at`, `forecast_issued_at`, `provider`, `normalized_json`
  - `snapshot_key` のUNIQUE制約で同一ヴィンテージの重複保存を防ぐ
  - `node_id + provider + observed_at` だけでは一意化しない
- `prediction_snapshots`
  - 将来の推論snapshot保存先
- `evidence_events`
  - 将来の外部観測event保存先
- `backtest_results`
  - 将来の検証結果保存先

## Worker endpoints

既存endpoint:

- `GET /health`
- `GET /sources`
- `GET /intel`
- `GET /evidence`
- `GET /predictions`

Environmental Spine v1 endpoint:

- `GET /environment/nodes`
  - 東京湾奥〜内房の観測ノード一覧
- `GET /environment/current`
  - 最新snapshot。D1未設定時はfixtureを返す
- `GET /environment/history`
  - `nodeId`, `start`, `end`, `limit` で履歴取得
- `GET /environment/quality`
  - 最新snapshotの欠測率・鮮度・警告
- `POST /admin/collect-environment`
  - 手動収集
  - `Authorization: Bearer <WANOKU_ADMIN_SECRET>` または `X-Wanoku-Admin-Secret` が必要

admin secretはCloudflare secretとして設定し、クライアントやrepoには置きません。

## 読み取り専用監査

Wanoku Environmental Spineの本番状態は、監査スクリプトで読み取り専用確認できます。Workerの公開APIとD1の `SELECT` だけを使い、admin secretは要求しません。

通常出力:

```powershell
.\scripts\wanoku-audit-environment.ps1
```

JSON出力:

```powershell
.\scripts\wanoku-audit-environment.ps1 -Json
```

終了コード:

- `0`: `HEALTHY`
- `1`: `DEGRADED`
- `2`: `FAILED`
- `3`: 監査ツール自体の設定・実行エラー

テストやオフライン確認では `--fixture-dir` / `-FixtureDir` で `health.json`, `current.json`, `quality.json`, `d1.json` を読み込めます。

## Deploy / D1 / Cron 手順

1. D1 databaseを作成する。

```bash
npx wrangler d1 create wanoku-intel --config workers/wanoku-intel-worker/wrangler.toml
```

2. 出力された `database_id` を `workers/wanoku-intel-worker/wrangler.toml` の `database_id` に設定する。

3. Migrationを適用する。

```bash
npx wrangler d1 migrations apply wanoku-intel --config workers/wanoku-intel-worker/wrangler.toml
```

4. admin secretを設定する。

```bash
npx wrangler secret put WANOKU_ADMIN_SECRET --config workers/wanoku-intel-worker/wrangler.toml
```

5. Workerをdeployする。

```bash
npx wrangler deploy --config workers/wanoku-intel-worker/wrangler.toml
```

6. Cron設定をCloudflare dashboardまたはwrangler設定で確認する。

```toml
[triggers]
crons = ["0 */3 * * *"]
```

## 既知の制限

- Open-Meteo以外の公式環境データproviderは未実装。
- NOWPHAS等の無断スクレイピングは行わない。
- D1保存はsnapshot単位であり、provider横断の完全トランザクションではない。
- Open-Meteo live APIでは真のモデル発表時刻を確実に取得していないため、`forecastIssuedAt` は `null` とし、取得時刻は `collectedAt` に保存する。
- PWA本格UI、最終釣行スコアへの加算、魚種別推論への接続は未実装。
- 地図タイルや大容量raw responseのキャッシュはしない。

## Workers Free向けsubrequest削減方針

本番収集では、12観測ノードをnode単位に個別fetchしません。

- Weather APIは全nodeの `latitude` をカンマ区切り、`longitude` も同じ順序のカンマ区切りにして、原則1回のfetchにまとめる。
- Marine APIも同じく全nodeを原則1回のfetchにまとめる。
- 通常収集時の `externalFetchCount` は2を期待値とする。
- `POST /admin/collect-environment?provider=weather` のような診断時は1になる。
- Open-Meteoの複数地点レスポンスが配列で返る場合、`location_id` と返却緯度経度の妥当性でnodeへ対応付ける。
- 配列順だけを盲信しない。
- 一部地点のレスポンスが欠けた場合、そのnode/providerだけfailureとして記録する。

## D1 chunk write

D1保存はsnapshotごとの個別 `run()` を避け、複数行 `INSERT OR REPLACE` / `INSERT OR IGNORE` へまとめる。

- `source_runs`
  - node/provider別の成功・失敗追跡を維持する。
  - 1 statementあたり最大90 bound parametersを目安にチャンク化する。
  - 現在は11 columnsなので、通常は8 rows/statement。
- `environmental_snapshots`
  - 収集1回あたりnode/providerの代表snapshotを1件保存する。
  - 12 nodes × 2 providers = 通常24 snapshots。
  - 18 columnsなので、通常は5 rows/statement。
- 同一snapshotは `snapshot_key` で重複保存を防ぐ。
- 新規 `snapshot_key` は `node|provider|observedAt|issued:forecastIssuedAt|schemaVersion` または `node|provider|observedAt|collected:collectedAt|schemaVersion` とし、同じ対象時刻でも取得ヴィンテージを区別する。

通常時の目安:

| 項目 | 期待値 |
|---|---:|
| `nodeCount` | 12 |
| `providerCount` | 2 |
| `externalFetchCount` | 2 |
| `snapshotCount` | 24 |
| `d1StatementCount` | 約8 |
| `estimatedSubrequestCount` | 約10 |

目標は外部fetch + D1 statement合計20未満、少なくともWorkers Freeのsubrequest制限に十分な余裕を持つこと。

## provider単位の部分成功

- Weather成功 / Marine失敗の場合、Weather snapshotは保存する。
- Marine成功 / Weather失敗の場合、Marine snapshotは保存する。
- timeout / HTTP error / malformed JSON / network errorはprovider単位で分類する。
- 一方のprovider失敗で全体を破棄しない。
- ただしD1書込そのものが失敗した場合は、`ok: false`, `error: "environment_collection_failed"` の安定JSON 500を返す。
- stack、secret、SQL全文はレスポンスへ返さない。詳細はWorker logへ記録する。

診断用admin endpoint:

```text
POST /admin/collect-environment
POST /admin/collect-environment?provider=weather
POST /admin/collect-environment?provider=marine
POST /admin/collect-environment?node_id=<node-id>
```

admin endpointは引き続き `WANOKU_ADMIN_SECRET` で保護する。secretをクライアントやレスポンスへ返さない。

## Forecast vintage time model

2026-07-13 更新。以後のEnvironmental Snapshotでは、時刻の意味を次の3つに分離する。

| field | 意味 | 必須 |
|---|---|---|
| `observedAt` | 予報または観測の対象時刻。Open-Meteo hourly `time[]` に対応する | yes |
| `collectedAt` | Wanoku Workerがproviderレスポンスを取得した時刻 | yes |
| `forecastIssuedAt` | providerが真のモデルラン時刻または発表時刻を明示する場合のみ設定する | no |

Open-Meteo live API adapterでは、現時点で真のモデルラン時刻を確実に取得していない。そのため、live取得の `completedAt` / `collectedAt` を `forecastIssuedAt` として扱わない。Open-Meteo live由来の新規snapshotでは `forecastIssuedAt` は `null`、取得時刻は `collectedAt` に保存する。

以前の実装では `forecastIssuedAt` にWorker取得完了時刻を入れていた。既存D1では `snapshot_key` の第4要素が実質的に「取得時刻」になっている行がある。この値は真のモデル発表時刻とは限らないため、旧snapshot_keyは変更・再生成せず読み取り互換として保持する。

## Forecast vintage retention

同じ `nodeId` / `provider` / `observedAt` でも、`collectedAt` が異なる行は別の予報ヴィンテージとして保持する。予報バックテストでは「いつ取得した予報が、どの対象時刻をどう予測していたか」が必要なため、これらを単純削除しない。

新規snapshot key:

```text
node|provider|observedAt|issued:forecastIssuedAt|schemaVersion
node|provider|observedAt|collected:collectedAt|schemaVersion
```

真の `forecastIssuedAt` があるproviderでは `issued:` を使う。Open-Meteo liveのように真の発表時刻が不明な場合は `collected:` を使う。

`environmental_snapshots` では、`snapshot_key` の既存UNIQUE制約を一意性の主軸とする。`node_id + provider + observed_at` だけで一意化しない。既存D1にある重複ヴィンテージ行は削除しない。

将来、Open-Meteo Historical Forecast API / Single Runs API など、モデルラン時刻を明示できるデータ源を使う場合は、その値を `forecastIssuedAt` に入れる。その場合も `collectedAt` はWanokuの取得時刻として別に保持する。

保持期間、圧縮、古いヴィンテージの集約、バックテスト済みデータのアーカイブ方針は別フェーズで扱う。今回のmigrationでは既存行を削除しない。

## Current / history semantics

- `/environment/current`
  - 各node/providerについて最新の `collectedAt` を持つヴィンテージを返す。
  - 同じ `observedAt` の古いヴィンテージを無制限に返さない。
- `/environment/history`
  - 複数ヴィンテージを返せる。
  - `start` / `end` は `observedAt` の範囲指定。
  - `collectedStart` / `collectedEnd` は `collectedAt` の範囲指定。
  - `orderBy=collectedAt` で取得時刻順に並べられる。

## Migration 0002 policy

`workers/wanoku-intel-worker/migrations/0002_source_runs_node_id.sql` は未適用前提で修正する。

- `source_runs.node_id` を追加する。
- `environmental_snapshots.collected_at` をnullableで追加する。
- `collected_at` は `source_runs.completed_at`、`source_runs.requested_at`、既存 `forecast_issued_at`、`created_at` の順でbackfillする。
- Open-Meteo live由来で、旧実装が取得時刻を `forecast_issued_at` に入れていた行は `forecast_issued_at = NULL` にする。
- `idx_environmental_snapshots_unique_logical` はDROPする。
- logical unique indexは作成しない。
- 既存行をDELETEしない。
