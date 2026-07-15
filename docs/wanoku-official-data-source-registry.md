# Wanoku Official Data Source Registry

## 方針

Wanoku は、潮汐、潮位、河川、沿岸波浪について公式または利用条件が確認できるデータ源を優先します。

Phase 3A では registry と core contract だけを定義します。外部APIアクセス、Web scraping、Worker endpoint、Cron、D1保存は実装しません。実際の adapter 実装前に、利用条件、配布方法、フォーマット、attribution、レート制限を再確認します。

非公式endpointや無断スクレイピングには依存しません。

## Provider Registry

| providerId | 対象 | accessMode | 自動取得 | 実装状況 | 方針 |
|---|---|---|---:|---|---|
| `jma-tide-prediction` | 潮汐予報・潮位予測 | `documented-download` | 無効 | `parser-implemented` | local fixed-width text parserのみ実装。download/Worker/D1未接続 |
| `jma-tide-observation` | 潮位観測・潮位偏差 | `documented-download` | 無効 | `adapter-not-implemented` | 公式形式と利用条件を確認するまで取得実装しない |
| `nowphas-wave` | 沿岸波浪・波高・周期・波向 | `documented-download` | 無効 | `adapter-not-implemented` | NOWPHASを無断scrapingせず、公式配布形式を確認する |
| `mlit-river` | 河川水位・流量・水温 | `licensed-distribution` | 無効 | `registry-only` | live取得は無効。配布条件・ライセンス・フォーマット確認が先 |
| `jcg-marine-information` | 海洋情報 | `registry-only` | 無効 | `registry-only` | Phase 3Aでは候補登録のみ |

## JMA tide prediction

- authority: Japan Meteorological Agency
- accessMode: `documented-download`
- supportedMetrics:
  - `predicted-tide-level`
- time semantics:
  - `observedAt` は予測対象時刻
  - `forecastIssuedAt` は公開表または予測vintageが明確な場合に設定
- datum:
  - station-specific tide table datum
  - TP offsetが明確でない限り他datumと比較しない
- status:
  - local fixed-width text parser 実装済み
  - download、自動取得、Worker、D1、Cronは未接続
  - `forecastIssuedAt` は固定長lineに含まれないため、caller supplied metadata として必須

## JMA tide observation

- authority: Japan Meteorological Agency
- accessMode: `documented-download`
- supportedMetrics:
  - `observed-tide-level`
  - `tide-anomaly`
- time semantics:
  - `observedAt` は観測対象時刻
  - `collectedAt` はWanokuが取得・正規化した時刻
- datum:
  - observation datum はstation-specific
  - TP offset未確認時は比較・平均しない
- status:
  - adapter未実装

## NOWPHAS

- authority: NOWPHAS
- accessMode: `documented-download`
- supportedMetrics:
  - `significant-wave-height`
  - `significant-wave-period`
  - `wave-direction`
  - `coastal-water-temperature`
- datum:
  - 波高・周期・波向にはvertical datumを使わない
- status:
  - adapter未実装
- 注意:
  - NOWPHASを無断scrapingしない
  - 公式の利用条件と取得形式を確認してからadapterを書く

## MLIT river

- authority: Ministry of Land, Infrastructure, Transport and Tourism
- accessMode: `licensed-distribution`
- supportedMetrics:
  - `river-stage`
  - `river-discharge`
  - `river-water-temperature`
- datum:
  - river stage はlocal river datumでstation-specific
  - TP offsetが明確でない限り潮位や海面高度と比較しない
- status:
  - registry-only
  - live取得無効

## JCG marine information

- authority: Japan Coast Guard
- accessMode: `registry-only`
- supportedMetrics:
  - `coastal-water-temperature`
- status:
  - registry placeholder
  - adapter未実装

## 実装前チェックリスト

adapter実装前に確認すること:

- 公式の利用条件
- 自動取得の可否
- attribution表記
- ファイルまたはAPIの正式フォーマット
- 更新頻度
- timezoneの意味
- forecast / observation / reanalysis の区別
- vertical datumの説明
- station IDの安定性
- 欠測・速報・確定値の扱い
- retry / timeout / malformed response の分類

## 禁止事項

- 非公式endpointを前提にしない
- CORS回避目的の無制限proxyを作らない
- APIキーやsecretをクライアントへ置かない
- datum不明の水位を暗黙比較しない
- source timestampをUTCと誤解釈しない
- synthetic fixtureを実在データとして扱わない
## Phase 3D-2B JMA tide prediction official source catalog

The Worker now has a local official source catalog for the JMA tide prediction text data.

Official URL pattern:

```text
https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/{year}/{stationId}.txt
```

Currently allowlisted:

- `sourceYear`: `2026`
- `stationId`: `TK`, `CB`, `KZ`, `QS`, `TT`

The station list is derived from `JMA_TIDE_PREDICTION_STATIONS_2026`; the Worker source catalog does not maintain a separate hand-written station list.

Security policy:

- Admin request bodies cannot supply arbitrary `sourceUrl`.
- Query strings, fragments, credentials, path traversal, and unsupported station/year values are rejected before fetch.
- Source name and attribution come from the catalog.
- Raw source bodies are not stored or returned.

Automation status:

- Local parser: implemented.
- Admin manual ingestion route: implemented.
- Cron/scheduled ingestion: not connected.
- Public read API: not connected.
- Feature Bridge automatic execution: not connected.
