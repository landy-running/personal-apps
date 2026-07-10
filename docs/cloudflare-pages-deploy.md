# Cloudflare Pages 初回デプロイ手順

最終確認日: 2026-07-10  
対象: RunOS PWA / wanoku-navi PWA

この文書は、現在のmonorepo構成からCloudflare Pagesへ初回デプロイするための手順メモです。legacy HTML、実データキー、IndexedDB、外部API、Cloudflare Workerには接続しません。

## 1. 前提

- PWAソース:
  - `apps/runos-pwa`
  - `apps/wanoku-pwa`
- 共通・core:
  - `packages/runos-core`
  - `packages/wanoku-core`
  - `packages/storage`
- build output:
  - RunOS: `dist/runos-pwa`
  - wanoku-navi: `dist/wanoku-pwa`
- 現在のbuild scripts:
  - `npm run build:runos`
  - `npm run build:wanoku`
  - `npm run build`

APIキーやsecretはクライアント配布物へ埋め込みません。wanoku-naviのAI/外部情報連携が必要になった場合も、Cloudflare Worker等の管理されたバックエンド側へ分離してから扱います。Worker本体はこの段階では実装しません。

## 2. 推奨案

初回デプロイは、RunOS PWAとwanoku-navi PWAを2つのCloudflare Pagesプロジェクトに分ける案を推奨します。

理由:

- アプリごとにoriginが分かれ、localStorageとService Worker scopeを分離しやすい
- iPhoneホーム画面追加時に、アプリ名・アイコン・起動URLを個別確認しやすい
- 将来wanoku-naviだけWorker/API連携を進める場合に、設定と権限を分けやすい
- RunOSのランニングデータとwanoku-naviの釣行データを同一originに置かない方が安全

## 3. 2つのPagesプロジェクトに分ける案

### RunOS PWA

設定例:

| 項目 | 値 |
|---|---|
| Project name | `runos-pwa` |
| Root directory | repository root |
| Build command | `npm run build:runos` |
| Build output directory | `dist/runos-pwa` |
| Environment variables | `NODE_VERSION=20` |

Cloudflare側で依存解決がうまく走らない場合だけ、Build commandを次に変更します。

```bash
npm ci && npm run build:runos
```

### wanoku-navi PWA

設定例:

| 項目 | 値 |
|---|---|
| Project name | `wanoku-pwa` |
| Root directory | repository root |
| Build command | `npm run build:wanoku` |
| Build output directory | `dist/wanoku-pwa` |
| Environment variables | `NODE_VERSION=20` |

Cloudflare側で依存解決がうまく走らない場合だけ、Build commandを次に変更します。

```bash
npm ci && npm run build:wanoku
```

注意:

- 環境変数にAPIキーやsecretを入れても、Viteでクライアントへ露出する設定にしない
- `VITE_` 接頭辞の環境変数はブラウザ配布物へ含まれ得るため、secretには使わない
- 現時点ではCloudflare Workerを接続しない

## 4. 1つのPagesプロジェクトで2アプリを配信する案

設定例:

| 項目 | 値 |
|---|---|
| Project name | `personal-apps-pwa` |
| Root directory | repository root |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Environment variables | `NODE_VERSION=20` |

想定URL:

- `/runos-pwa/`
- `/wanoku-pwa/`

利点:

- Pagesプロジェクトが1つで済む
- 1回のbuildで両方を配信できる
- docsや検証用の一時公開には扱いやすい

注意点:

- 同一originになるため、localStorage、Cookie、Cache Storageの安全境界が弱くなる
- 現在は `dist/` 直下にroot用 `index.html` がないため、トップページやリダイレクトを別途用意する必要がある
- iPhoneホーム画面追加時に、URL、manifest、Service Worker scopeの確認がやや複雑になる
- 将来wanoku-naviだけWorker/API設定を追加する場合、RunOSと設定が混ざりやすい

## 5. 案の比較

| 観点 | 2プロジェクト | 1プロジェクト |
|---|---|---|
| localStorage分離 | 強い | 同一originで共有 |
| Service Worker scope | 単純 | サブディレクトリscope管理が必要 |
| iPhoneホーム画面確認 | 単純 | URLごとに注意が必要 |
| 運用数 | 2つ | 1つ |
| 将来のWorker/API連携 | アプリ別に分けやすい | 設定が混ざりやすい |
| 初回検証の手軽さ | やや手間 | 手軽 |

結論: 本番に近い初回検証は2プロジェクト推奨。一時的な共有プレビューだけなら1プロジェクトも可。

## 6. デプロイ前ローカル確認

```bash
npm install
npm test
npm run build
```

個別確認:

```bash
npm run build:runos
npm run preview:runos
```

```bash
npm run build:wanoku
npm run preview:wanoku
```

Chrome / Edge DevToolsのApplicationタブで、manifest、Service Worker、demo localStorageキーだけを確認します。

## 7. Cloudflare Pages上での確認

デプロイ後に確認する項目:

- HTTPS URLでアプリが表示される
- manifestが読み込まれる
- `display: standalone`、`start_url`、`scope` が期待どおり
- `sw.js` が登録される
- Service Worker状態が画面に表示される
- 保存デモがdemoキーだけを使う
- 破損JSON注入で `<key>.corrupt.<timestamp>` が表示される
- RunOSのペース計算デモが動く
- wanoku-naviの風向差デモが動く
- consoleに保存サイズログとService Worker登録ログが出る

## 8. iPhoneホーム画面追加後の確認

RunOSとwanoku-naviをそれぞれ個別に確認します。

- SafariでHTTPS URLを開ける
- 共有メニューからホーム画面へ追加できる
- ホーム画面アイコンからstandalone風に起動する
- 起動URLが意図したPWAを指す
- Service Worker状態表示が成功または状況を示す
- safe areaとホームインジケーターにUIが重ならない
- 入力欄をタップしても画面が崩れない
- demo保存後、アプリ再起動で読込確認できる
- 破損JSON注入後、破損退避表示が出る
- オフラインまたは機内モード時に最低限のアプリシェルが表示される

注意:

- iPhone SafariのlocalStorageやCache StorageはOS都合で削除され得る
- ホーム画面追加時と通常Safariタブで保存領域や表示挙動が異なる可能性がある
- 正式アイコンは未作成で、現在はSVGプレースホルダー
- 実データ接続前にバックアップ導線を再確認する

## 9. まだ行わないこと

- legacy HTMLの削除や置換
- RunOSの `meridian.v1` へのPWA接続
- wanoku-naviの既存Storeキー群へのPWA接続
- IndexedDB実装
- Cloudflare Worker実装
- 外部API接続
- APIキーやsecretのクライアント埋め込み
- 正式アイコン作成
