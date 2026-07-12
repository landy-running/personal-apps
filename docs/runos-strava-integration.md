# RunOS Strava連携 設計メモ

最終確認日: 2026-07-10  
対象: RunOS Legacy PWA / Cloudflare Worker / Strava API

この文書は、RunOS Legacy PWAからStrava活動を安全に取得し、ユーザーが選択した活動だけを手動インポートするための設計メモです。現時点では自動同期、大量詳細データ取得、バックグラウンド取り込みは行いません。`activity:read_all` は既定では要求せず、ユーザーが非公開活動取得を明示した再認証時だけ要求します。

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
   - 既定は `approval_prompt=auto`
   - 既定scopeは `activity:read,read`
   - 非公開活動取得を明示した場合だけ `approval_prompt=force` と `scope=activity:read_all,read`
   - CSRF対策用 `state`
3. ユーザーがStravaで認可する
4. StravaがWorkerの `/auth/callback` へ戻す
5. Workerが `state` を検証する
6. Workerが認可コードをStravaのtoken endpointへ送り、`access_token` と `refresh_token` を取得する
7. Workerがtokenをサーバー側ストレージへ保存する
8. PWAはWorkerの `/activities` を呼び、Strava活動のプレビューを取得する
9. PWAはプレビューを表示し、ユーザーが確認したものだけRunOSへインポートする

現時点のWorkerでは、5〜7をCloudflare Worker内で実行し、tokenはCloudflare KVへ保存する。PWA/HTMLへ `access_token` や `refresh_token` は返さない。

## 4. Workerに置くsecret / 環境変数

Cloudflare Worker側で扱う環境変数:

| 名前 | 種別 | 用途 | PWA配布物へ含める可否 |
|---|---|---|---|
| `STRAVA_CLIENT_ID` | 環境変数 | Stravaアプリのclient id | 原則Worker側で管理。公開情報だがPWAは知らなくてよい |
| `STRAVA_CLIENT_SECRET` | secret | token交換・refreshに使うsecret | 禁止 |
| `STRAVA_REDIRECT_URI` | 環境変数 | Stravaから戻るWorker callback URL | PWAに置く必要なし |
| `TOKEN_STORAGE` | 環境変数 | token保存方式。現在は `kv` | PWAに置く必要なし |
| `RUNOS_LEGACY_PWA_ORIGIN` | 環境変数 | CORSで許可するRunOS Legacy PWA公開URL | PWAに置く必要なし |
| `LOCAL_DEV_ORIGINS` | 環境変数 | CORSで許可するlocalhost開発URL | PWAに置く必要なし |
| `STRAVA_TOKEN_KV` | KV binding | tokenとOAuth stateを保存するCloudflare KV | PWAに置く必要なし |

`STRAVA_CLIENT_SECRET` は `wrangler.toml` やソースコードへ書かず、Cloudflare Dashboardまたは `wrangler secret put STRAVA_CLIENT_SECRET` で設定する。

## 5. TOKEN_STORAGE 方針

現在の最小実装:

- 個人利用・単一ユーザーならCloudflare KVで開始可能
- `TOKEN_STORAGE=kv`
- KV binding名は `STRAVA_TOKEN_KV`
- token保存キーはWorker内部の固定キーで、個人利用の単一接続を前提にする
- 保存するのはWorker側のみ
  - athlete id
  - granted scopes
  - latest refresh token
  - latest access token
  - expires_at
  - updated_at
- OAuth `state` も短いTTL付きでKVに保存する
- Stravaのrefresh tokenは更新時に変わり得るため、常に最新のrefresh tokenで上書きする
- 古いtokenをログ、レスポンス、PWA、localStorageへ出さない
- 複数ユーザーやtoken更新履歴を厳密に扱うならD1を検討する

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

既定の実装:

- `activity:read,read`

理由:

- `/athlete/activities` の取得に必要
- 公開・フォロワー向けの活動取得から始められる
- 必要最小限の権限で開始できる

`activity:read_all` の扱い:

- 非公開、Only You、privacy zoneを含む活動まで取得したい場合にだけ使う
- 初期既定にはしない
- UIで「非公開活動も取得するため再接続」を押した場合だけ `include_private=1` 付きで `/auth/start` を開く
- Workerは `include_private=1` または `scope=activity:read_all` を受けた場合だけ `activity:read_all,read` を要求する
- scope追加時は `approval_prompt=force` を使い、Strava側で再同意しやすくする
- callback時に実際に許可されたscopeを確認し、不足している場合は理由を表示する
- `access_token` / `refresh_token` は引き続きWorker側KVにのみ保存し、PWA/HTML/localStorageへ返さない

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
- `perPage`（RunOS側互換エイリアス。Worker内では `per_page` に正規化する）

方針:

- 最初はSummaryActivityだけを取得する
- streams、laps、zonesなど重い詳細取得はまだ行わない
- `after` を使い、直近期間から段階取得する
- `page` と `per_page` でページングする
- 既定は `page=1`、`per_page=30`
- `per_page` はWorker側で安全な上限までclampする
- Workerレスポンスには `page`、`perPage`、`returnedCount`、`hasMore` 相当を含める
- `hasMore` は「さらに取得できる可能性」を示す補助値であり、最終ページ確定は次ページ取得結果でも確認する
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

### 実際に保存するStrava由来フィールド

手動インポートで `DB.activities` へ追加する活動は、既存の `normalizeActivity()` を通した最小活動形に、Strava由来識別情報を付け足す。

既存活動と共通する主なフィールド:

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

Strava由来として追加するフィールド:

- `externalId`: `strava:<id>`
- `sourceId`: Stravaの生ID文字列
- `stravaActivityId`: Stravaの生ID文字列
- `sourceName`: `Strava API`
- `startDateLocal`: Strava `start_date_local`
- `startUnix`: Strava `start_date` を優先してUnix秒へ変換した値。なければ `start_date_local` から補完
- `elapsedSec`: Strava `elapsed_time` がある場合のみ
- `importedAt`: インポート実行時刻

互換性メモ:

- 既存画面・集計は主に `date`、`type`、`km`、`durSec`、`hrAvg`、`elevM` を参照するため、Strava由来活動も手入力/CSV由来活動と同じ最小形で扱う
- `startUnix` はFIT由来活動と同じく、最新活動・回復時間系の判定で利用され得る
- laps / streams / route / bests はStrava SummaryActivity段階では保存しないため、詳細ストリーム前提の分析では手入力/CSV相当の扱いになる

## 10. duplicate判定方針

初期の安全側判定:

1. 将来 `externalId` を保存できるようになった場合は `strava:<id>` を最優先
2. 現行互換では `date + "|" + Math.round(km * 10)` を既存CSV取込に近いキーとして使う
3. 補助的に `durSec`、`start_date_local`、`name` を表示し、ユーザーが重複を判断できるようにする

注意:

- 既存の古い活動にはStrava id用の安定フィールドがない
- 新しくStrava APIから取り込む活動には `externalId` 等を付与する
- そのため、最初から自動重複除外だけで確定インポートしない
- プレビューで「既存候補あり」と表示し、ユーザー確認後にだけインポートする

## 11. RunOS側UIと `meridian.v1` への書き込み方針

現在の実装:

- Workerは `meridian.v1` を知らない
- RunOS HTMLは `/activities` のpreviewを表示し、ユーザーが選択した活動だけを取り込む
- RunOS側UIはWorker URL設定、接続開始、接続確認、活動取得、選択チェックボックス、手動インポートを提供する
- Worker URLは `runos.stravaWorkerUrl.v1` という別localStorageキーに保存し、`meridian.v1` には保存しない
- 接続確認結果では現在のscopeと `activity:read_all` の有無を表示する
- `activity:read_all` がない場合は「Only You活動は表示されない可能性があります」と表示する
- 「非公開活動も取得するため再接続」ボタンは `/auth/start?include_private=1` を新規タブで開く
- 初回の「活動取得」は `page=1&per_page=30` を取得する
- 「さらに読み込む」は次ページを取得し、既存一覧へ追記する
- 取得済み一覧はStravaの `externalId`、または日付・距離・時間・名前のfallbackキーで重複追加しない
- `returnedCount=0` または `hasMore=false` の場合は、これ以上読み込めない状態として表示する
- 取得結果に大きな日付ギャップがある場合は、scope不足で非公開活動が抜けている可能性を診断表示する
- 画面には表示件数、取込可能件数、選択件数、exact duplicate件数、近似duplicate件数、取り込み済み件数を表示する
- 一括操作として「表示中の取込可能をすべて選択」「重複候補を除いて選択」「選択解除」を提供する
- importable=false の活動は選択不可
- exact duplicateは常に選択不可
- 重複候補は「重複の可能性あり」と表示し、初期状態では選択しない
- 近似duplicateは初期状態では選択しないが、ユーザーが明示的にチェックした場合はインポート対象にできる
- exact duplicate（`externalId` / `sourceId` / `stravaActivityId` が一致）は取り込み済みとして扱い、再取り込みしない
- 過去実装との差異を吸収するため、`sourceId` が `strava:<id>` 形式でも生ID形式でもexact duplicateとして扱う
- インポート用 `id` が一致する場合もexact duplicateとして扱う
- 近似duplicateは日付または開始時刻、距離差2%以内、時間差2%以内で判定する
- インポート前にJSONバックアップ書き出し導線と確認ダイアログを出す
- 選択された活動だけを `DB.activities` へ追加し、保存は既存 `save()` 経由で行う
- `save()` がfalseの場合は成功通知を出さず、メモリ上の追加もロールバックする
- 取り込む活動には `source: "strava_api"`、`externalId: "strava:<id>"`、`sourceId`、`stravaActivityId`、`sourceName`、`startDateLocal`、`importedAt` を付け、Strava由来と分かるようにする
- `refresh_token` / `access_token` / `client_secret` はRunOS HTMLやlocalStorageへ保存しない

既知の制限:

- Strava SummaryActivityのみを使うため、ラップ、ストリーム、GPSルート、best effortsの詳細は取り込まない
- `durSec` は `moving_time` ベース、`elapsedSec` は参考値として保持する
- `date` は `start_date_local` の日付部分を使う。週間集計、今日判定、月間カレンダーは既存RunOSのローカル日付処理に従う
- 種別分類はWorker側の簡易分類とRunOS既存分類ロジックの範囲に限られる。インターバル詳細はstreams未取得のため精密検出しない

検証項目:

- Today / Log / Fitness / Insights / Season / Libraryで `NaN`、`undefined`、不自然な空表示が出ないこと
- Log一覧と活動詳細で距離、時間、ペース、心拍、標高が表示可能なこと
- Fitness / Insights のTRIMP、CTL、ATL、TSB、ACWRが保存後に計算できること
- `startDateLocal` と `date` がStrava上のローカル日付と一致すること
- `startUnix` がある活動は回復時間・最新活動判定で極端に未来/過去へ飛ばないこと
- exact duplicate、`externalId`、`sourceId`、`stravaActivityId`、インポート用 `id` の一致で再取り込みされないこと
- ページングで同じ活動が再取得されても一覧へ重複追加されないこと
- `save()` 成功時のみ成功通知を出し、失敗時はメモリ上の追加をロールバックすること
- 破損データリカバリ中はインポート不可であること

将来段階:

- `activity:read_all` を使う場合は、非公開活動を含むことをUIで明示してから要求する
- 自動同期を行う場合も、初回はプレビューとバックアップ導線を維持する
- `externalId` を使った重複判定を維持し、Strava活動の再取り込みを防ぐ

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

## 13. Worker API

作成場所:

```text
workers/runos-strava-worker
```

endpoint:

| endpoint | 概要 |
|---|---|
| `GET /health` | Workerの稼働状態、環境変数設定有無、保存済みscope、`hasActivityReadAll` を返す |
| `GET /auth/start` | Strava認可URLへredirectする。既定scopeは `activity:read,read`。`include_private=1` または `scope=activity:read_all` の場合だけ `activity:read_all,read` を要求する |
| `GET /auth/callback` | codeをtoken endpointで交換し、tokenをKVへ保存する |
| `GET /athlete` | 接続中アスリート情報、保存済みscope、`hasActivityReadAll` を返す。tokenは返さない |
| `GET /activities` | Strava `/athlete/activities` とRunOSプレビュー候補を返す。`page`、`per_page` / `perPage` を受け付け、`page`、`perPage`、`returnedCount`、`hasMore` を返す |

現在の制約:

- `activity:read_all` は明示再認証時だけ要求し、既定では要求しない
- RunOS側は自動同期しない
- 選択された活動以外は保存しない
- `meridian.v1` へ直接localStorage書き込みせず、既存 `save()` 経由に限定する
- CORSは `RUNOS_LEGACY_PWA_ORIGIN` と `LOCAL_DEV_ORIGINS` のみ許可する
- その他のOriginからのブラウザアクセスは403にする

## 14. 次の小さな作業候補

1. KV namespace IDを `wrangler.toml` に設定し、WorkerをCloudflareへデプロイする
2. `/auth/start` からStrava認可し、callback後に `/athlete` と `/activities` を確認する
3. Strava取り込み済み活動を含む `meridian.v1` fixtureを作り、重複判定の代表ケースをdocsに固定する
4. インポート後の手動編集・削除・再取得時の表示確認を追加する
5. `activity:read_all` 再認証後に、2026-05-30〜2024-12-19 のような欠落期間が埋まるか実機で確認する
