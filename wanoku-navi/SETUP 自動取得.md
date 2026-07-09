# 釣果情報の自動取得 — 現行構成とセットアップ前提

## 現在のファイル構成

このディレクトリにある実行対象は次のHTMLです。

- `wanoku navi v27 yakou.html`

旧資料に記載されていた `wanoku_navi_v25_auto_intel.html` は存在しません。コード内の「v25 Relay」という表記は、リレー機能が追加された世代を示すコメントであり、現在使うHTMLのファイル名ではありません。

また、次のファイルも現在のリポジトリには含まれていません。

- `wanoku-relay.worker.js`
- `wrangler.toml`
- `src/index.js`

そのため、このリポジトリだけではCloudflare Workerを新規デプロイできません。以下は、別途入手・管理している互換Workerを接続する場合の前提と手順です。この文書はWorker本体を提供するものではありません。

## なぜWorkerが必要か

`file://` で開いたアプリからSNS、船宿、ブログ、YouTubeなどを直接取得すると、ブラウザのCORS制約で失敗することがあります。wanoku-naviは、サーバー側で取得してCORS付きで返す中継先としてCloudflare Worker等を利用できます。

現在のv27 HTMLは、設定したベースURLに対して次のエンドポイントを呼び出します。

| エンドポイント | 用途 |
|---|---|
| `POST /intel` | RSS等から釣果・環境情報を取得 |
| `POST /v1/messages` | 接続テストおよびAnthropic互換のAI呼び出し |

プロキシURLにはベースURL、例えば `https://wanoku-relay.<account>.workers.dev` を入力します。`/intel` と `/v1/messages` はアプリ側が用途に応じて付加するため、入力欄には付けません。

## 互換Workerに必要な前提

接続するWorkerは、少なくとも次を満たす必要があります。

- `POST /intel` を受け付ける。
- `/intel` のリクエスト本文 `{ feeds, target, area, useSearch }` を処理できる。
- `/intel` がJSONを返す。v27は主に `items`、`searchCatches`、`searchEnv`、`sources` を参照する。
- AI接続も使う場合は、`POST /v1/messages` がAnthropic Messages API互換の応答を返す。
- アプリを開くオリジンに対して必要なCORSヘッダーを返す。
- APIキーをブラウザへ返さず、Worker側のsecretとして保持する。

`file://` からのリクエストは通常のHTTPSサイトとオリジンの扱いが異なります。Worker側の許可オリジン設計と、実際に使うiPhone SafariまたはブラウザでのCORS確認が必要です。

## Workerを別途用意済みの場合の配置例

Workerコードを別途入手済みの場合は、一般的に次のような独立した作業フォルダで管理します。ファイル名はWorker側プロジェクトの設定に従ってください。

```text
wanoku-relay/
├─ wrangler.toml
└─ src/
   └─ index.js
```

`wrangler.toml` の `main` は、実在するWorkerソースを指定します。

```toml
name = "wanoku-relay"
main = "src/index.js"
compatibility_date = "YYYY-MM-DD"
```

デプロイには、そのWorkerプロジェクトが指定するNode.js、Wrangler、環境変数、secret設定を使用してください。旧資料の `ANTHROPIC_API_KEY` というsecret名は、Worker本体が存在しないため、このリポジトリでは正しい名前か検証できません。

## v27アプリ側の設定

1. `wanoku navi v27 yakou.html` を使用するブラウザで開く。
2. 設定タブの「オンライン接続」で、接続モードを「プロキシ経由」にする。
3. プロキシURLへWorkerのベースURLを入力する。
4. 「接続テスト」を実行する。
5. 「External Intelligence」の「フィードを管理」でRSS URLと出所名を登録する。
6. 「今すぐ自動取得」を実行し、取得件数またはエラー表示を確認する。
7. 必要な場合だけ「起動時＋定期の自動取得」をONにする。現在の実装では起動時と約3時間ごとに `/intel` を呼び出す。

登録例:

- YouTube: `https://www.youtube.com/feeds/videos.xml?channel_id=チャンネルID`
- WordPress: ブログURLの `/feed`
- その他: 配信元が公開しているRSS URL

「SNSはAI検索も併用」は、接続先Workerが検索付きAI呼び出しを実装し、必要なAPIキーをWorker側で安全に設定している場合だけ利用できます。

## 動作の流れ

```text
wanoku navi v27 yakou.html
   │ POST /intel
   ▼
互換Worker
   ├─ RSS等をサーバー側で取得
   ├─ 必要に応じて検索・AI処理
   └─ JSONとCORSヘッダーを返す
   ▼
wanoku-navi
   ├─ 釣果を出所付きシグナルへ反映
   ├─ 環境情報を公式・環境シグナルへ反映
   └─ 実釣ログ等と照合してソース信頼度を学習
```

気象庁の天気・警報取得には、アプリから直接取得する経路もあり、リレーWorkerとは別です。

## 接続確認

1. ブラウザの開発者ツールまたはSafariのWebインスペクタを開く。
2. 「接続テスト」で `/v1/messages` のHTTPステータスとCORSエラーを確認する。
3. 「今すぐ自動取得」で `/intel` が呼ばれることを確認する。
4. 応答がHTTP 200のJSONであることを確認する。
5. 取得後に釣果・環境件数が表示され、再読み込み後も設定と取得結果が残ることを確認する。

失敗時は、Worker URL、エンドポイント、CORS、Workerログ、secret名、レスポンスJSONの形を確認してください。Worker本体がこのリポジトリにないため、サーバー側の障害や仕様差はwanoku-naviだけでは修正できません。
