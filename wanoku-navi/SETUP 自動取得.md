# 釣果情報の自動取得 — セットアップ手順

`file://` のアプリからはSNS/船宿/ブログ/YouTubeを直接取得できません(ブラウザのCORS制約)。
そこで **Cloudflare Worker** を「中継役」に立て、サーバ側で取得してアプリへCORS付きで返します。

構成:
- `wanoku-relay.worker.js` … Cloudflare Worker(中継役)
- `wanoku_navi_v25_auto_intel.html` … リレー連携を組み込んだアプリ(Edgeで開く)

---

## 1. Worker をデプロイ(初回のみ・約10分)

前提: Node.js が入っていること。

```bash
npm i -g wrangler          # Cloudflare CLI
wrangler login             # ブラウザでCloudflareにログイン
```

作業フォルダを作り、ファイルを配置:

```
wanoku-relay/
├─ wrangler.toml
└─ src/
   └─ index.js   ← wanoku-relay.worker.js をこの名前で置く
```

`wrangler.toml`(最小):

```toml
name = "wanoku-relay"
main = "src/index.js"
compatibility_date = "2024-11-01"
```

(任意)SNSのAI検索を使う場合だけ、APIキーをsecretに登録:

```bash
wrangler secret put ANTHROPIC_API_KEY
# プロンプトに sk-ant-... を貼り付け
```

デプロイ:

```bash
wrangler deploy
# → https://wanoku-relay.<あなた>.workers.dev が表示される
```

動作確認(ブラウザで開く):
- `https://wanoku-relay.<あなた>.workers.dev/` → `{"ok":true,...}` が返ればOK
- `.../intel?feeds=https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxx&target=シーバス` → items が返る

---

## 2. アプリ側の設定(Edge)

1. `wanoku_navi_v25_auto_intel.html` を Edge で開く。
2. 設定タブ → 「オンライン接続」→ 接続モードを **プロキシ経由** にし、
   `https://wanoku-relay.<あなた>.workers.dev` を貼り付け(末尾 `/v1/messages` は自動付加)。
3. 設定タブ → **External Intelligence** カード →「フィードを管理」で
   船宿/ブログ/YouTubeのRSSを登録(出所名を付けると信頼度学習の単位になります)。
   - YouTube: `https://www.youtube.com/feeds/videos.xml?channel_id=チャンネルID`
   - Ameba/WordPress: ブログURL + `/rss` または `/feed`
4. 「今すぐ自動取得」で取得 → 予測に反映。
   「起動時＋定期の自動取得」をONにすると、開くたび＋約3時間ごとに自動で取得します。
5. (任意)WorkerにAPIキーを設定済みなら「SNSはAI検索も併用」をONで、X/fimo等もLLM＋検索で拾います。

---

## 動作の流れ

```
アプリ(Edge, file://)
   │  POST /intel  { feeds:[…], target, useSearch }
   ▼
Cloudflare Worker（実オリジン＝CORS制約なし）
   ├─ 各RSSをサーバ側fetch → 釣果/環境の候補を抽出
   ├─（任意）Anthropic API を web_search 付きで実行（SNS/広域）
   ▼  JSON + CORS許可ヘッダ
アプリ
   ├─ 釣果 → 出所付きシグナル → スコアへ反映
   ├─ 環境 → 青潮/濁り/波浪等のタグ → スコアへ反映
   └─ 実釣ログ・他ソースと突合 → 各ソースの信頼度を自律学習
```

- Worker は `/v1/messages` も中継するため、アプリ既存のAI呼び出し(Web検索含む)も
  このWorker経由で有効になります。
- 費用: Cloudflare Workers 無料枠(1日10万リクエスト)で十分。AI検索を使う分だけAnthropic APIの従量課金。

## 自動化できる範囲(正直な整理)

| ソース | 自動取得 | 方法 |
|---|---|---|
| 船宿・個人ブログ | ◎ | RSS(Ameba/WordPress) |
| YouTubeチャンネル | ◎ | チャンネルRSS |
| 気象庁(天気/警報) | ◎ | アプリが直接fetch(Worker不要) |
| 水質/河川/施設(RSS有) | ○ | RSS |
| X / Instagram / fimo | △ | 公開APIなし。Worker側のLLM＋検索で拾う(取りこぼしあり) |

SNS本体の完全自動は仕様上むずかしく、RSS系＋AI検索の併用が現実解です。
