# RunOS Strava連携 設計メモ

最終確認日: 2026-07-10  
対象: RunOS Legacy PWA / Cloudflare Worker / Strava API

この文書は、RunOS Legacy PWAからStrava活動を安全に取得するための設計メモです。現時点ではWorkerモックまでを対象とし、Strava本接続、RunOS HTML変更、`meridian.v1` への書き込みは行いません。

参照元:

- [Strava Authentication](https://developers.strava.com/docs/authentication/)
- [Strava API Reference: List Athlete Activities](https://developers.strava.com/docs/reference/#api-Activities-getLoggedInAthleteActivities)
- [Strava Rate Limits](https://developers.strava.com/docs/rate-limits/)

## 1. 目的

- RunOS Legacy PWAからStravaのランニング活動を取得できるようにする
- `client_secret`、`refresh_token`、短命の`access_token`をPWA/HTML/localStorageへ置かない
- Strava OAuth、token更新、Strava API呼び出しをCloudflare Worker側へ寄せる
- RunOSの既存保存キー `meridian.v1` へ直接書かず、まずプレビューと明示インポート確認を挟む

## 2. 現在の実装事実

- RunOS本線は `runos/RunOS v100 apex.html` を配信するRunOS Legacy PWA
- 既存HTMLにはStrava CSV一括エクスポート取込がある
- 既存HTMLの正規化口は `normalizeActivity()` で、概ね次の形へ寄せる:
  - `id`
  - `date`
  - `type`
  - `km`
  - `durSec`
  - `hrAvg`
  - `hrMax`
  - `elevM`
  - `cadence`
  - `note`
  - `source`
- 既存HTMLには `IMPORT_ADAPTERS.strava_api` があるが、`ready:false` でまだ実接続しない前提
- `meridian.v1` はRunOSの既存localStorage主キーであり、Strava連携の初期段階では直接更新しない

## 3. OAuth全体フロー

将来の本接続では次の流れにする。

1. RunOS Legacy PWAがWorkerの `/auth/start` を開く
2. WorkerがStrava認可URLを生成する
   - `client_id`
   - `redirect_uri`
   - `response_type=code`
   - `approval_prompt=auto`
   - `scope=activity:read` または明示同意時のみ `activity:read_all`
   - CSRF対策用 `state`
3. ユーザーがStravaで認可する
4. StravaがWorkerの `/auth/callback` へ戻す
5. Workerが `state` を検証する
6. Workerが認可コードをStravaのtoken endpointへ送り、`access_token` と `refresh_token` を取得する
7. Workerがtokenをサーバー側ストレージへ保存する
8. PWAはWorkerの `/activities` を呼び、Strava活動のプレビューを取得する
9. PWAはプレビューを表示し、ユーザーが確認したものだけRunOSへインポートする

現時点のモックWorkerでは、5〜7の本処理は行わず、モックレスポンスのみ返す。

## 4. Workerに置くsecret / 環境変数

Cloudflare Worker側で扱う環境変数:

| 名前 | 種別 | 用途 | PWA配布物へ含める可否 |
|---|---|---|---|
| `STRAVA_CLIENT_ID` | 環境変数 | Stravaアプリのclient id | 原則Worker側で管理。公開情報だがPWAは知らなくてよい |
| `STRAVA_CLIENT_SECRET` | secret | token交換・refreshに使うsecret | 禁止 |
| `STRAVA_REDIRECT_URI` | 環境変数 | Stravaから戻るWorker callback URL | PWAに置く必要なし |
| `TOKEN_STORAGE` | 環境変数 | token保存方式の切替。初期は `mock` | PWAに置く必要なし |
| `RUNOS_LEGACY_PWA_ORIGIN` | 環境変数 | CORSで許可するRunOS Legacy PWA公開URL | PWAに置く必要なし |
| `LOCAL_DEV_ORIGINS` | 環境変数 | CORSで許可するlocalhost開発URL | PWAに置く必要なし |

`STRAVA_CLIENT_SECRET` は `wrangler.toml` やソースコードへ書かず、Cloudflare Dashboardまたは `wrangler secret put STRAVA_CLIENT_SECRET` で設定する。

## 5. TOKEN_STORAGE 方針

初期段階:

- `TOKEN_STORAGE=mock`
- token永続化なし
- Strava本接続なし
- `/activities` は固定のモック活動を返す

本接続段階:

- 個人利用・単一ユーザーならCloudflare KVで開始可能
- 複数ユーザーやtoken更新履歴を厳密に扱うならD1を検討する
- 保存するのはWorker側のみ
  - athlete id
  - granted scopes
  - latest refresh token
  - latest access token
  - expires_at
  - updated_at
- Stravaのrefresh tokenは更新時に変わり得るため、常に最新のrefresh tokenで上書きする
- 古いtokenをログ、レスポンス、PWA、localStorageへ出さない

## 6. PWA側に置いてよい情報 / 置いてはいけない情報

置いてよい情報:

- Workerの公開URL
- UI表示用の接続状態
- 最終同期日時
- インポート候補のプレビュー
- ユーザーが明示確認した後のRunOS活動データ

置いてはいけない情報:

- `STRAVA_CLIENT_SECRET`
- `refresh_token`
- `access_token`
- 認可コード
- token交換結果の生レスポンス
- Strava APIのAuthorization header

特に `refresh_token` を `localStorage` に保存しない。RunOS Legacy PWAの既存保存キー `meridian.v1` にもtoken類を混ぜない。

## 7. 必要scope

最初の実装候補:

- `activity:read`

理由:

- `/athlete/activities` の取得に必要
- 公開・フォロワー向けの活動取得から始められる
- 必要最小限の権限で開始できる

`activity:read_all` の扱い:

- 非公開、Only You、privacy zoneを含む活動まで取得したい場合にだけ使う
- 初期既定にはしない
- UIで「非公開活動も取り込む」など明示的な説明と同意を出してから要求する
- callback時に実際に許可されたscopeを確認し、不足している場合は理由を表示する

要求しないscope:

- `activity:write`
- `profile:write`
- その他、RunOSの読み取り同期に不要なscope

## 8. `/athlete/activities` 取得方針

WorkerからStrava APIへ次を呼ぶ。

```text
GET https://www.strava.com/api/v3/athlete/activities
```

使うquery:

- `after`
- `before`
- `page`
- `per_page`

方針:

- 最初はSummaryActivityだけを取得する
- streams、laps、zonesなど重い詳細取得はまだ行わない
- `after` を使い、直近期間から段階取得する
- `page` と `per_page` でページングする
- Stravaのrate limit headerをWorker側で読み、PWAへ要約して返す
- `429 Too Many Requests` は通常エラーとして扱い、再試行を急がせない
- Strava API失敗時もRunOS本体の既存データは変更しない

## 9. RunOS活動形式への変換方針

Strava SummaryActivityからRunOSのプレビュー形式へ変換する。

| Strava | RunOS候補 | 備考 |
|---|---|---|
| `id` | `externalId: "strava:<id>"` | まずプレビュー用。現行 `normalizeActivity()` は保持しないため将来拡張候補 |
| `start_date_local` | `date` | `YYYY-MM-DD` |
| `distance` | `km` | meter to km |
| `moving_time` | `durSec` | 秒 |
| `average_heartrate` | `hrAvg` | ある場合のみ |
| `max_heartrate` | `hrMax` | ある場合のみ |
| `total_elevation_gain` | `elevM` | ある場合のみ |
| `average_cadence` | `cadence` | ある場合のみ |
| `name` | `note` | ユーザー確認前に表示 |
| `type` / `sport_type` / `workout_type` | `type` | Run / TrailRun等だけを対象にする |

分類の初期方針:

- ランニング系のみimport候補にする
- `sport_type` が `Run` / `TrailRun` / `VirtualRun` 等なら対象
- 明確にRide等の非ラン活動はスキップ候補として表示する
- RunOS分類は最初は既存CSV取込に近く、距離・名称・workout情報から `easy` / `long` / `interval` / `race` などへ寄せる
- 分類が曖昧な場合はプレビュー画面で修正できる前提にする

## 10. duplicate判定方針

初期の安全側判定:

1. 将来 `externalId` を保存できるようになった場合は `strava:<id>` を最優先
2. 現行互換では `date + "|" + Math.round(km * 10)` を既存CSV取込に近いキーとして使う
3. 補助的に `durSec`、`start_date_local`、`name` を表示し、ユーザーが重複を判断できるようにする

注意:

- 現行 `meridian.v1` の活動形状にはStrava id用の安定フィールドがない
- そのため、最初から自動重複除外だけで確定インポートしない
- プレビューで「既存候補あり」と表示し、ユーザー確認後にだけインポートする

## 11. `meridian.v1` への書き込み方針

初期段階:

- Workerは `meridian.v1` を知らない
- PWA/HTMLもWorker結果を受けて即保存しない
- `/activities` はプレビュー用JSONだけを返す
- 取り込み候補、重複候補、スキップ理由を表示する

将来段階:

- ユーザーが明示的に「インポート」を押した場合のみRunOS活動へ変換する
- 保存前にバックアップ書き出し導線を出す
- `save()` の戻り値を確認し、失敗時は成功通知を出さない
- 破損リカバリ中は既存方針どおり保存をブロックする

## 12. Strava API利用上の注意

- Strava APIはOAuth2前提
- `client_secret` は共有禁止
- ユーザーは要求scopeの一部を拒否できるため、callback後にgrant済みscopeを必ず確認する
- access tokenは短命で、refresh tokenで更新する
- refresh tokenは更新時に変わる可能性があるため、Worker側で最新値を保存する
- 429応答とrate limit headerを扱う
- 新規Stravaアプリは利用可能なathlete数やrate limitに制約があるため、まず個人利用・低頻度同期で始める
- token、認可コード、Authorization headerをconsoleやレスポンスへ出さない
- Stravaの仕様変更に備え、WorkerでAPIレスポンスを正規化してからPWAへ渡す

## 13. WorkerモックAPI

作成場所:

```text
workers/runos-strava-worker
```

モックendpoint:

| endpoint | 概要 |
|---|---|
| `GET /health` | Workerの稼働状態と環境変数設定有無を返す |
| `GET /auth/start` | Strava認可URLの形を返す。まだredirectしない |
| `GET /auth/callback` | callback受信のモック結果を返す。token交換はしない |
| `GET /activities` | Strava SummaryActivity風のモックとRunOSプレビュー候補を返す |

モックの制約:

- Strava本接続はしない
- tokenを発行・保存しない
- `meridian.v1` へ書き込まない
- CORSは `RUNOS_LEGACY_PWA_ORIGIN` と `LOCAL_DEV_ORIGINS` のみ許可する
- その他のOriginからのブラウザアクセスは403にする

## 14. 次の小さな作業候補

1. WorkerモックをCloudflareへデプロイし、`/health` と `/activities` をHTTPSで確認する
2. RunOS Legacy PWAからWorker URLを手入力して `/activities` をプレビュー表示する最小UIを検討する
3. `meridian.v1` へ書く前のStravaインポート候補JSON fixtureをdocsに固定する
4. 本接続前にtoken storageをKVにするかD1にするか決める
5. Strava OAuth本接続の前に、state検証・CORS制限・ログ秘匿のテスト観点を作る
