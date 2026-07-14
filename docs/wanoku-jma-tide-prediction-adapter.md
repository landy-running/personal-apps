# Wanoku JMA Tide Prediction Fixed-Width Parser v1

## 責務

`packages/wanoku-core/src/jma-tide-prediction.ts` は、気象庁の潮位表テキストデータ版を local text として受け取り、`HydroCoastalObservation` へ正規化する parser です。

今回実装したのは parser のみです。外部download、fetch、Web scraping、Worker endpoint、D1保存、Cron、PWA、Feature Engine接続、魚種別スコアへの利用は未実装です。

## 固定長format

非空行は改行を除いて正確に136文字です。parserは `split(/\s+/)` を使わず、column positionだけで読み取ります。

| column | 内容 | 説明 |
|---:|---|---|
| 1-72 | 毎時潮位24件 | 1件3文字、0時から23時、単位cm、space padded、負値可 |
| 73-78 | 年下2桁・月・日 | 各2文字、space padded可 |
| 79-80 | 地点記号 | 2文字 |
| 81-108 | 満潮4件 | 各7文字 = 時刻4文字 + 潮位3文字 |
| 109-136 | 干潮4件 | 各7文字 = 時刻4文字 + 潮位3文字 |

公式はLF想定ですが、parserはCRLFの末尾 `\r` を除去します。空行は無視します。非空行の長さが136でない場合はerrorです。

## JST → UTC

潮位表の年月日・時刻はJSTとして扱います。

- `2026-01-01 00:00 JST` は `2025-12-31T15:00:00.000Z`
- OS timezoneや `process.env.TZ` には依存しません。
- `Date` のlocal timezone constructorは使いません。
- 満潮・干潮時刻もファイル上の日付に属するJST時刻として扱い、日付跨ぎは推測しません。

## forecastIssuedAt

固定長lineには発行日時が含まれません。そのため `context.forecastIssuedAt` は必須です。

- canonical UTC ISOのみ許可します。
- `collectedAt` や `normalizedAt` で代用しません。
- 未指定・不正な場合、observationは生成しません。
- provenance notes に caller supplied dataset issuance metadata であることを記録します。

## sourceYear

lineには年下2桁しか含まれないため、`context.sourceYear` を必須にします。

- 4桁整数のみ許可します。
- lineのYYと `sourceYear % 100` が一致しない場合はerrorです。
- centuryは推測しません。
- 存在しない日付は拒否します。
- leap yearはUTCではなくJST日付として検証します。

## station fixture

`JMA_TIDE_PREDICTION_STATIONS_2026` に以下の最小station fixtureを定義しています。

- `TK`: 東京、35°39′ / 139°46′、`offsetToTpM=-1.141`
- `CB`: 千葉港、35°36′ / 140°06′、`offsetToTpM=null`
- `KZ`: 木更津、35°22′ / 139°55′、`offsetToTpM=null`
- `QS`: 横浜、35°27′ / 139°39′、`offsetToTpM=-1.15`
- `TT`: 館山、34°59′ / 139°51′、`offsetToTpM=null`

providerIdは `jma-tide-prediction`、stationTypeは `forecast-point`、supportedMetricsは `predicted-tide-level` です。

緯度経度は度分値をdecimal degreesへ変換して保持します。潮位表基準面のTP標高は、2026年気象庁潮位表掲載地点一覧で明確な地点だけ設定します。2026年6月12日時点では `TK=-1.141m`、`QS=-1.15m` を設定し、`CB` / `KZ` / `TT` は `null` のままです。datum offsetは推測しません。station metadataは年次更新対象です。

今回はhabitat node mappingを追加していません。mappingは次工程で個別監査します。

## observation生成

毎時値1件につき `HydroCoastalObservation` を1件生成します。

- `metric`: `predicted-tide-level`
- `unit`: `cm`
- `status`: `predicted`
- `provisional`: `false`
- `providerId`: `jma-tide-prediction`
- `stationId`: 公式地点記号
- `observedAt`: JST対象時刻をUTC正規化
- `collectedAt`: context値
- `forecastIssuedAt`: context値
- `verticalDatum`: station定義のdatum

出力前に `validateHydroCoastalObservation()` を station/provider context付きで実行し、無効observationは出力せずline/hour付きerrorにします。

## hourly value

毎時潮位の3文字fieldはtrimして整数parseします。

- space padded正数を許可します。
- 負値を許可します。
- 空欄、非整数、桁異常はerrorです。
- `999` は欠測sentinelとは推測しません。

## high / low tide

満潮・干潮は `JmaTidePredictionDailyRecord` に保持しますが、Phase 3B-1では `HydroCoastalObservation` へ変換しません。

理由:

- 既存metricに `high-tide-event` / `low-tide-event` がない。
- `predicted-tide-level` として出すと毎時値とのidentity衝突が起き得る。

`9999/999` はextremumなしとして扱います。片方だけsentinelの場合はerrorです。通常値はHHMMとsigned integer cmとして検証します。

## duplicate

同一ファイル内で `stationCode + localDate` が重複した場合:

- 完全同一lineはwarningを返し、1日分だけ採用します。
- 内容相違はconflict errorとし、その日groupを採用しません。
- 入力順序に依存しません。

## provenance / attribution

provenanceには以下を記録します。

- sourceName: Japan Meteorological Agency tide table
- sourceKind: official
- sourceUrl: context値
- sourceTimestamp: 元のJST対象時刻
- sourceTimezone: Asia/Tokyo
- normalizedAt: context値
- parserId / parserVersion
- sourceFormatVersion
- attribution
- source line number / hour / station code

気象庁データを利用・加工する際は、気象庁を出典として明示し、Wanokuによる正規化・加工物であることを表示します。

## 実装しないこと

- 外部APIアクセス
- Web scraping
- fetch / download処理
- Worker runtime変更
- D1 / migration / Cron
- PWA変更
- Feature Engine接続
- 魚種スコア、存在確率、ランキング
