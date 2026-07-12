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
| `forecastIssuedAt` | Worker取得完了時刻 | Worker取得完了時刻 | Open-Meteo responseに明示issue時刻がないため暫定 |
| `latitude` / `longitude` | response座標 | response座標 | grid cell座標の場合がある |
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
| `source` / `model` | adapterで付与 | adapterで付与 | raw responseはPWAへ返さない |
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
```

主要テーブル:

- `source_runs`
  - provider実行単位
  - `provider`, `requested_at`, `completed_at`, `status`, `http_status`, `error_code`, `model_version`, `raw_hash`, `normalized_schema_version`
- `environmental_snapshots`
  - node/provider/timeごとの正規化snapshot
  - `node_id`, `observed_at`, `forecast_issued_at`, `provider`, `normalized_json`
  - `node_id + provider + observed_at + forecast_issued_at + schemaVersion` の重複保存を防ぐ
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
- `forecastIssuedAt` は現時点ではWorker取得完了時刻で代用している。
- PWA本格UI、最終釣行スコアへの加算、魚種別推論への接続は未実装。
- 地図タイルや大容量raw responseのキャッシュはしない。
